import { request } from 'undici';
import { HarvestError, type ErrorCode } from '../core/errors.js';
import type { ScrapePayload } from '../core/format.js';
import type { SearchResult } from '../core/search/types.js';

export interface BrowserOpenResult {
  sessionId: string;
  outline: string;
}

export interface BrowserSnapshotResult {
  outline: string;
}

export interface BrowserActionResult {
  changed: string;
}

interface ErrorBody { error?: { code?: ErrorCode; message?: string; detail?: Record<string, unknown> } }

// scrape/search — один HTTP-фетч плюс, максимум, один запуск браузера на
// рендер; 2 минуты с запасом хватает.
const DEFAULT_TIMEOUT_MS = 120_000;
// browser_* — open делает навигацию плюс CDP-снапшот полного дерева, а любое
// действие (click/fill/type/...) — снапшот "до", исполнение, паузу на
// перерисовку (settleAfterAction) и снапшот "после". Модели внутри демона
// больше нет (см. daemon/service.ts) — весь бюджет времени уходит на сам
// браузер, а не на круговые рейсы к LLM, но медленная страница (тяжёлый JS,
// долгая сеть) всё ещё может занять существенно больше дефолтных 120с,
// поэтому у browser_* остаётся отдельный, больший потолок.
const BROWSER_TIMEOUT_MS = 180_000;

export function createDaemonClient(baseUrl: string) {
  async function call<T>(path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    let res;
    try {
      res = await request(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (err) {
      const isTimeout =
        (err instanceof Error && (err as any).code === 'UND_ERR_HEADERS_TIMEOUT') ||
        (err instanceof Error && (err as any).code === 'UND_ERR_BODY_TIMEOUT') ||
        (err instanceof Error && err.message.includes('timeout'));
      if (isTimeout) {
        throw new HarvestError('timeout', 'Демон медленнее обычного или завис. Повтори попытку позже.');
      }
      throw new HarvestError(
        'daemon_down',
        'Демон webharvest не отвечает. Запусти его командой `webharvest start` и повтори',
      );
    }

    let payload: T & ErrorBody;
    try {
      payload = (await res.body.json()) as T & ErrorBody;
    } catch {
      // Something answered on that port/URL, but it wasn't JSON - another
      // dev server, a proxy's HTML error page, anything but the daemon.
      // Left unguarded, res.body.json() rejects with a raw SyntaxError that
      // escapes call() as a non-HarvestError, so the agent would see
      // "Не удалось: Unexpected token <..." instead of an actionable
      // message about what was actually reached.
      throw new HarvestError(
        'daemon_down',
        `На ${baseUrl}${path} ответил не демон webharvest (тело не JSON). ` +
          'Проверь, что порт не занят другим процессом, и перезапусти демон командой `webharvest start`.',
      );
    }
    if (res.statusCode >= 400) {
      const err = payload.error;
      throw new HarvestError(err?.code ?? 'network', err?.message ?? `Демон вернул ${res.statusCode}`, err?.detail);
    }
    return payload;
  }

  return {
    scrape: (body: unknown) => call<ScrapePayload>('/scrape', body),
    search: async (body: unknown) => (await call<{ results: SearchResult[] }>('/search', body)).results,
    browserOpen: (body: unknown) => call<BrowserOpenResult>('/browser/open', body, BROWSER_TIMEOUT_MS),
    browserSnapshot: (body: unknown) => call<BrowserSnapshotResult>('/browser/snapshot', body, BROWSER_TIMEOUT_MS),
    browserClick: (body: unknown) => call<BrowserActionResult>('/browser/click', body, BROWSER_TIMEOUT_MS),
    browserHover: (body: unknown) => call<BrowserActionResult>('/browser/hover', body, BROWSER_TIMEOUT_MS),
    browserFill: (body: unknown) => call<BrowserActionResult>('/browser/fill', body, BROWSER_TIMEOUT_MS),
    browserType: (body: unknown) => call<BrowserActionResult>('/browser/type', body, BROWSER_TIMEOUT_MS),
    browserPress: (body: unknown) => call<BrowserActionResult>('/browser/press', body, BROWSER_TIMEOUT_MS),
    browserSelect: (body: unknown) => call<BrowserActionResult>('/browser/select', body, BROWSER_TIMEOUT_MS),
    browserScroll: (body: unknown) => call<BrowserActionResult>('/browser/scroll', body, BROWSER_TIMEOUT_MS),
    browserClose: async (body: unknown) => { await call<Record<string, never>>('/browser/close', body, BROWSER_TIMEOUT_MS); },
  };
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;
