/**
 * Ожидание «страница успокоилась» — вместо `networkidle` и фиксированных пауз.
 *
 * `waitForLoadState('networkidle')` не наступает на страницах с long-poll,
 * аналитикой или вебсокетами (каждое действие сжигало весь таймаут), а на
 * тихой странице ему всё равно нужно 500 мс покоя. Здесь считаем запросы сами
 * и ждём тишины только по тем, что начались ПОСЛЕ действия, игнорируя
 * заведомо бесконечные (websocket/eventsource/beacon) и зависшие дольше
 * STALE_MS. Тот же подход, что `settleAfterClick` в pen-editor-desktop.
 */
import type { Page, Request } from 'playwright';

/** Типы запросов, которые не говорят о том, что дерево страницы ещё
 *  меняется: бесконечные (websocket/eventsource), маячки, и ресурсы, которые
 *  не трогают DOM (картинки/шрифты/медиа — alt и подписи уже в разметке). */
const IGNORED_TYPES = new Set(['websocket', 'eventsource', 'ping', 'manifest', 'image', 'font', 'media', 'texttrack']);
/** Запрос, висящий дольше этого, — long-poll/стрим, а не загрузка данных. */
const STALE_MS = 2000;
const POLL_MS = 20;

export interface NetworkTracker {
  /** Монотонный номер последнего учтённого запроса: база для pendingSince. */
  generation(): number;
  /** Незавершённые запросы, начатые после `gen` и моложе STALE_MS. */
  pendingSince(gen: number): number;
  /** Время последнего старта или завершения учтённого запроса после `gen`. */
  lastActivitySince(gen: number): number;
  dispose(): void;
}

export function trackNetwork(page: Page): NetworkTracker {
  let gen = 0;
  const pending = new Map<Request, { gen: number; startedAt: number }>();
  // Активность привязана к поколению: запрос, начатый до действия (long-poll
  // с открытия страницы), своим завершением не должен продлевать ожидание.
  let lastActivity = { gen: 0, at: 0 };

  const onRequest = (r: Request): void => {
    if (IGNORED_TYPES.has(r.resourceType())) return;
    gen += 1;
    pending.set(r, { gen, startedAt: Date.now() });
    lastActivity = { gen, at: Date.now() };
  };
  const onDone = (r: Request): void => {
    const p = pending.get(r);
    if (!p) return;
    pending.delete(r);
    lastActivity = { gen: p.gen, at: Date.now() };
  };
  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  return {
    generation: () => gen,
    pendingSince(since) {
      const now = Date.now();
      let n = 0;
      for (const p of pending.values()) {
        if (p.gen > since && now - p.startedAt < STALE_MS) n += 1;
      }
      return n;
    },
    lastActivitySince: (since) => (lastActivity.gen > since ? lastActivity.at : 0),
    dispose() {
      page.off('request', onRequest);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
      pending.clear();
    },
  };
}

/**
 * Ждёт, пока запросы, начатые после `sinceGen`, закончатся и сеть простоит
 * `quietMs`. Отсчёт тишины — от `from` (обычно конец действия), так что без
 * единого запроса ожидание равно ровно `quietMs`. Никогда не бросает: это
 * best-effort, по `capMs` просто возвращаемся.
 */
export async function waitForNetworkQuiet(
  page: Page,
  tracker: NetworkTracker,
  opts: { sinceGen: number; quietMs: number; capMs: number; from?: number },
): Promise<void> {
  const from = opts.from ?? Date.now();
  const deadline = Date.now() + opts.capMs;
  while (Date.now() < deadline && !page.isClosed()) {
    const idleFrom = Math.max(from, tracker.lastActivitySince(opts.sinceGen));
    if (tracker.pendingSince(opts.sinceGen) === 0 && Date.now() - idleFrom >= opts.quietMs) return;
    await sleep(POLL_MS);
  }
}

export interface NavigationWatch {
  /** Навигация главного фрейма началась (ушёл navigation-запрос или сменился документ). */
  started(): boolean;
  /** Новый документ закоммичен (или навигация внутри документа). */
  committed(): boolean;
  /** Навигационный запрос завершился без коммита (загрузка файла, 204). */
  abandoned(): boolean;
  dispose(): void;
}

/** Вооружается ДО действия: иначе быстрый переход по ссылке проскочит мимо. */
export function watchNavigation(page: Page): NavigationWatch {
  let started = false;
  let committed = false;
  let navRequest: Request | null = null;
  let abandoned = false;
  const main = page.mainFrame();

  const onRequest = (r: Request): void => {
    if (r.isNavigationRequest() && r.frame() === main) {
      started = true;
      navRequest = r;
      abandoned = false;
    }
  };
  const onNavigated = (f: unknown): void => {
    if (f === main) {
      started = true;
      committed = true;
    }
  };
  const onFailed = (r: Request): void => {
    if (r === navRequest) abandoned = true;
  };
  page.on('request', onRequest);
  page.on('framenavigated', onNavigated);
  page.on('requestfailed', onFailed);

  return {
    started: () => started,
    committed: () => committed,
    abandoned: () => abandoned,
    dispose() {
      page.off('request', onRequest);
      page.off('framenavigated', onNavigated);
      page.off('requestfailed', onFailed);
    },
  };
}

export type SettleKind = 'pointer' | 'input';

/** Сколько ждём старта навигации, прежде чем решить, что её не будет. */
const NAV_START_GRACE_MS = 80;
const QUIET_MS: Record<SettleKind, number> = { pointer: 100, input: 50 };
const ACTION_QUIET_CAP_MS = 3000;
const NAV_COMMIT_CAP_MS = 8000;
/** После загрузки документа — короткое окно на дорисовку данными (SPA). */
export const LOAD_QUIET_MS = 100;
export const LOAD_QUIET_CAP_MS = 1000;

/**
 * Ожидание после действия. `pointer` (click/press) может увести страницу —
 * ждём старта навигации NAV_START_GRACE_MS; `input` (fill/type/select/scroll/
 * hover) почти никогда не навигирует и ждёт только своей сетевой тишины.
 * Возвращает, была ли навигация главного фрейма.
 */
export async function settleAfterAction(
  page: Page,
  tracker: NetworkTracker,
  nav: NavigationWatch,
  kind: SettleKind,
  sinceGen: number,
): Promise<{ navigated: boolean }> {
  const actionEnd = Date.now();
  if (kind === 'pointer') {
    while (!nav.started() && Date.now() - actionEnd < NAV_START_GRACE_MS) await sleep(10);
  }

  if (nav.started()) {
    const deadline = Date.now() + NAV_COMMIT_CAP_MS;
    while (!nav.committed() && !nav.abandoned() && Date.now() < deadline && !page.isClosed()) await sleep(POLL_MS);
    if (nav.committed()) {
      await page.waitForLoadState('domcontentloaded', { timeout: NAV_COMMIT_CAP_MS }).catch(() => {});
      await waitForNetworkQuiet(page, tracker, { sinceGen, quietMs: LOAD_QUIET_MS, capMs: LOAD_QUIET_CAP_MS });
      return { navigated: true };
    }
  }

  await waitForNetworkQuiet(page, tracker, {
    sinceGen,
    quietMs: QUIET_MS[kind],
    capMs: ACTION_QUIET_CAP_MS,
    from: actionEnd,
  });
  return { navigated: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
