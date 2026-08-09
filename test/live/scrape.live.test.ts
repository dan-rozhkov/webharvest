import { describe, it, expect, afterAll } from 'vitest';
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

const service = createService(loadConfig({ cachePath: ':memory:' }));
afterAll(async () => {
  await service.shutdown();
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
  it('возвращает достаточно текста и правильный заголовок', async () => {
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

  it('не тащит навигационный мусор', async () => {
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
