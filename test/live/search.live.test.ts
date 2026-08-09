import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createService } from '../../src/daemon/service.js';
import { loadConfig } from '../../src/daemon/config.js';

const LIVE = process.env.WEBHARVEST_LIVE === '1';
// vitest 2.1's TaskContext#skip() takes no reason argument, so the "how to
// run this" hint is baked into the test title instead — it shows up next to
// every skipped test in the reporter output.
const titled = (name: string): string =>
  LIVE ? name : `${name} (skipped — run \`npm run test:live\` to execute)`;

let service: ReturnType<typeof createService>;
beforeAll(() => {
  if (LIVE) service = createService(loadConfig({ cachePath: ':memory:' }));
});
afterAll(async () => {
  await service?.shutdown();
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
  it(titled('находит официальный сайт по названию инструмента'), async (ctx) => {
    if (!LIVE) {
      ctx.skip();
      return;
    }
    if (!(await checkSearchAvailable())) {
      ctx.skip();
    }
    const results = await service.search({ query: 'playwright testing framework docs' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.url.includes('playwright.dev'))).toBe(true);
  }, 30_000);

  it(titled('не возвращает дублей по нормализованному URL'), async (ctx) => {
    if (!LIVE) {
      ctx.skip();
      return;
    }
    if (!(await checkSearchAvailable())) {
      ctx.skip();
    }
    const results = await service.search({ query: 'typescript handbook', limit: 10 });
    const hosts = results.map((r) => r.url.replace(/[?#].*$/, ''));
    expect(new Set(hosts).size).toBe(hosts.length);
  }, 30_000);

  it(titled('догружает содержимое и переживает падение отдельного результата'), async (ctx) => {
    if (!LIVE) {
      ctx.skip();
      return;
    }
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
