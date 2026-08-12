import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Page } from 'playwright';
import { Cache, scrapeKey } from '../core/cache.js';
import { DomainQueue } from '../core/politeness.js';
import { createBrowserPool } from '../core/browser.js';
import { createFetcher, DomainHints } from '../core/fetcher.js';
import { assertAllowedUrl } from '../core/url.js';
import { HarvestError } from '../core/errors.js';
import { createSearch, createSearxngProvider, createBraveProvider } from '../core/search/index.js';
import type { SearchProvider, SearchResult } from '../core/search/types.js';
import { truncateMarkdown, type ScrapePayload } from '../core/format.js';
import { createSessionPool } from '../core/session-pool.js';
import { captureSnapshot } from '../core/a11y/capture.js';
import { diffOutlines } from '../core/a11y/diff.js';
import type { A11ySnapshot } from '../core/a11y/types.js';
import { executeAction } from '../core/actions.js';
import { createLlmClient } from '../core/llm/client.js';
import { observe, planAct, planActStepTwo, extract, type Variables } from '../core/inference.js';
import type { ObservedElement } from '../core/llm/schemas.js';
import type { Config } from './config.js';

export interface BrowserOpenResult {
  sessionId: string;
  outline: string;
}

export interface BrowserObserveResult {
  elements: ObservedElement[];
}

export interface BrowserActResult {
  performed: boolean;
  description: string;
  changed: string;
}

export interface Service {
  scrape(args: { url: string; includeLinks?: boolean; refresh?: boolean }): Promise<ScrapePayload>;
  search(args: { query: string; limit?: number; fetchContent?: boolean }): Promise<SearchResult[]>;
  shutdown(): Promise<void>;
  /** Optional: whether the browser pool currently has a live instance.
   *  Used by GET /health for an honest readiness signal. Optional so stubs
   *  in tests aren't forced to implement it. */
  isBrowserRunning?(): boolean;
  // Browser-use методы объявлены опциональными по той же причине, что и
  // isBrowserRunning выше: существующие тестовые заглушки Service (например,
  // test/daemon/http.test.ts) не обязаны их реализовывать.
  browserOpen?(args: { url: string }): Promise<BrowserOpenResult>;
  browserObserve?(args: { sessionId: string; instruction: string }): Promise<BrowserObserveResult>;
  browserAct?(args: {
    sessionId: string;
    instruction: string;
    variables?: Variables;
  }): Promise<BrowserActResult>;
  browserExtract?(args: {
    sessionId: string;
    instruction: string;
    schema: Record<string, unknown>;
  }): Promise<unknown>;
  browserClose?(args: { sessionId: string }): Promise<void>;
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
  status: z.number(),
  links: z.array(z.object({ href: z.string(), text: z.string() })).optional(),
});

// Search's fetchContent path truncates each page's markdown before embedding
// it in the result list — the same 8000-char budget as before, but now run
// through the same truncateMarkdown() formatScrape uses, so formatSearch can
// render an honest "truncated" notice instead of silently stopping mid-word.
const SEARCH_CONTENT_MAX_CHARS = 8000;

export function createService(config: Config): Service {
  if (config.cachePath !== ':memory:') {
    mkdirSync(dirname(config.cachePath), { recursive: true });
  }
  const cache = new Cache(config.cachePath);

  // Expired rows were previously only ever removed lazily, on a read that
  // happened to hit that exact key (Cache.get()'s own expiry check) — a key
  // nobody re-requests before its TTL just sits in ~/.webharvest/cache.db
  // forever, growing the file monotonically. Purge once at startup (clears
  // anything that expired while the daemon was down) and then hourly while
  // running. unref() so this timer never keeps the process alive on its own.
  cache.purgeExpired();
  const purgeTimer = setInterval(() => cache.purgeExpired(), 60 * 60_000);
  purgeTimer.unref();

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

  // Browser use: отдельный пул долгоживущих страниц (session-pool.ts), не
  // путать с browser (browser.ts) выше — тот открывает/закрывает страницу на
  // один рендер и состояния между вызовами не хранит.
  const sessions = createSessionPool();
  const llm = createLlmClient();
  // Снапшот последнего захвата страницы — нужен act/extract для резолва
  // адресов элементов. Живёт рядом с сессией, но не в самом SessionPool
  // (его контракт этой задачей не трогаем): отдельная карта той же
  // продолжительности жизни, вычищаемая по sessionId вместе с сессией.
  const snapshots = new Map<string, A11ySnapshot>();

  /** Пауза на перерисовку после действия — без неё диф пуст на всём, что
   *  рисуется через JS. Тот же приём, что doRender в core/browser.ts. */
  async function settleAfterAction(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

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
    // Validated up front, before scrapeKey() ever touches the url: scrapeKey
    // -> normalizeUrl() does a bare `new URL(input)` with no try/catch, so a
    // malformed url (the single most likely mistake the agent makes) used to
    // throw a raw TypeError that the daemon's generic error handler could only
    // report as 500 "internal — see logs". This throws the same
    // HarvestError('invalid_url', ...) that fetcher.fetch() would eventually
    // have thrown anyway — this just surfaces it before wasting a cache
    // lookup key computation on an input that was never going to fetch.
    //
    // Mirrors fetcher's own validate(): under allowPrivate (tests only —
    // never set from config.json) skip the SSRF/host checks too, so this
    // pre-check can't reject a loopback url that the real fetch would have
    // allowed through.
    if (config.allowPrivate) {
      try {
        new URL(args.url);
      } catch {
        throw new HarvestError('invalid_url', `Не похоже на URL: ${args.url}`);
      }
    } else {
      assertAllowedUrl(args.url);
    }

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

    // A response we successfully downloaded/rendered but that the origin
    // itself flagged as a failure (404/410/451/500/...) must never be
    // treated as content: shouldEscalate() only reacts to the bot-defense
    // trio (403/429/503), so a styled "page not found" or "server error"
    // page sails through extraction and would otherwise be cached for the
    // full TTL and handed to the agent as if it were the real article.
    if (fetched.status >= 400) {
      throw new HarvestError(
        'upstream_error',
        `Сервер вернул ошибку ${fetched.status}: ${fetched.finalUrl}`,
        { status: fetched.status },
      );
    }

    // fetcher.fetch() already ran extract() once, to decide whether to
    // escalate to the browser — reusing that result here (rather than
    // calling extract() a second time on the same final HTML) halves the
    // JSDOM/Readability/Defuddle work per scrape.
    const extracted = fetched.extracted;

    const payload: ScrapePayload = {
      url: fetched.finalUrl,
      title: extracted.title,
      markdown: extracted.markdown,
      via: fetched.via,
      cached: false,
      status: fetched.status,
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
          // formatScrape tells the truth about truncation via truncateMarkdown
          // + a rendered notice; this path used to slice raw and print it
          // verbatim, so the agent could read a page cut off mid-sentence
          // with no indication it wasn't the whole thing. Same budget (8000
          // chars), same honesty.
          const { text, truncated, remaining } = truncateMarkdown(p.markdown, SEARCH_CONTENT_MAX_CHARS);
          out[i] = { ...r, content: text, ...(truncated ? { truncated: true, remaining } : {}) };
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

  async function browserOpen(args: { url: string }): Promise<BrowserOpenResult> {
    // Тот же SSRF-барьер, что и у scrape() выше: без него browser_open даёт
    // модели произвольный переход на приватные/локальные адреса в обход
    // защиты, которую фетчер уже применяет к обычному чтению страниц.
    if (config.allowPrivate) {
      try {
        new URL(args.url);
      } catch {
        throw new HarvestError('invalid_url', `Не похоже на URL: ${args.url}`);
      }
    } else {
      assertAllowedUrl(args.url);
    }

    const session = await sessions.open(args.url);
    // captureSnapshot может бросить (например, пустое дерево) — раз сессия
    // уже открыта, а вызвавшему мы её id так и не отдали, закрыть её должны
    // мы сами, иначе живая страница останется висеть без единого владельца.
    let snapshot: A11ySnapshot;
    try {
      snapshot = await captureSnapshot(session.page);
    } catch (e) {
      await sessions.close(session.id);
      throw e;
    }
    snapshots.set(session.id, snapshot);
    return { sessionId: session.id, outline: snapshot.outline };
  }

  async function browserObserve(args: {
    sessionId: string;
    instruction: string;
  }): Promise<BrowserObserveResult> {
    const session = sessions.get(args.sessionId);
    // Пересниматься перед каждым инференсом обязательно: страница могла
    // измениться со времени последнего снапшота (или это вообще первый вызов
    // после browser_open на другой странице после навигации внутри act).
    const snapshot = await captureSnapshot(session.page);
    snapshots.set(session.id, snapshot);
    const elements = await observe({ llm }, { instruction: args.instruction, snapshot });
    return { elements };
  }

  async function browserAct(args: {
    sessionId: string;
    instruction: string;
    variables?: Variables;
  }): Promise<BrowserActResult> {
    const session = sessions.get(args.sessionId);
    const before = await captureSnapshot(session.page);

    const plan = await planAct({ llm }, { instruction: args.instruction, snapshot: before, variables: args.variables });
    if (!plan) {
      snapshots.set(session.id, before);
      return { performed: false, description: '', changed: '' };
    }

    await executeAction(session.page, plan.first, before);
    await settleAfterAction(session.page);
    let after = await captureSnapshot(session.page);

    if (plan.needsSecondStep) {
      const second = await planActStepTwo(
        { llm },
        {
          originalInstruction: args.instruction,
          previousDescription: plan.description,
          snapshot: after,
          variables: args.variables,
        },
      );
      if (second) {
        await executeAction(session.page, second, after);
        await settleAfterAction(session.page);
        after = await captureSnapshot(session.page);
      }
    }

    snapshots.set(session.id, after);
    return {
      performed: true,
      description: plan.description,
      changed: diffOutlines(before.outline, after.outline),
    };
  }

  async function browserExtract(args: {
    sessionId: string;
    instruction: string;
    schema: Record<string, unknown>;
  }): Promise<unknown> {
    const session = sessions.get(args.sessionId);
    const snapshot = await captureSnapshot(session.page);
    snapshots.set(session.id, snapshot);
    return extract({ llm }, { instruction: args.instruction, snapshot, schema: args.schema });
  }

  async function browserClose(args: { sessionId: string }): Promise<void> {
    await sessions.close(args.sessionId);
    snapshots.delete(args.sessionId);
  }

  return {
    scrape,
    async search(args) {
      const limit = Math.min(args.limit ?? 5, 10);
      const results = await search.search(args.query, limit);
      return args.fetchContent ? withContent(results) : results;
    },
    browserOpen,
    browserObserve,
    browserAct,
    browserExtract,
    browserClose,
    async shutdown() {
      clearInterval(purgeTimer);
      await browser.shutdown();
      await sessions.shutdown();
      cache.close();
    },
    isBrowserRunning() {
      return browser.isRunning();
    },
  };
}
