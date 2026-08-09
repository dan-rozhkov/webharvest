import { request } from 'undici';
import type { SearchProvider, SearchResult } from './types.js';

interface BraveRaw {
  web?: { results?: { url?: string; title?: string; description?: string }[] };
}

const stripTags = (s: string) =>
  s
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '') // complete tags with quoted attributes
    .replace(/<[^>]*$/, '') // incomplete tag at end
    .trim();

export function parseBrave(raw: unknown, limit: number): SearchResult[] {
  const data = (raw ?? {}) as BraveRaw;
  const results = data.web?.results ?? [];
  if (!Array.isArray(results)) return [];
  return results
    .filter((r) => typeof r.url === 'string')
    .slice(0, limit)
    .map((r) => ({
      url: r.url!,
      title: stripTags(r.title ?? ''),
      snippet: stripTags(r.description ?? ''),
      engine: 'brave',
    }));
}

export function createBraveProvider(apiKey: string, timeoutMs = 8000): SearchProvider {
  return {
    name: 'brave',
    async search(query, limit) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(limit, 20)));
      const res = await request(url.toString(), {
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        headers: { accept: 'application/json', 'x-subscription-token': apiKey },
      });
      if (res.statusCode !== 200) {
        throw new Error(`Brave вернул ${res.statusCode}`);
      }
      return parseBrave(await res.body.json(), limit);
    },
  };
}
