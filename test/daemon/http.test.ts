import { describe, it, expect } from 'vitest';
import { createHttpServer } from '../../src/daemon/http.js';
import { HarvestError } from '../../src/core/errors.js';
import type { Service } from '../../src/daemon/service.js';

const stubService = (overrides: Partial<Service> = {}): Service => ({
  scrape: async ({ url }) => ({ url, title: 'T', markdown: 'M', via: 'http', cached: false, status: 200 }),
  search: async () => [{ url: 'https://a/', title: 'A', snippet: 's', engine: 'brave' }],
  shutdown: async () => {},
  ...overrides,
});

const NOT_FOUND = new HarvestError('not_found', 'Сессия s1 не найдена — возможно, она уже закрыта');

describe('HTTP API', () => {
  it('GET /health отвечает ok', async () => {
    const app = createHttpServer(stubService());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it('GET /health.browser реально читает isBrowserRunning сервиса, а не захардкожен', async () => {
    // Without wiring, "browser" would be a constant true or false regardless
    // of the service — this asserts it's actually threaded through by
    // checking both values are reachable from the same endpoint.
    const runningApp = createHttpServer(stubService({ isBrowserRunning: () => true }));
    const runningRes = await runningApp.inject({ method: 'GET', url: '/health' });
    expect(runningRes.json()).toMatchObject({ browser: true });
    await runningApp.close();

    const idleApp = createHttpServer(stubService({ isBrowserRunning: () => false }));
    const idleRes = await idleApp.inject({ method: 'GET', url: '/health' });
    expect(idleRes.json()).toMatchObject({ browser: false });
    await idleApp.close();
  });

  it('GET /health не 500-ит и не отдаёт наружу детали, если isBrowserRunning бросает', async () => {
    const app = createHttpServer(stubService({
      isBrowserRunning: () => { throw new Error('утечка: /Users/secret и ключ sk-fake-123'); },
    }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, browser: false });
    expect(JSON.stringify(res.json())).not.toContain('/Users/secret');
    await app.close();
  });

  it('POST /scrape возвращает полезную нагрузку', async () => {
    const app = createHttpServer(stubService());
    const res = await app.inject({ method: 'POST', url: '/scrape', payload: { url: 'https://example.com/' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'T', markdown: 'M', via: 'http' });
    await app.close();
  });

  it('POST /scrape без url отвечает 400', async () => {
    const app = createHttpServer(stubService());
    const res = await app.inject({ method: 'POST', url: '/scrape', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_url');
    await app.close();
  });

  it('POST /scrape с невалидным полем refresh называет offending field, а не врёт про url', async () => {
    const app = createHttpServer(stubService());
    const res = await app.inject({
      method: 'POST',
      url: '/scrape',
      payload: { url: 'https://example.com', refresh: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    // Must NOT be invalid_url — url itself is fine here, refresh is the
    // actual problem. The old code always said invalid_url/"Требуется поле
    // url" regardless of which field zod rejected.
    expect(res.json().error.code).toBe('invalid_request');
    expect(res.json().error.message).toMatch(/refresh/);
    await app.close();
  });

  it('маппит blocked в 422 с указанием защиты', async () => {
    const app = createHttpServer(stubService({
      scrape: async () => { throw new HarvestError('blocked', 'закрыто cloudflare', { by: 'cloudflare' }); },
    }));
    const res = await app.inject({ method: 'POST', url: '/scrape', payload: { url: 'https://example.com/' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'blocked', detail: { by: 'cloudflare' } });
    await app.close();
  });

  it('маппит timeout в 504', async () => {
    const app = createHttpServer(stubService({
      scrape: async () => { throw new HarvestError('timeout', 'долго'); },
    }));
    const res = await app.inject({ method: 'POST', url: '/scrape', payload: { url: 'https://example.com/' } });
    expect(res.statusCode).toBe(504);
    await app.close();
  });

  it('не отдаёт наружу стектрейс на неожиданной ошибке из scrape', async () => {
    const app = createHttpServer(stubService({
      scrape: async () => { throw new Error('внутренняя деталь с путями /Users/...'); },
    }));
    const res = await app.inject({ method: 'POST', url: '/scrape', payload: { url: 'https://example.com/' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('internal');
    expect(JSON.stringify(res.json())).not.toContain('/Users/');
    await app.close();
  });

  it('POST /search возвращает { results } (не голый массив) и ограничивает limit потолком 10', async () => {
    let seen = 0;
    const app = createHttpServer(stubService({
      search: async ({ limit }) => { seen = limit ?? 0; return [{ url: 'https://a/', title: 'A', snippet: 's', engine: 'brave' }]; },
    }));
    const res = await app.inject({ method: 'POST', url: '/search', payload: { query: 'q', limit: 999 } });
    expect(seen).toBe(10);
    expect(res.statusCode).toBe(200);
    // Pinned in both directions: a bare array here would break Task 13's
    // client, which is written against { results: [...] }.
    expect(res.json()).toEqual({ results: [{ url: 'https://a/', title: 'A', snippet: 's', engine: 'brave' }] });
    await app.close();
  });

  it('POST /search без query отвечает 400 с честным кодом invalid_query (не invalid_url)', async () => {
    const app = createHttpServer(stubService());
    const res = await app.inject({ method: 'POST', url: '/search', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_query');
    expect(res.json().error.message).toMatch(/query/);
    await app.close();
  });

  it('неизвестный маршрут отвечает 404 в общем конверте ошибок, а не дефолтным фастифаем', async () => {
    const app = createHttpServer(stubService());
    const res = await app.inject({ method: 'POST', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    // Fastify's own default 404 body has "message" at the top level, not
    // nested under "error" — this pins that we override it, not just match it.
    expect(res.json().message).toBeUndefined();
    await app.close();
  });

  it('битый JSON-body отвечает по нашему конверту, а не дефолтным фастифаем', async () => {
    const app = createHttpServer(stubService());
    const res = await app.inject({
      method: 'POST',
      url: '/scrape',
      headers: { 'content-type': 'application/json' },
      payload: '{not valid json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error.code');
    // Fastify's default body-parser error shape is {statusCode,code,error,message}
    // with "error" as a *string* ("Bad Request") — asserting it's an object
    // here pins that we replaced it, not merely wrapped it.
    expect(typeof res.json().error).toBe('object');
    await app.close();
  });
});

describe('HTTP API: browser-use эндпоинты', () => {
  it('POST /browser/open требует url', async () => {
    const app = createHttpServer(stubService({
      browserOpen: async ({ url }) => ({ sessionId: 's1', outline: `[0-1] RootWebArea: ${url}` }),
    }));
    const res = await app.inject({ method: 'POST', url: '/browser/open', payload: { url: 'https://a/' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: 's1' });
    await app.close();
  });

  it('POST /browser/open без url отвечает 400 invalid_request', async () => {
    const app = createHttpServer(stubService());
    const res = await app.inject({ method: 'POST', url: '/browser/open', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
    await app.close();
  });

  it('POST /browser/snapshot возвращает outline', async () => {
    const app = createHttpServer(stubService({
      browserSnapshot: async () => ({ outline: '[0-1] RootWebArea: T' }),
    }));
    const res = await app.inject({ method: 'POST', url: '/browser/snapshot', payload: { sessionId: 's1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outline: '[0-1] RootWebArea: T' });
    await app.close();
  });

  it('POST /browser/click возвращает диф изменений', async () => {
    const app = createHttpServer(stubService({
      browserClick: async (args) => ({ changed: `clicked ${args.elementId}` }),
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/browser/click',
      payload: { sessionId: 's1', elementId: '0-2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changed: 'clicked 0-2' });
    await app.close();
  });

  it('POST /browser/click без elementId отвечает 400 invalid_request', async () => {
    const app = createHttpServer(stubService({ browserClick: async () => ({ changed: '' }) }));
    const res = await app.inject({ method: 'POST', url: '/browser/click', payload: { sessionId: 's1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
    await app.close();
  });

  it('POST /browser/fill принимает text и variables', async () => {
    let seen: unknown;
    const app = createHttpServer(stubService({
      browserFill: async (args) => { seen = args; return { changed: 'ok' }; },
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/browser/fill',
      payload: { sessionId: 's1', elementId: '0-2', text: '%token%', variables: { token: 'secret' } },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ sessionId: 's1', elementId: '0-2', text: '%token%', variables: { token: 'secret' } });
    await app.close();
  });

  it('POST /browser/type принимает text без variables', async () => {
    const app = createHttpServer(stubService({ browserType: async () => ({ changed: 'ok' }) }));
    const res = await app.inject({
      method: 'POST',
      url: '/browser/type',
      payload: { sessionId: 's1', elementId: '0-2', text: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('POST /browser/press требует key', async () => {
    const app = createHttpServer(stubService({ browserPress: async () => ({ changed: '' }) }));
    const missing = await app.inject({ method: 'POST', url: '/browser/press', payload: { sessionId: 's1', elementId: '0-2' } });
    expect(missing.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/browser/press',
      payload: { sessionId: 's1', elementId: '0-2', key: 'Enter' },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it('POST /browser/select требует value', async () => {
    const app = createHttpServer(stubService({ browserSelect: async () => ({ changed: '' }) }));
    const res = await app.inject({
      method: 'POST',
      url: '/browser/select',
      payload: { sessionId: 's1', elementId: '0-2', value: 'Опция' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('POST /browser/scroll требует percent', async () => {
    const app = createHttpServer(stubService({ browserScroll: async () => ({ changed: '' }) }));
    const res = await app.inject({
      method: 'POST',
      url: '/browser/scroll',
      payload: { sessionId: 's1', elementId: '0-2', percent: '50' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('POST /browser/close закрывает сессию и отвечает пустым объектом', async () => {
    let closed: unknown;
    const app = createHttpServer(stubService({ browserClose: async (args) => { closed = args; } }));
    const res = await app.inject({ method: 'POST', url: '/browser/close', payload: { sessionId: 's1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(closed).toEqual({ sessionId: 's1' });
    await app.close();
  });

  it('неизвестная сессия на действии — 404 not_found', async () => {
    const app = createHttpServer(stubService({
      browserClick: async () => { throw NOT_FOUND; },
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/browser/click',
      payload: { sessionId: 's1', elementId: '0-2' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });

  it('метод, не реализованный сервисом, отвечает internal (баг проводки, а не "сессия не найдена")', async () => {
    const app = createHttpServer(stubService());
    const res = await app.inject({
      method: 'POST',
      url: '/browser/click',
      payload: { sessionId: 's1', elementId: '0-2' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('internal');
    await app.close();
  });
});
