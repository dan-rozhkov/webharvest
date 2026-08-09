import { describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../../src/daemon/service.js';
import { loadConfig } from '../../src/daemon/config.js';
import { Cache, scrapeKey } from '../../src/core/cache.js';

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
    server?.close();
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
    server?.close();
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
    server?.close();
  });

  it('includeLinks меняет ключ кэша, а не только вывод', async () => {
    const base = await serve(article + '<a href="/next">дальше</a>');
    const svc = createService(cfg());
    const withLinks = await svc.scrape({ url: base + '/', includeLinks: true });
    expect(withLinks.links?.length).toBeGreaterThan(0);
    const without = await svc.scrape({ url: base + '/' });
    expect(without.links).toBeUndefined();
    await svc.shutdown();
    server?.close();
  });

  it('повреждённая запись в кэше не валит scrape, а трактуется как промах', async () => {
    let hits = 0;
    server = createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(article); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    const url = `http://127.0.0.1:${port}/`;

    // Пишем в файловый кэш заведомо не-JSON значение под тем же ключом,
    // который посчитает scrape() — как будто запись повреждена на диске
    // или осталась от несовместимой прежней версии формата payload.
    const dbPath = join(mkdtempSync(join(tmpdir(), 'webharvest-')), 'cache.db');
    const raw = new Cache(dbPath);
    raw.set(scrapeKey(url, { includeLinks: false }), '{not valid json', 60_000);
    raw.close();

    const svc = createService(loadConfig({ cachePath: dbPath, searxngUrl: null, braveApiKey: null, allowPrivate: true }));
    const r = await svc.scrape({ url });
    expect(hits).toBe(1);
    expect(r.cached).toBe(false);
    expect(r.markdown).toContain('слово');
    await svc.shutdown();
    server?.close();
  });
});

describe('Service.search', () => {
  it('бросает search_unavailable, когда провайдеры не настроены', async () => {
    const svc = createService(cfg());
    await expect(svc.search({ query: 'что угодно' })).rejects.toMatchObject({ code: 'search_unavailable' });
    await svc.shutdown();
  });
});
