import { HarvestError } from '../errors.js';
import { normalizeUrl } from '../url.js';
import type { SearchProvider, SearchResult } from './types.js';

export type { SearchProvider, SearchResult } from './types.js';
export { createSearxngProvider, parseSearxng } from './searxng.js';
export { createBraveProvider, parseBrave } from './brave.js';

export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    let key: string;
    try {
      key = normalizeUrl(r.url);
    } catch {
      key = r.url;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function createSearch(providers: SearchProvider[]) {
  return {
    async search(query: string, limit: number): Promise<SearchResult[]> {
      const failures: string[] = [];
      // Ask the provider for more than `limit`, not exactly `limit`: each
      // provider already slices its own raw response down to `limit` before
      // we ever see it, so if dedupeResults() then drops any of those as
      // trackingparam/near-duplicate URLs, the final count silently shrinks
      // below what the caller asked for. Padding leaves dedupe room to drop
      // some and still hit `limit`, without ourselves quietly returning
      // fewer results than requested.
      const fetchLimit = Math.min(limit * 2, 20);
      for (const p of providers) {
        try {
          const results = dedupeResults(await p.search(query, fetchLimit));
          if (results.length > 0) return results.slice(0, limit);
          failures.push(`${p.name}: пустая выдача`);
        } catch (e) {
          failures.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throw new HarvestError(
        'search_unavailable',
        failures.length
          ? `Ни один поисковый провайдер не ответил. ${failures.join('; ')}`
          : 'Поисковые провайдеры не настроены: подними SearXNG или задай BRAVE_API_KEY',
        { failures },
      );
    },
  };
}
