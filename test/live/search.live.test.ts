import { describe, it, expect, afterAll } from 'vitest';
import { createService } from '../../src/daemon/service.js';
import { loadConfig } from '../../src/daemon/config.js';

const service = createService(loadConfig({ cachePath: ':memory:' }));
afterAll(async () => {
  await service.shutdown();
});

// Detect if search is available
let searchAvailable: boolean | null = null;
let skipReason = '';

async function checkSearchAvailable(): Promise<boolean> {
  if (searchAvailable !== null) return searchAvailable;

  const hasEnvKey = !!process.env.BRAVE_API_KEY;
  const hasSearxng = process.env.WEBHARVEST_SEARXNG_URL !== 'null' && !!process.env.WEBHARVEST_SEARXNG_URL;

  if (!hasEnvKey && !hasSearxng) {
    skipReason = 'BRAVE_API_KEY not set and SearXNG not configured';
    searchAvailable = false;
    return false;
  }

  // Try a quick search to see if backend is actually reachable
  try {
    await service.search({ query: 'test' });
    searchAvailable = true;
    return true;
  } catch (e) {
    skipReason = `Search backend unreachable: ${e instanceof Error ? e.message : String(e)}`;
    searchAvailable = false;
    return false;
  }
}

describe('live search', () => {
  it('находит официальный сайт по названию инструмента', async (ctx) => {
    if (!(await checkSearchAvailable())) {
      ctx.skip();
    }
    const results = await service.search({ query: 'playwright testing framework docs' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.url.includes('playwright.dev'))).toBe(true);
  }, 30_000);

  it('не возвращает дублей по нормализованному URL', async (ctx) => {
    if (!(await checkSearchAvailable())) {
      ctx.skip();
    }
    const results = await service.search({ query: 'typescript handbook', limit: 10 });
    const hosts = results.map((r) => r.url.replace(/[?#].*$/, ''));
    expect(new Set(hosts).size).toBe(hosts.length);
  }, 30_000);

  it('догружает содержимое и переживает падение отдельного результата', async (ctx) => {
    if (!(await checkSearchAvailable())) {
      ctx.skip();
    }
    const results = await service.search({
      query: 'vitest getting started',
      limit: 3,
      fetchContent: true,
    });
    expect(results.some((r) => (r.content?.length ?? 0) > 200)).toBe(true);
    // упавшие результаты приходят с error, но не роняют поиск
    for (const r of results) {
      expect(r.url).toBeTruthy();
    }
  }, 90_000);
});
