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

function fakeBrowser(html: string): BrowserPool & { calls: number } {
  const pool = {
    calls: 0,
    async render(url: string) { pool.calls++; return { html, finalUrl: url, status: 200 }; },
    async shutdown() {},
    isRunning: () => false,
  };
  return pool as BrowserPool & { calls: number };
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

  it('бросает not_html на бинарном ответе, который браузер не спас', async () => {
    const bin = '%PDF-1.4 бинарь';
    const base = await serve(() => ({ type: 'application/pdf', body: bin }));
    const f = createFetcher(deps(fakeBrowser(bin)));
    await expect(f.fetch(base + '/x.pdf')).rejects.toMatchObject({ code: 'not_html' });
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
