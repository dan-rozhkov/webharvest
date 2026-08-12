import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Page } from 'playwright';
import { Cache, scrapeKey } from '../core/cache.js';
import { DomainQueue } from '../core/politeness.js';
import { createBrowserPool } from '../core/browser.js';
import { createFetcher, DomainHints } from '../core/fetcher.js';
import { assertAllowedUrl, assertPublicHost } from '../core/url.js';
import { HarvestError } from '../core/errors.js';
import { createSearch, createSearxngProvider, createBraveProvider } from '../core/search/index.js';
import type { SearchProvider, SearchResult } from '../core/search/types.js';
import { truncateMarkdown, type ScrapePayload } from '../core/format.js';
import { createSessionPool, type BrowserSession } from '../core/session-pool.js';
import { captureSnapshot } from '../core/a11y/capture.js';
import { diffOutlines } from '../core/a11y/diff.js';
import { redactSecrets, redactOutlineSecrets } from '../core/a11y/format.js';
import type { A11ySnapshot } from '../core/a11y/types.js';
import {
  executeAction,
  substituteVariables,
  type ActionRequest,
  type SupportedAction,
  type Variables,
} from '../core/actions.js';
import type { Config } from './config.js';

export interface BrowserOpenResult {
  sessionId: string;
  outline: string;
}

export interface BrowserSnapshotResult {
  outline: string;
}

/** Общая форма ответа каждого действия: агенту важно только то, что
 *  изменилось на странице (диф outline до/после) — сам факт исполнения
 *  подтверждается уже тем, что вызов не бросил исключение. */
export interface BrowserActionResult {
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
  /** Свежий outline той же страницы — без выполнения действия. Нужен, чтобы
   *  агент мог посмотреть на текущее состояние страницы (например, после
   *  того как сам открыл её или после навигации, которую не отследить
   *  дифом), не открывая сессию заново. */
  browserSnapshot?(args: { sessionId: string }): Promise<BrowserSnapshotResult>;
  browserClick?(args: { sessionId: string; elementId: string }): Promise<BrowserActionResult>;
  browserHover?(args: { sessionId: string; elementId: string }): Promise<BrowserActionResult>;
  browserFill?(args: {
    sessionId: string;
    elementId: string;
    text: string;
    variables?: Variables;
  }): Promise<BrowserActionResult>;
  browserType?(args: {
    sessionId: string;
    elementId: string;
    text: string;
    variables?: Variables;
  }): Promise<BrowserActionResult>;
  browserPress?(args: { sessionId: string; elementId: string; key: string }): Promise<BrowserActionResult>;
  browserSelect?(args: { sessionId: string; elementId: string; value: string }): Promise<BrowserActionResult>;
  browserScroll?(args: { sessionId: string; elementId: string; percent: string }): Promise<BrowserActionResult>;
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

/**
 * Тот же барьер, что `fetcher.ts` называет `validate()`: синтаксическая
 * проверка формы (`assertAllowedUrl`) плюс DNS-резолв и проверка адресов
 * (`assertPublicHost`) — вместе они и есть полная защита от SSRF, которую
 * `scrape()` в итоге получает через фетчер. `allowPrivate` — тот же выход
 * только для тестов, что и у фетчера: приватные адреса пропускаются мимо
 * обеих проверок, остаётся только валидность самого URL.
 *
 * Используется дважды для browser use: один раз на входном URL перед
 * открытием сессии (дёшево отбрасывает явно недопустимый адрес до траты
 * страницы браузера) и один раз на текущем `page.url()` после каждой
 * навигации — `page.goto()`/переход по ссылке следуют редиректам (HTTP и
 * JS) без ревалидации, так что урл, прошедший первую проверку, может
 * увести уже открытую сессию на приватный адрес чуть позже.
 */
export async function assertUrlIsSafe(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) {
    try {
      new URL(url);
    } catch {
      throw new HarvestError('invalid_url', `Не похоже на URL: ${url}`);
    }
    return;
  }
  const u = assertAllowedUrl(url);
  await assertPublicHost(u.hostname);
}

/**
 * Проверяет фактический url живой сессии перед тем, как её содержимое
 * попадёт в снапшот (а значит — в промпт модели и в ответ инструмента).
 * Нужна на входе в каждый browser-use метод и сразу после любого действия,
 * которое могло инициировать навигацию (см. assertUrlIsSafe выше): страница
 * персистентна между вызовами, поэтому проверки на входном URL в browser_open
 * недостаточно — редирект (или клик, отправка формы, JS-навигация внутри
 * act) может увести уже открытую страницу на приватный адрес уже после неё.
 * При нарушении сессия закрывается сразу здесь, до возврата вызывающему —
 * значит, содержимое приватного адреса ни разу не долетает ни до модели, ни
 * до текста ответа инструмента.
 *
 * `close` вынесен параметром (а не захвачен из SessionPool напрямую), чтобы
 * это можно было проверить юнит-тестом на фейковой странице/сессии, не
 * поднимая настоящий браузер: единственная реальная зависимость —
 * `session.page.url()` и функция закрытия.
 *
 * Закрывать сессию можно только на фактическое нарушение политики
 * (`invalid_url` — приватный/внутренний адрес или синтаксически неверный
 * url), а не на любой throw. `assertPublicHost` внутри `assertUrlIsSafe`
 * бросает `network`, когда DNS-резолв просто не удался (сбой резолвера,
 * кратковременная недоступность сети) — это не значит, что страница
 * небезопасна, значит лишь, что прямо сейчас нельзя проверить. Закрывать
 * живую, уже аутентифицированную сессию (а с ней — все её cookies) на
 * временный сбой резолвера было бы явно непропорциональной реакцией:
 * ошибка должна дойти до вызывающего, но сессия должна пережить её.
 */
export async function assertSessionUrlSafePure(
  session: { id: string; page: { url(): string } },
  allowPrivate: boolean,
  close: (id: string) => Promise<void>,
): Promise<void> {
  try {
    await assertUrlIsSafe(session.page.url(), allowPrivate);
  } catch (e) {
    if (HarvestError.is(e) && e.code === 'invalid_url') {
      await close(session.id);
    }
    throw e;
  }
}

/**
 * Копит переданные variables в секретах сессии (см. JSDoc BrowserSession.
 * secrets) вместо того, чтобы держать их только локально в одном вызове
 * действия — иначе следующее действие/снапшот на той же сессии не знали бы,
 * что редактировать. Вызывается в performAction до захвата любого снапшота:
 * даже снапшот "before" самого этого вызова должен прийти уже вычищенным от
 * значений, подставленных предыдущими действиями на этой же странице.
 * Отдельная экспортируемая функция (как assertUrlIsSafe/
 * assertSessionUrlSafePure выше) — чтобы накопление секретов по сессии можно
 * было проверить юнит-тестом на голой Map, без реального браузера.
 *
 * Добавляет значение в МНОЖЕСТВО значений этого имени, а не перезаписывает
 * его: агент вправе переиспользовать одно и то же имя переменной в двух
 * разных вызовах с разными значениями (например, `%token%` сперва в одно
 * поле, потом в другое) — `Map<string, string>.set()` затирал бы значение
 * первого вызова, и оно, всё ещё живущее в DOM того первого поля, переставало
 * бы редактироваться из следующего снапшота. См. JSDoc `BrowserSession.
 * secrets` в session-pool.ts.
 */
export function registerSecrets(session: Pick<BrowserSession, 'secrets'>, variables?: Variables): void {
  if (!variables) return;
  for (const [name, value] of Object.entries(variables)) {
    let values = session.secrets.get(name);
    if (!values) {
      values = new Set();
      session.secrets.set(name, values);
    }
    values.add(value);
  }
}

/**
 * Применяет redactOutlineSecrets() (a11y/format.ts) к outline снапшота — не
 * redactSecrets(): outline имеет предсказуемую построчную структуру (адрес
 * узла всегда стоит до ` = значение`, см. JSDoc redactOutlineSecrets), и
 * только узкая замена внутри сегмента значения гарантированно не может
 * задеть адреса. Снапшот без секретов на сессии возвращается как есть — тот
 * же снапшот, без лишней аллокации; лишний проход по строке при пустой карте
 * секретов был бы чистым накладным расходом на подавляющем большинстве
 * вызовов (сессия без единого browser_fill/browser_type с variables).
 */
export function redactSnapshot(snapshot: A11ySnapshot, secrets: ReadonlyMap<string, ReadonlySet<string>>): A11ySnapshot {
  if (secrets.size === 0) return snapshot;
  return { ...snapshot, outline: redactOutlineSecrets(snapshot.outline, secrets) };
}

/**
 * Редактирует секреты из текста HarvestError перед тем, как она уйдёт выше:
 * playwright иногда эхом повторяет переданный аргумент действия в тексте
 * исключения (например, «No option matched "<value>"» при промахе
 * selectOptionFromDropdown) — то же место утечки, что и outline, только через
 * текст ошибки, а не через снапшот. code/detail не трогаем: только message
 * может содержать секрет.
 *
 * Использует redactSecrets() (глобальная замена по всему тексту), а не
 * redactOutlineSecrets(): текст ошибки playwright не имеет структуры outline
 * (никакого предсказуемого " = "), поэтому у узкой замены здесь просто нет
 * сегмента, за который можно зацепиться — сообщение осталось бы
 * нередактированным. Ложноположительная порча случайного текста ошибки не
 * так опасна, как раскрытие секрета: там нет "адресов" узлов, которые можно
 * сломать.
 */
export function redactHarvestError(e: HarvestError, secrets: ReadonlyMap<string, ReadonlySet<string>>): HarvestError {
  if (secrets.size === 0) return e;
  return new HarvestError(e.code, redactSecrets(e.message, secrets), e.detail);
}

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

  // Браузер для рендера. Оба пула делят канал запуска и корень профилей из
  // конфига, но подкаталоги у каждого свои: у session-pool живые сессии
  // browser use (cookies, localStorage), у browser — только то, что захочет
  // пережить рестарт сам рендер. Раздельные userDataDir, чтобы закрытие
  // одного пула (например, по простою) не сносило сессии другого.
  const browser = createBrowserPool({
    idleTimeoutMs: config.idleTimeoutMs,
    channel: config.browserChannel,
    profileDir: config.browserProfileDir ? join(config.browserProfileDir, 'scrape') : undefined,
  });
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
  const sessions = createSessionPool({
    idleTimeoutMs: config.idleTimeoutMs,
    channel: config.browserChannel,
    profileDir: config.browserProfileDir ? join(config.browserProfileDir, 'sessions') : undefined,
  });

  /** Пауза на перерисовку после действия — без неё диф пуст на всём, что
   *  рисуется через JS. Тот же приём, что doRender в core/browser.ts. */
  async function settleAfterAction(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  async function assertSessionUrlSafe(session: BrowserSession): Promise<void> {
    await assertSessionUrlSafePure(session, config.allowPrivate, (id) => sessions.close(id));
  }

  /**
   * captureSnapshot() ничего не знает про сессии и секреты (он работает с
   * голой Page — так и задумано, см. JSDoc capture.ts), поэтому редактирование
   * подставленных значений происходит здесь, сразу после захвата и ДО того,
   * как outline попадёт куда-либо ещё: в diffOutlines() или в текст, который
   * уходит вызывающему агенту. Один снапшот — один проход редактирования.
   */
  async function captureRedactedSnapshot(page: Page, session: BrowserSession): Promise<A11ySnapshot> {
    return redactSnapshot(await captureSnapshot(page), session.secrets);
  }

  /**
   * Оборачивает executeAction() так, чтобы и текст исключения не мог пронести
   * подставленное значение наружу — см. JSDoc redactHarvestError выше.
   */
  async function executeActionSafely(
    page: Page,
    req: ActionRequest,
    snapshot: A11ySnapshot,
    session: BrowserSession,
  ): Promise<void> {
    try {
      await executeAction(page, req, snapshot);
    } catch (e) {
      if (HarvestError.is(e)) throw redactHarvestError(e, session.secrets);
      throw e;
    }
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

  /**
   * Обёртка над `sessions.get(id)`, которая гарантирует парный
   * `sessions.release(id)` (см. JSDoc release() в session-pool.ts) даже если
   * `fn` бросает — иначе сессия осталась бы навсегда помеченной занятой и
   * никогда не снялась бы ни по простою, ни вытеснением. Не используется в
   * browserOpen(): там сессия создаётся уже занятой самим `sessions.open()`
   * и либо закрывается целиком на ошибке (`sessions.close()`), либо
   * освобождается явно перед успешным return — оба пути ниже написаны прямо,
   * без этой обёртки, потому что на ошибке открытия сессию нужно не
   * освободить, а закрыть.
   */
  async function withSession<T>(sessionId: string, fn: (session: BrowserSession) => Promise<T>): Promise<T> {
    const session = sessions.get(sessionId);
    try {
      return await fn(session);
    } finally {
      sessions.release(session.id);
    }
  }

  async function browserOpen(args: { url: string }): Promise<BrowserOpenResult> {
    // Дёшево отбрасывает явно недопустимый адрес до открытия страницы
    // браузера — та же глубина проверки (форма + DNS), что и у scrape().
    await assertUrlIsSafe(args.url, config.allowPrivate);

    const session = await sessions.open(args.url);
    // С этой точки и до `return` сессия открыта, но её id ещё не отдан
    // вызывающему — значит, закрыть её при любом сбое можем только мы сами,
    // иначе страница и Chromium останутся висеть без единого владельца.
    // assertSessionUrlSafe уже закрывает сессию сама, но только на
    // `invalid_url` — на `network` (assertPublicHost не смог зарезолвить
    // хост, см. url.ts) она намеренно оставляет сессию живой и просто
    // пробрасывает ошибку выше (см. её JSDoc). Раньше эта ошибка улетала
    // отсюда наверх без закрытия сессии — сама сессия оставалась висеть
    // осиротевшей, потому что id так и не был возвращён. try/catch здесь
    // закрывает сессию на любое исключение из обеих проверок; двойное
    // закрытие безопасно — sessions.close()/drop() идемпотентны (просто
    // не находят сессию в map повторно).
    try {
      // Пост-навигационная проверка: page.goto() внутри sessions.open() мог
      // пройти по редиректу на приватный адрес уже ПОСЛЕ проверки выше,
      // которая видела только исходный url.
      await assertSessionUrlSafe(session);
      // captureSnapshot может бросить (например, пустое дерево).
      const snapshot = await captureRedactedSnapshot(session.page, session);
      // Сессия создаётся занятой (session-pool.ts, open()) — снимаем это
      // здесь, на единственном успешном пути: вызывающему уже отдан id, и с
      // этого момента sweep/eviction снова вправе её тронуть, как и любую
      // другую свободную сессию.
      sessions.release(session.id);
      return { sessionId: session.id, outline: snapshot.outline };
    } catch (e) {
      await sessions.close(session.id);
      throw e;
    }
  }

  async function browserSnapshot(args: { sessionId: string }): Promise<BrowserSnapshotResult> {
    return withSession(args.sessionId, async (session) => {
      await assertSessionUrlSafe(session);
      const snapshot = await captureRedactedSnapshot(session.page, session);
      return { outline: snapshot.outline };
    });
  }

  /**
   * Общий ход одного детерминированного действия: снапшот "до", подстановка
   * variables, исполнение, пауза на перерисовку, повторная проверка адреса
   * (действие само могло быть навигацией — клик по ссылке, отправка формы),
   * снапшот "после", диф. Раньше это делал planAct/planActStepTwo — модель
   * внутри демона выбирала elementId/method/arguments по инструкции; теперь
   * их называет вызывающий агент напрямую (он же видит дерево страницы),
   * поэтому здесь просто исполнение без планирования.
   */
  async function performAction(
    session: BrowserSession,
    method: SupportedAction,
    elementId: string,
    args: string[],
    variables?: Variables,
  ): Promise<BrowserActionResult> {
    await assertSessionUrlSafe(session);
    // До снапшота "до": значение могло попасть на страницу более ранним
    // действием на этой же сессии, и даже "before" обязан прийти уже чистым.
    registerSecrets(session, variables);
    const before = await captureRedactedSnapshot(session.page, session);

    const req: ActionRequest = { elementId, method, arguments: substituteVariables(args, variables) };
    await executeActionSafely(session.page, req, before, session);
    await settleAfterAction(session.page);
    await assertSessionUrlSafe(session);
    const after = await captureRedactedSnapshot(session.page, session);

    return { changed: diffOutlines(before.outline, after.outline) };
  }

  async function browserClick(args: { sessionId: string; elementId: string }): Promise<BrowserActionResult> {
    return withSession(args.sessionId, (session) => performAction(session, 'click', args.elementId, []));
  }

  async function browserHover(args: { sessionId: string; elementId: string }): Promise<BrowserActionResult> {
    return withSession(args.sessionId, (session) => performAction(session, 'hover', args.elementId, []));
  }

  async function browserFill(args: {
    sessionId: string;
    elementId: string;
    text: string;
    variables?: Variables;
  }): Promise<BrowserActionResult> {
    return withSession(args.sessionId, (session) =>
      performAction(session, 'fill', args.elementId, [args.text], args.variables),
    );
  }

  async function browserType(args: {
    sessionId: string;
    elementId: string;
    text: string;
    variables?: Variables;
  }): Promise<BrowserActionResult> {
    return withSession(args.sessionId, (session) =>
      performAction(session, 'type', args.elementId, [args.text], args.variables),
    );
  }

  async function browserPress(args: { sessionId: string; elementId: string; key: string }): Promise<BrowserActionResult> {
    return withSession(args.sessionId, (session) => performAction(session, 'press', args.elementId, [args.key]));
  }

  async function browserSelect(args: { sessionId: string; elementId: string; value: string }): Promise<BrowserActionResult> {
    return withSession(args.sessionId, (session) =>
      performAction(session, 'selectOptionFromDropdown', args.elementId, [args.value]),
    );
  }

  async function browserScroll(args: { sessionId: string; elementId: string; percent: string }): Promise<BrowserActionResult> {
    return withSession(args.sessionId, (session) =>
      performAction(session, 'scrollTo', args.elementId, [args.percent]),
    );
  }

  async function browserClose(args: { sessionId: string }): Promise<void> {
    await sessions.close(args.sessionId);
  }

  return {
    scrape,
    async search(args) {
      const limit = Math.min(args.limit ?? 5, 10);
      const results = await search.search(args.query, limit);
      return args.fetchContent ? withContent(results) : results;
    },
    browserOpen,
    browserSnapshot,
    browserClick,
    browserHover,
    browserFill,
    browserType,
    browserPress,
    browserSelect,
    browserScroll,
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
