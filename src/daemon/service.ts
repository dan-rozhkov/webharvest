import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { Cache, scrapeKey } from '../core/cache.js';
import { DomainQueue } from '../core/politeness.js';
import { createBrowserPool } from '../core/browser.js';
import { createFetcher, DomainHints } from '../core/fetcher.js';
import { extract } from '../core/extractor.js';
import { createSearch, createSearxngProvider, createBraveProvider } from '../core/search/index.js';
import type { SearchProvider, SearchResult } from '../core/search/types.js';
import type { ScrapePayload } from '../core/format.js';
import type { Config } from './config.js';

export interface Service {
  scrape(args: { url: string; includeLinks?: boolean; refresh?: boolean }): Promise<ScrapePayload>;
  search(args: { query: string; limit?: number; fetchContent?: boolean }): Promise<SearchResult[]>;
  shutdown(): Promise<void>;
  /** Optional: whether the browser pool currently has a live instance.
   *  Used by GET /health for an honest readiness signal. Optional so stubs
   *  in tests aren't forced to implement it. */
  isBrowserRunning?(): boolean;
}

const FETCH_CONTENT_MAX = 5;
const FETCH_CONTENT_CONCURRENCY = 3;

// Shape the cache entry must have to be trusted as a ScrapePayload. JSON.parse
// alone only proves the bytes are valid JSON — it says nothing about whether
// they're a ScrapePayload. A cache written by an older/incompatible format
// version (e.g. a renamed field or a schema migration) parses just fine and
// would otherwise be served as a false HIT, later crashing formatScrape() or
// any other consumer that trusts `.markdown`/`.title`/`.url` to be strings.
const cachedPayloadSchema = z.object({
  url: z.string(),
  title: z.string(),
  markdown: z.string(),
  via: z.union([z.literal('http'), z.literal('browser')]),
  cached: z.boolean(),
  links: z.array(z.object({ href: z.string(), text: z.string() })).optional(),
});

export function createService(config: Config): Service {
  if (config.cachePath !== ':memory:') {
    mkdirSync(dirname(config.cachePath), { recursive: true });
  }
  const cache = new Cache(config.cachePath);
  const browser = createBrowserPool({ idleTimeoutMs: config.idleTimeoutMs });
  const fetcher = createFetcher({
    queue: new DomainQueue(),
    browser,
    hints: new DomainHints(),
    allowPrivate: config.allowPrivate,
  });

  const providers: SearchProvider[] = [];
  if (config.searxngUrl) providers.push(createSearxngProvider(config.searxngUrl));
  if (config.braveApiKey) providers.push(createBraveProvider(config.braveApiKey));
  const search = createSearch(providers);

  /** Читает кэш, но никогда не даёт кэш-хиту стать хардфейлом: запись могла
   *  быть повреждена на диске (не-JSON, обрезанный файл) ИЛИ быть валидным
   *  JSON неправильной формы — например, от прежней несовместимой версии
   *  формата payload. JSON.parse ловит только первый случай; второй ловит
   *  только явная проверка формы (cachedPayloadSchema). Оба трактуем как
   *  промах и, раз запись всё равно бесполезна, вычищаем её — иначе она бы
   *  вечно возвращала ту же проблему до истечения TTL. */
  function readCache(key: string): ScrapePayload | null {
    const raw = cache.get(key);
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      cache.delete(key);
      return null;
    }

    const result = cachedPayloadSchema.safeParse(parsed);
    if (!result.success) {
      cache.delete(key);
      return null;
    }
    return result.data;
  }

  async function scrape(args: { url: string; includeLinks?: boolean; refresh?: boolean }): Promise<ScrapePayload> {
    const includeLinks = args.includeLinks ?? false;
    const key = scrapeKey(args.url, { includeLinks });

    if (!args.refresh) {
      const hit = readCache(key);
      if (hit) return { ...hit, cached: true };
    }

    // Только успешный fetch/extract доходит до cache.set ниже: если fetcher
    // бросает (timeout/blocked/network/...), мы выходим из scrape() раньше
    // и ничего не пишем в кэш — иначе временный сбой сайта застревал бы
    // в кэше на весь TTL как будто это валидный контент.
    const fetched = await fetcher.fetch(args.url);
    const extracted = extract(fetched.html, fetched.finalUrl);

    const payload: ScrapePayload = {
      url: fetched.finalUrl,
      title: extracted.title,
      markdown: extracted.markdown,
      via: fetched.via,
      cached: false,
      ...(includeLinks ? { links: extracted.links.slice(0, 200) } : {}),
    };

    cache.set(key, JSON.stringify(payload), config.cacheTtlMs);
    return payload;
  }

  async function withContent(results: SearchResult[]): Promise<SearchResult[]> {
    const targets = results.slice(0, FETCH_CONTENT_MAX);
    const out = [...results];

    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < targets.length) {
        const i = cursor++;
        const r = targets[i]!;
        try {
          const p = await scrape({ url: r.url });
          out[i] = { ...r, content: p.markdown.slice(0, 8000) };
        } catch (e) {
          // Одна упавшая страница не должна валить весь поиск: остальные
          // результаты по-прежнему возвращаются, эта — с полем error.
          out[i] = { ...r, error: e instanceof Error ? e.message : String(e) };
        }
      }
    }
    await Promise.all(Array.from({ length: FETCH_CONTENT_CONCURRENCY }, worker));
    return out;
  }

  return {
    scrape,
    async search(args) {
      const limit = Math.min(args.limit ?? 5, 10);
      const results = await search.search(args.query, limit);
      return args.fetchContent ? withContent(results) : results;
    },
    async shutdown() {
      await browser.shutdown();
      cache.close();
    },
    isBrowserRunning() {
      return browser.isRunning();
    },
  };
}
