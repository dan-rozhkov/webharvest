import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createService } from '../../src/daemon/service.js';
import { loadConfig } from '../../src/daemon/config.js';
import { HarvestError } from '../../src/core/errors.js';

interface Golden {
  url: string;
  minChars: number;
  titleIncludes: string;
}

const golden: Golden[] = JSON.parse(
  readFileSync(new URL('./golden.json', import.meta.url), 'utf8'),
);

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

const JUNK = [
  'Skip to main content',
  'Skip to content',
  'Jump to content',
  'Accept all cookies',
  'We use cookies',
  'Subscribe to our newsletter',
];

describe.each(golden)('live scrape: $url', (g) => {
  it(titled('возвращает достаточно текста и правильный заголовок'), async (ctx) => {
    if (!LIVE) {
      ctx.skip();
      return;
    }
    const started = Date.now();
    let r;
    try {
      r = await service.scrape({ url: g.url, refresh: true });
    } catch (e) {
      // Rethrow HarvestError with more diagnostic context
      if (HarvestError.is(e)) {
        throw new Error(`${e.code}: ${g.url} - ${e.message}`);
      }
      throw e;
    }

    expect(r.markdown.length, `via=${r.via} chars=${r.markdown.length}`).toBeGreaterThanOrEqual(g.minChars);
    if (g.titleIncludes) {
      expect(r.title.toLowerCase(), `url=${g.url} via=${r.via} title="${r.title}"`).toContain(g.titleIncludes.toLowerCase());
    }
    const elapsed = Date.now() - started;
    expect(elapsed, `via=${r.via} elapsed=${elapsed}ms`).toBeLessThan(45_000);
  }, 60_000);

  it(titled('не тащит навигационный мусор'), async (ctx) => {
    if (!LIVE) {
      ctx.skip();
      return;
    }
    let r;
    try {
      r = await service.scrape({ url: g.url });
    } catch (e) {
      // Rethrow HarvestError with more diagnostic context
      if (HarvestError.is(e)) {
        throw new Error(`${e.code}: ${g.url} - ${e.message}`);
      }
      throw e;
    }
    for (const junk of JUNK) {
      expect(r.markdown, `via=${r.via} chars=${r.markdown.length} found="${junk}"`).not.toContain(junk);
    }
  }, 60_000);
});
