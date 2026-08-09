import { request } from 'undici';
import type { SearchProvider, SearchResult } from './types.js';

interface SearxngRaw {
  results?: { url?: string; title?: string; content?: string; engine?: string }[];
}

export function parseSearxng(raw: unknown, limit: number): SearchResult[] {
  const data = (raw ?? {}) as SearxngRaw;
  return (data.results ?? [])
    .filter((r): r is Required<Pick<typeof r, 'url'>> & typeof r => typeof r.url === 'string')
    .slice(0, limit)
    .map((r) => ({
      url: r.url!,
      title: (r.title ?? '').trim(),
      snippet: (r.content ?? '').trim(),
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
