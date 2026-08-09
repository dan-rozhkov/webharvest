import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createFetcher, DomainHints } from '../../src/core/fetcher.js';
import { DomainQueue } from '../../src/core/politeness.js';
import type { BrowserPool } from '../../src/core/browser.js';

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function serve(handler: (url: string) => { status?: number; type?: string; body: string }): Promise<string> {
  server = createServer((req, res) => {
    const { status = 200, type = 'text/html', body } = handler(req.url ?? '/');
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

function fakeBrowser(html: string): BrowserPool & { calls: number; lastUrl?: string } {
  const pool = {
    calls: 0,
    lastUrl: undefined as string | undefined,
    async render(url: string) {
      pool.calls++;
      pool.lastUrl = url;
      return { html, finalUrl: url, status: 200 };
    },
    async shutdown() {},
    isRunning: () => false,
  };
  return pool as BrowserPool & { calls: number; lastUrl?: string };
}

const deps = (browser: BrowserPool, hints = new DomainHints()) => ({
  queue: new DomainQueue({ minIntervalMs: 0 }),
  browser,
  hints,
  allowPrivate: true,
});

const article = '<html><body><article><h1>Заголовок</h1><p>' + 'текст '.repeat(200) + '</p></article></body></html>';

describe('createFetcher', () => {
  it('берёт обычную страницу по HTTP и не трогает браузер', async () => {
    const base = await serve(() => ({ body: article }));
    const browser = fakeBrowser('<html><body>из браузера</body></html>');
    const f = createFetcher(deps(browser));
    const r = await f.fetch(base + '/');
    expect(r.via).toBe('http');
    expect(browser.calls).toBe(0);
  });

  it('эскалирует SPA в браузер', async () => {
    const base = await serve(() => ({
      body: '<html><body><div id="root"></div><script>' + 'x'.repeat(10_000) + '</script></body></html>',
    }));
    const browser = fakeBrowser(article);
    const f = createFetcher(deps(browser));
    const r = await f.fetch(base + '/');
    expect(r.via).toBe('browser');
    expect(browser.calls).toBe(1);
  });

  it('запоминает домен и второй раз идёт в браузер сразу', async () => {
    let httpHits = 0;
    const base = await serve(() => {
      httpHits++;
      return { body: '<html><body><div id="root"></div><script>' + 'x'.repeat(10_000) + '</script></body></html>' };
    });
    const browser = fakeBrowser(article);
    const hints = new DomainHints();
    const f = createFetcher(deps(browser, hints));
    await f.fetch(base + '/a');
    await f.fetch(base + '/b');
    expect(httpHits).toBe(1);
    expect(browser.calls).toBe(2);
  });

  it('бросает blocked, если челлендж пережил браузер', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    const base = await serve(() => ({ status: 403, body: challenge }));
    const f = createFetcher(deps(fakeBrowser(challenge)));
    await expect(f.fetch(base + '/')).rejects.toMatchObject({ code: 'blocked', detail: { by: 'cloudflare' } });
  });

  it('отдаёт результат браузера, если тот прошёл челлендж', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    const base = await serve(() => ({ status: 403, body: challenge }));
    const f = createFetcher(deps(fakeBrowser(article)));
    const r = await f.fetch(base + '/');
    expect(r.via).toBe('browser');
    expect(r.html).toContain('Заголовок');
  });

  it('падает в blocked по исходному challenge, если браузер стёр его маркеры, но текста всё ещё нет', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    const base = await serve(() => ({ status: 403, body: challenge }));
    // Ни маркеров защиты, ни текста, ни скриптов — detectChallenge на этом
    // не сработает, но контента для извлечения тоже нет: если бы не
    // context.challenge, это ушло бы как not_html вместо честного blocked.
    const stillEmpty = '<html><body><div id="root"></div></body></html>';
    const f = createFetcher(deps(fakeBrowser(stillEmpty)));
    await expect(f.fetch(base + '/')).rejects.toMatchObject({ code: 'blocked', detail: { by: 'cloudflare' } });
  });

  it('бросает not_html, если браузер отрендерил, но текста так и не появилось (без challenge)', async () => {
    const base = await serve(() => ({
      body: '<html><body><div id="root"></div><script>' + 'x'.repeat(10_000) + '</script></body></html>',
    }));
    const stillEmpty = '<html><body><div id="root"></div></body></html>';
    const browser = fakeBrowser(stillEmpty);
    const f = createFetcher(deps(browser));
    await expect(f.fetch(base + '/')).rejects.toMatchObject({ code: 'not_html' });
    expect(browser.calls).toBe(1);
  });

  it('бросает not_html и не зовёт браузер на нетекстовом content-type (pdf)', async () => {
    const bin = '%PDF-1.4 бинарь';
    const base = await serve(() => ({ type: 'application/pdf', body: bin }));
    const browser = fakeBrowser(bin);
    const f = createFetcher(deps(browser));
    await expect(f.fetch(base + '/x.pdf')).rejects.toMatchObject({ code: 'not_html' });
    expect(browser.calls).toBe(0);
  });

  it('репортит blocked, а не not_html, если челлендж отдан под нетекстовым content-type', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    const base = await serve(() => ({ type: 'application/json', body: challenge }));
    const browser = fakeBrowser(article);
    const f = createFetcher(deps(browser));
    await expect(f.fetch(base + '/api')).rejects.toMatchObject({ code: 'blocked', detail: { by: 'cloudflare' } });
    expect(browser.calls).toBe(0);
  });

  it('отклоняет приватные адреса до всякой сети', async () => {
    const browser = fakeBrowser(article);
    const f = createFetcher({ ...deps(browser), allowPrivate: false });
    await expect(f.fetch('http://169.254.169.254/latest/meta-data/'))
      .rejects.toMatchObject({ code: 'invalid_url' });
    expect(browser.calls).toBe(0);
  });

  it('бросает too_large на слишком большом теле', async () => {
    const base = await serve(() => ({ body: 'a'.repeat(200_000) }));
    const f = createFetcher({ ...deps(fakeBrowser(article)), maxBytes: 50_000 });
    await expect(f.fetch(base + '/')).rejects.toMatchObject({ code: 'too_large' });
  });

  it('бросает timeout, когда сервер молчит', async () => {
    server = createServer(() => {});
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    const f = createFetcher({ ...deps(fakeBrowser(article)), httpTimeoutMs: 400 });
    await expect(f.fetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('следует за обычным редиректом на HTTP-уровне', async () => {
    server = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/target' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(article);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const browser = fakeBrowser(article);
    const f = createFetcher(deps(browser));
    const r = await f.fetch(base + '/start');
    expect(r.via).toBe('http');
    expect(r.finalUrl).toBe(base + '/target');
  });

  it('помечает hint на хосте, чей контент вызвал эскалацию, и рендерит именно его finalUrl', async () => {
    let port = 0;
    const spaShell = '<html><body><div id="root"></div><script>' + 'x'.repeat(10_000) + '</script></body></html>';
    server = createServer((req, res) => {
      if (req.url === '/from-a') {
        res.writeHead(302, { location: `http://localhost:${port}/spa` });
        res.end();
        return;
      }
      if (req.url === '/spa') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(spaShell);
        return;
      }
      // Прямой запрос к A (без редиректа на SPA) — обычная серверная страница.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(article);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    port = (server!.address() as { port: number }).port;

    const browser = fakeBrowser(article);
    const hints = new DomainHints();
    const f = createFetcher({ queue: new DomainQueue({ minIntervalMs: 0 }), browser, hints, allowPrivate: true });

    const r1 = await f.fetch(`http://127.0.0.1:${port}/from-a`);
    expect(r1.via).toBe('browser');
    // Браузеру отдан адрес ПОСЛЕ HTTP-редиректа, а не исходный /from-a.
    expect(browser.lastUrl).toBe(`http://localhost:${port}/spa`);
    // Hint висит на хосте, чей контент реально был SPA-оболочкой (localhost),
    // а не на исходном хосте редиректора (127.0.0.1).
    expect(hints.needsBrowser('localhost')).toBe(true);
    expect(hints.needsBrowser('127.0.0.1')).toBe(false);

    // Прямой (без редиректа) запрос к A по-прежнему идёт по дешёвому HTTP-пути.
    const r2 = await f.fetch(`http://127.0.0.1:${port}/direct`);
    expect(r2.via).toBe('http');
  });

  it('не пишет hint, если браузер не спас контент — не жжёт рендер впустую на каждый запрос', async () => {
    let httpHits = 0;
    const base = await serve(() => {
      httpHits++;
      return { body: '<html><body><div id="root"></div><script>' + 'x'.repeat(10_000) + '</script></body></html>' };
    });
    const stillEmpty = '<html><body><div id="root"></div></body></html>';
    const browser = fakeBrowser(stillEmpty);
    const hints = new DomainHints();
    const f = createFetcher(deps(browser, hints));

    await expect(f.fetch(base + '/a')).rejects.toMatchObject({ code: 'not_html' });
    expect(hints.needsBrowser('127.0.0.1')).toBe(false);

    await f.fetch(base + '/b').catch(() => {});
    // Второй запрос снова пробует дешёвый HTTP-путь, а не идёт в браузер
    // напрямую по (не записанному) hint-у.
    expect(httpHits).toBe(2);
  });

  it('на браузерном пути тоже проверяет SSRF, когда allowPrivate не установлен', async () => {
    // httpGet тут не участвует вовсе (используется hint, чтобы сразу пойти в
    // браузер) — значит проверка идёт полностью без сети: ни DNS, ни сокетов.
    // Публичный литерал IP на входе проходит validate() синхронно (без DNS),
    // а рендер сообщает finalUrl на приватный адрес, который обязан быть
    // отклонён тем же validate(), что и обычные HTTP-редиректы.
    const hints = new DomainHints();
    hints.markNeedsBrowser('93.184.216.34');
    const browser = {
      calls: 0,
      async render(url: string) {
        browser.calls++;
        return { html: article, finalUrl: 'http://169.254.169.254/evil', status: 200 };
      },
      async shutdown() {},
      isRunning: () => false,
    };
    const f = createFetcher({ queue: new DomainQueue({ minIntervalMs: 0 }), browser, hints });
    await expect(f.fetch('http://93.184.216.34/start')).rejects.toMatchObject({ code: 'invalid_url' });
    expect(browser.calls).toBe(1);
  });

  it('ставит каждый хоп редиректа в очередь его собственного хоста', async () => {
    let port = 0;
    server = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://localhost:${port}/target` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(article);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    port = (server!.address() as { port: number }).port;

    const calls: string[] = [];
    const queue = { run: async (host: string, fn: () => Promise<unknown>) => { calls.push(host); return fn(); } };
    const browser = fakeBrowser(article);
    const f = createFetcher({ queue: queue as unknown as DomainQueue, browser, hints: new DomainHints(), allowPrivate: true });

    const r = await f.fetch(`http://127.0.0.1:${port}/start`);
    expect(r.finalUrl).toBe(`http://localhost:${port}/target`);
    // Оба хоста должны получить свой слот очереди — редиректор (127.0.0.1)
    // не может провезти запрос к target-хосту (localhost) мимо его политеса.
    expect(calls).toEqual(['127.0.0.1', 'localhost']);
  });

  it('не ставит повторный слот очереди для хопа на тот же хост', async () => {
    let port = 0;
    server = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/mid` });
        res.end();
        return;
      }
      if (req.url === '/mid') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/target` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(article);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    port = (server!.address() as { port: number }).port;

    const calls: string[] = [];
    const queue = { run: async (host: string, fn: () => Promise<unknown>) => { calls.push(host); return fn(); } };
    const browser = fakeBrowser(article);
    const f = createFetcher({ queue: queue as unknown as DomainQueue, browser, hints: new DomainHints(), allowPrivate: true });

    await f.fetch(`http://127.0.0.1:${port}/start`);
    // Три хопа, один и тот же хост — очередь занята один раз, не три:
    // повторный queue.run того же хоста, который уже держит слот выше по
    // цепочке, рискует самозаклиниванием (см. следующий тест).
    expect(calls).toEqual(['127.0.0.1']);
  });

  it(
    'не виснет на цепочке редиректов a→b→a при maxConcurrent:1 для этого хоста',
    async () => {
      let port = 0;
      server = createServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, { location: `http://localhost:${port}/mid` });
          res.end();
          return;
        }
        if (req.url === '/mid') {
          res.writeHead(302, { location: `http://127.0.0.1:${port}/target` });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(article);
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      port = (server!.address() as { port: number }).port;

      const browser = fakeBrowser(article);
      // maxConcurrent: 1 — если третий хоп (снова 127.0.0.1) попытался бы
      // повторно захватить слот 127.0.0.1 через вложенный queue.run, то
      // ждал бы освобождения слота, который держит внешний вызов этого же
      // fetch() — а тот не освободится, пока не завершится сам этот хоп.
      // Классическое самозаклинивание. heldHosts должен его исключить.
      const queue = new DomainQueue({ maxConcurrent: 1, minIntervalMs: 0 });
      const f = createFetcher({ queue, browser, hints: new DomainHints(), allowPrivate: true });

      const r = await f.fetch(`http://127.0.0.1:${port}/start`);
      expect(r.via).toBe('http');
      expect(r.finalUrl).toBe(`http://127.0.0.1:${port}/target`);
    },
    3000,
  );

  it('не зовёт браузер ради application/json — эскалация тут бесполезна', async () => {
    const base = await serve(() => ({ type: 'application/json', body: '{"a":1}' }));
    const browser = fakeBrowser(article);
    const f = createFetcher(deps(browser));
    await expect(f.fetch(base + '/api')).rejects.toMatchObject({ code: 'not_html' });
    expect(browser.calls).toBe(0);
  });
});

describe('DomainHints', () => {
  it('забывает подсказку по истечении TTL', () => {
    vi.useFakeTimers();
    const h = new DomainHints(1000);
    h.markNeedsBrowser('a.com');
    expect(h.needsBrowser('a.com')).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(h.needsBrowser('a.com')).toBe(false);
    vi.useRealTimers();
  });
});
