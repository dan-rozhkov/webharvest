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

  it('не отдаёт наружу стектрейс на неожиданной ошибке', async () => {
    const app = createHttpServer(stubService({
      scrape: async () => { throw new Error('внутренняя деталь с путями /Users/...'); },
    }));
    const res = await app.inject({ method: 'POST', url: '/scrape', payload: { url: 'https://example.com/' } });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.json())).not.toContain('/Users/');
    await app.close();
  });

  it('POST /search ограничивает limit потолком 10', async () => {
    let seen = 0;
    const app = createHttpServer(stubService({
      search: async ({ limit }) => { seen = limit ?? 0; return []; },
    }));
    await app.inject({ method: 'POST', url: '/search', payload: { query: 'q', limit: 999 } });
    expect(seen).toBe(10);
    await app.close();
  });
});
