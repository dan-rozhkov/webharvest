import { request } from 'undici';
import { stripTags } from './strip-tags.js';
import type { SearchProvider, SearchResult } from './types.js';

interface SearxngRaw {
  results?: { url?: string; title?: string; content?: string; engine?: string }[];
}

export function parseSearxng(raw: unknown, limit: number): SearchResult[] {
  const data = (raw ?? {}) as SearxngRaw;
  const results = data.results ?? [];
  if (!Array.isArray(results)) return [];
  return results
    .filter((r): r is Required<Pick<typeof r, 'url'>> & typeof r => typeof r.url === 'string')
    .slice(0, limit)
    .map((r) => ({
      url: r.url!,
      // Some SearXNG engines return snippets with markup (e.g. Google's
      // <span class="highlight">query</span> around matched terms) — Brave's
      // provider already stripped its own tags; SearXNG's didn't, so those
      // fragments landed verbatim in the agent's context.
      title: stripTags(r.title ?? ''),
      snippet: stripTags(r.content ?? ''),
      engine: `searxng:${r.engine ?? 'unknown'}`,
    }));
}

export function createSearxngProvider(baseUrl: string, timeoutMs = 8000): SearchProvider {
  return {
    name: 'searxng',
    async search(query, limit) {
      const url = new URL('/search', baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '0');
      const res = await request(url.toString(), {
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        headers: { accept: 'application/json' },
      });
      if (res.statusCode !== 200) {
        throw new Error(`SearXNG вернул ${res.statusCode}`);
      }
      return parseSearxng(await res.body.json(), limit);
    },
  };
}
