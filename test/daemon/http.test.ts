import { describe, it, expect } from 'vitest';
import { createHttpServer } from '../../src/daemon/http.js';
import { HarvestError } from '../../src/core/errors.js';
import type { Service } from '../../src/daemon/service.js';

const stubService = (overrides: Partial<Service> = {}): Service => ({
  scrape: async ({ url }) => ({ url, title: 'T', markdown: 'M', via: 'http', cached: false }),
  search: async () => [{ url: 'https://a/', title: 'A', snippet: 's', engine: 'brave' }],
  shutdown: async () => {},
  ...overrides,
});

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
