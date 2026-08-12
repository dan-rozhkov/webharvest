import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createService } from '../../src/daemon/service.js';
import { loadConfig } from '../../src/daemon/config.js';
import { Cache, scrapeKey } from '../../src/core/cache.js';
import { HarvestError } from '../../src/core/errors.js';

let server: Server | undefined;

async function serve(body: string): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

const article = '<html><head><title>Тестовая</title></head><body><article><p>' + 'слово '.repeat(300) + '</p></article></body></html>';

// loadConfig() reads ~/.webharvest/config.json off the real developer machine
// unless $HOME is isolated. Without this, a stray local config (e.g. a
// cacheTtlMs of 0, or a braveApiKey that turns on a real network provider)
// would make these tests flaky or accidentally-network-touching for reasons
// that have nothing to do with the behavior under test.
let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'webharvest-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  server?.close();
  server = undefined;
});

const cfg = () => loadConfig({ cachePath: ':memory:', searxngUrl: null, braveApiKey: null, allowPrivate: true });

describe('Service.scrape', () => {
  it('возвращает markdown и метаданные', async () => {
    const base = await serve(article);
    const svc = createService(cfg());
    const r = await svc.scrape({ url: base + '/' });
    expect(r.title).toBe('Тестовая');
    expect(r.markdown).toContain('слово');
    expect(r.via).toBe('http');
    expect(r.cached).toBe(false);
    await svc.shutdown();
  });

  it('второй вызов отдаёт из кэша, не ходя в сеть', async () => {
    let hits = 0;
    server = createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(article); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    const url = `http://127.0.0.1:${port}/`;

    const svc = createService(cfg());
    await svc.scrape({ url });
    const second = await svc.scrape({ url });
    expect(hits).toBe(1);
    expect(second.cached).toBe(true);
    await svc.shutdown();
  });

  it('refresh обходит кэш', async () => {
    let hits = 0;
    server = createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(article); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    const url = `http://127.0.0.1:${port}/`;

    const svc = createService(cfg());
    await svc.scrape({ url });
    await svc.scrape({ url, refresh: true });
    expect(hits).toBe(2);
    await svc.shutdown();
  });

  it('includeLinks меняет ключ кэша, а не только вывод', async () => {
    const base = await serve(article + '<a href="/next">дальше</a>');
    const svc = createService(cfg());
    const withLinks = await svc.scrape({ url: base + '/', includeLinks: true });
    expect(withLinks.links?.length).toBeGreaterThan(0);
    const without = await svc.scrape({ url: base + '/' });
    expect(without.links).toBeUndefined();
    await svc.shutdown();
  });

  // Every shape below is JSON.parse-able but not a valid ScrapePayload — the
  // exact case a real cache-format migration produces (old field names, a
  // primitive, an array). If readCache only guarded JSON.parse and not the
  // shape, each of these would be served as a cache HIT with `cached: true`
  // and `hits` staying 0 — this test fails loudly in both ways if that
  // regresses.
  const corruptShapes: [name: string, raw: string][] = [
    ['не-JSON', '{not valid json'],
    ['обрезанный JSON', '{"url":"x","title":"y","markdown":"z"'],
    ['валидный JSON, не тот формат — объект другой схемы', '{"schemaVersion":2,"body":"hi"}'],
    ['валидный JSON — просто строка', '"just a string"'],
    ['валидный JSON — число', '42'],
    ['валидный JSON — массив', '[1,2,3]'],
  ];

  it.each(corruptShapes)('повреждённая/чужой-формы запись в кэше (%s) — промах, а не хардфейл', async (_name, raw) => {
    let hits = 0;
    server = createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(article); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    const url = `http://127.0.0.1:${port}/`;

    // Пишем в файловый кэш заведомо неподходящее значение под тем же ключом,
    // который посчитает scrape() — как будто запись повреждена на диске или
    // осталась от несовместимой прежней версии формата payload.
    const dbPath = join(mkdtempSync(join(tmpdir(), 'webharvest-')), 'cache.db');
    const rawCache = new Cache(dbPath);
    rawCache.set(scrapeKey(url, { includeLinks: false }), raw, 60_000);
    rawCache.close();

    const svc = createService(loadConfig({ cachePath: dbPath, searxngUrl: null, braveApiKey: null, allowPrivate: true }));
    const r = await svc.scrape({ url });
    expect(hits).toBe(1);
    expect(r.cached).toBe(false);
    expect(r.markdown).toContain('слово');
    await svc.shutdown();
  });

  it('невалидный url отклоняется как invalid_url, а не падает сырым TypeError/500', async () => {
    // scrapeKey() -> normalizeUrl() does a bare `new URL(input)`; without
    // validating up front, this used to bubble up as a raw TypeError from
    // deep inside the cache-key computation, which the daemon's generic
    // error handler could only report as 500 "internal — see logs" even
    // though the agent just passed a malformed url and could fix it itself.
    const svc = createService(cfg());
    const err = await svc.scrape({ url: 'hello world' }).catch((e) => e);
    expect(err).toBeInstanceOf(HarvestError);
    expect(err.code).toBe('invalid_url');
    await svc.shutdown();
  });

  it.each([404, 500])(
    'статус ошибки (%i) с текстом на странице не кэшируется и приходит как upstream_error, а не отформатированная статья',
    async (status) => {
      let hits = 0;
      server = createServer((_req, res) => {
        hits++;
        res.writeHead(status, { 'content-type': 'text/html' });
        // A styled error page with real, extractable prose (>200 chars) —
        // exactly the case shouldEscalate() (403/429/503 only) lets through
        // as if it were a real article.
        res.end(article);
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      const { port } = server!.address() as { port: number };
      const url = `http://127.0.0.1:${port}/`;

      const svc = createService(cfg());
      const err = await svc.scrape({ url }).catch((e) => e);
      expect(err).toBeInstanceOf(HarvestError);
      expect(err.code).toBe('upstream_error');
      expect(err.detail).toMatchObject({ status });

      // A second attempt (no refresh) hits the network again — proves the
      // error page was never written to cache in the first place.
      const err2 = await svc.scrape({ url }).catch((e) => e);
      expect(err2.code).toBe('upstream_error');
      expect(hits).toBe(2);
      await svc.shutdown();
    },
  );

  it('чистит просроченные записи кэша при старте демона (не только лениво при чтении)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'webharvest-')), 'cache.db');
    const seed = new Cache(dbPath);
    seed.set('stale-key', '{"x":1}', -1000); // already expired
    seed.close();

    const svc = createService(loadConfig({ cachePath: dbPath, searxngUrl: null, braveApiKey: null, allowPrivate: true }));
    await svc.shutdown();

    // Query the raw table directly (not Cache.get(), which would itself
    // lazily delete an expired row on read and thus prove nothing about
    // whether createService's own startup purge ran).
    const raw = new Database(dbPath);
    const count = (raw.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c;
    raw.close();
    expect(count).toBe(0);
  });

  it('чистит просроченные записи кэша периодически, не только при старте', async () => {
    vi.useFakeTimers();
    try {
      const dbPath = join(mkdtempSync(join(tmpdir(), 'webharvest-')), 'cache.db');
      const svc = createService(loadConfig({ cachePath: dbPath, searxngUrl: null, braveApiKey: null, allowPrivate: true }));

      // Seed an expired row AFTER startup — the startup purge alone can't
      // have caught it.
      const seed = new Cache(dbPath);
      seed.set('stale-key', '{"x":1}', -1000);
      seed.close();

      vi.advanceTimersByTime(60 * 60_000 + 1000);
      await svc.shutdown();

      const raw = new Database(dbPath);
      const count = (raw.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c;
      raw.close();
      expect(count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shutdown() закрывает браузер, реально запущенный для эскалации', async () => {
    // Статический HTML — пустая оболочка (thin_spa): извлечённый текст ~0,
    // фетчер эскалирует в браузер. Только настоящий рендер выполнит script и
    // положит текст в #root — так тест доказывает, что браузер был реально
    // запущен, а не просто сконструирован.
    const shell =
      '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script>' +
      'document.getElementById("root").innerHTML = "<article><h1>Заголовок</h1><p>" + "текст ".repeat(300) + "</p></article>";' +
      '</script></body></html>';
    const base = await serve(shell);

    const svc = createService(cfg());
    expect(svc.isBrowserRunning?.()).toBe(false);

    const r = await svc.scrape({ url: base + '/' });
    expect(r.via).toBe('browser');
    expect(r.markdown).toContain('текст');
    // Доказывает, что браузер реально поднят (а не что isBrowserRunning
    // всегда возвращает false) — иначе следующая проверка была бы бессмысленной.
    expect(svc.isBrowserRunning?.()).toBe(true);

    await svc.shutdown();
    // Если бы shutdown() не звал browser.shutdown(), это осталось бы true —
    // ровно тот регресс ("осиротевший Chromium"), который и должен ловить тест.
    expect(svc.isBrowserRunning?.()).toBe(false);
  }, 30_000);
});

describe('Service: детерминированные browser-use действия (без модели внутри демона)', () => {
  const form =
    '<html><head><meta charset="utf-8"><title>Форма</title></head><body>' +
    '<input id="name" type="text" />' +
    '<button id="reveal" onclick="document.getElementById(\'out\').textContent = \'Готово: \' + document.getElementById(\'name\').value">Отправить</button>' +
    '<div id="out"></div>' +
    '</body></html>';

  function findElementId(outline: string, needle: string): string {
    const line = outline.split('\n').find((l) => l.includes(needle));
    if (!line) throw new Error(`не нашёл «${needle}» в outline:\n${outline}`);
    const m = /\[(\d+-\d+)]/.exec(line);
    if (!m) throw new Error(`строка без адреса: ${line}`);
    return m[1]!;
  }

  it('browser_snapshot возвращает свежее дерево той же страницы без выполнения действия', async () => {
    const base = await serve(form);
    const svc = createService(cfg());
    const { sessionId, outline } = await svc.browserOpen!({ url: base + '/' });
    try {
      const snap = await svc.browserSnapshot!({ sessionId });
      expect(snap.outline).toBe(outline);
    } finally {
      await svc.browserClose!({ sessionId });
      await svc.shutdown();
    }
  });

  it('browser_fill заполняет поле, browser_click кликает, диф действия показывает результат', async () => {
    const base = await serve(form);
    const svc = createService(cfg());
    const { sessionId, outline } = await svc.browserOpen!({ url: base + '/' });
    try {
      const nameId = findElementId(outline, 'textbox');
      const fillResult = await svc.browserFill!({ sessionId, elementId: nameId, text: 'Аня' });
      expect(fillResult.changed).toContain('Аня');

      const afterFill = await svc.browserSnapshot!({ sessionId });
      const buttonId = findElementId(afterFill.outline, 'Отправить');
      const clickResult = await svc.browserClick!({ sessionId, elementId: buttonId });
      expect(clickResult.changed).toContain('Готово: Аня');
    } finally {
      await svc.browserClose!({ sessionId });
      await svc.shutdown();
    }
  });

  it('browser_fill с variables подставляет значение по плейсхолдеру, не требуя его в тексте вызова', async () => {
    const base = await serve(form);
    const svc = createService(cfg());
    const { sessionId, outline } = await svc.browserOpen!({ url: base + '/' });
    try {
      const nameId = findElementId(outline, 'textbox');
      await svc.browserFill!({ sessionId, elementId: nameId, text: '%secret%', variables: { secret: 'сложный-пароль' } });

      const afterFill = await svc.browserSnapshot!({ sessionId });
      // Само поле уже отредактировано на этом снапшоте — плейсхолдер, не значение.
      expect(afterFill.outline).not.toContain('сложный-пароль');
      expect(afterFill.outline).toContain('%secret%');

      const buttonId = findElementId(afterFill.outline, 'Отправить');
      const clickResult = await svc.browserClick!({ sessionId, elementId: buttonId });
      // Кнопка прочитала настоящее значение из DOM (механизм действительно
      // подставил секрет в браузер) — но диф, уходящий вызывающему агенту,
      // видит уже отредактированный текст, а не сам секрет.
      expect(clickResult.changed).toContain('Готово: %secret%');
      expect(clickResult.changed).not.toContain('сложный-пароль');
    } finally {
      await svc.browserClose!({ sessionId });
      await svc.shutdown();
    }
  });

  it('действие на неизвестной сессии — not_found', async () => {
    const svc = createService(cfg());
    const err = await svc.browserClick!({ sessionId: 'no-such-session', elementId: '0-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(HarvestError);
    expect(err.code).toBe('not_found');
    await svc.shutdown();
  });
});

describe('Service.search', () => {
  it('усечённое содержимое поиска помечено явно (truncated/remaining), а не молча обрезано', async () => {
    const longArticle =
      '<html><head><title>Длинная</title></head><body><article><p>' + 'слово '.repeat(2000) + '</p></article></body></html>';
    const base = await serve(longArticle);
    const url = base + '/';

    const searxng = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ url, title: 'T', content: 'snippet', engine: 'test' }] }));
    });
    await new Promise<void>((r) => searxng.listen(0, '127.0.0.1', r));
    const { port: searxngPort } = searxng.address() as { port: number };

    const svc = createService(loadConfig({
      cachePath: ':memory:',
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      braveApiKey: null,
      allowPrivate: true,
    }));

    try {
      const results = await svc.search({ query: 'x', fetchContent: true });
      expect(results[0]?.content?.length).toBeLessThanOrEqual(8000);
      expect(results[0]?.truncated).toBe(true);
      expect(results[0]?.remaining).toBeGreaterThan(0);
    } finally {
      await svc.shutdown();
      await new Promise<void>((r) => searxng.close(() => r()));
    }
  });

  it('бросает search_unavailable, когда провайдеры не настроены', async () => {
    const svc = createService(cfg());
    await expect(svc.search({ query: 'что угодно' })).rejects.toMatchObject({ code: 'search_unavailable' });
    await svc.shutdown();
  });

  it('fetchContent берёт не больше 5 страниц, не больше 3 параллельно, и одна упавшая не валит остальные', async () => {
    let active = 0;
    let peak = 0;
    async function goodPage(_req: unknown, res: import('node:http').ServerResponse): Promise<void> {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 60));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(article);
      active--;
    }

    // DomainQueue paces requests per-hostname (default maxConcurrent 2,
    // minIntervalMs 500), keyed on the literal hostname string in the URL —
    // not the port. Four "good" targets on the same hostname (even on four
    // different ports) would therefore be throttled by that politeness
    // layer before withContent's own 3-worker cap ever became the binding
    // constraint, making it impossible to observe "3" instead of "≤2". Using
    // three distinct hostname strings that all resolve to loopback
    // (127.0.0.1 / localhost / [::1]) gives the first three targets three
    // independent queues, so they launch truly in parallel and the peak we
    // measure is actually FETCH_CONTENT_CONCURRENCY, not DomainQueue's.
    const s4 = createServer((req, res) => void goodPage(req, res));
    await new Promise<void>((r) => s4.listen(0, '127.0.0.1', r));
    const p4 = (s4.address() as { port: number }).port;
    const s6 = createServer((req, res) => void goodPage(req, res));
    await new Promise<void>((r) => s6.listen(0, '::1', r));
    const p6 = (s6.address() as { port: number }).port;

    const goodServers: Server[] = [s4, s6];
    const goodUrls = [
      `http://127.0.0.1:${p4}/good0`,
      `http://localhost:${p6}/good1`,
      `http://[::1]:${p6}/good2`,
      // 4th good target reuses the 127.0.0.1 hostname — it queues behind
      // good0 on that host's own DomainQueue slot rather than running as a
      // fourth parallel worker, which is fine: it only needs to land inside
      // the 5-target budget, not the initial 3-way race.
      `http://127.0.0.1:${p4}/good3`,
    ];

    // Guaranteed-refused port: bind on ::1 (badUrl below connects via
    // "localhost", which resolves there in this environment), read the
    // assigned port, then close it — nothing else in this test window will
    // be listening there.
    const closedProbe = createServer();
    await new Promise<void>((r) => closedProbe.listen(0, '::1', r));
    const closedPort = (closedProbe.address() as { port: number }).port;
    await new Promise<void>((r) => closedProbe.close(() => r()));
    const badUrl = `http://localhost:${closedPort}/`;

    // Beyond the fetchContent cap of 5 — must never be fetched at all.
    const untouchedUrls = ['http://127.0.0.1:1/extra0', 'http://127.0.0.1:1/extra1', 'http://127.0.0.1:1/extra2'];

    // SearXNG-shaped provider, stubbed via a local HTTP server (fake
    // provider injection isn't part of Service's public surface — going
    // through the real createSearxngProvider keeps this an integration test
    // of what createService actually wires up).
    const allUrls = [...goodUrls, badUrl, ...untouchedUrls];
    const searxng = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        results: allUrls.map((url, i) => ({ url, title: `T${i}`, content: 'snippet', engine: 'test' })),
      }));
    });
    await new Promise<void>((r) => searxng.listen(0, '127.0.0.1', r));
    const { port: searxngPort } = searxng.address() as { port: number };

    const svc = createService(loadConfig({
      cachePath: ':memory:',
      searxngUrl: `http://127.0.0.1:${searxngPort}`,
      braveApiKey: null,
      allowPrivate: true,
    }));

    try {
      const results = await svc.search({ query: 'x', limit: 8, fetchContent: true });
      expect(results).toHaveLength(8);

      // First 4 (good, within the 5-cap): fetched successfully.
      for (let i = 0; i < 4; i++) {
        expect(results[i]?.content).toContain('слово');
        expect(results[i]?.error).toBeUndefined();
      }
      // 5th (bad, within the 5-cap): attempted, failed, isolated to its own result.
      expect(results[4]?.error).toBeDefined();
      expect(results[4]?.content).toBeUndefined();
      // 6th-8th: beyond the cap — never attempted, untouched.
      for (let i = 5; i < 8; i++) {
        expect(results[i]?.content).toBeUndefined();
        expect(results[i]?.error).toBeUndefined();
      }

      // Never more than 3 pages in flight at once.
      expect(peak).toBeLessThanOrEqual(3);
      // ...and not needlessly serialized to 1 either — the cap is really 3.
      expect(peak).toBe(3);
    } finally {
      await svc.shutdown();
      await new Promise<void>((r) => searxng.close(() => r()));
      await Promise.all(goodServers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    }
  }, 30_000);
});
