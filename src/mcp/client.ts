import { request } from 'undici';
import { HarvestError, type ErrorCode } from '../core/errors.js';
import type { ScrapePayload } from '../core/format.js';
import type { SearchResult } from '../core/search/types.js';
import type { ObservedElement } from '../core/llm/schemas.js';

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

interface ErrorBody { error?: { code?: ErrorCode; message?: string; detail?: Record<string, unknown> } }

// scrape/search — один HTTP-фетч плюс, максимум, один запуск браузера на
// рендер; 2 минуты с запасом хватает.
const DEFAULT_TIMEOUT_MS = 120_000;
// browser_act (и остальные browser_* — extract идёт с effort: 'medium' на
// полное дерево, open делает навигацию плюс снапшот) может сделать до двух
// круговых рейсов к Opus 5 (адаптивное мышление, max_tokens: 16000,
// нестриминговый ответ) плюс несколько CDP-снапшотов и settle-паузы. У
// самого SDK таймаут на вызов модели — 10 минут; выставлять демону таймаут
// короче него бессмысленно — можно словить локальный timeout, пока демон
// всё ещё честно ждёт ответа модели. Ставим тот же потолок.
//
// Это не устраняет риск двойной отправки целиком: если демон всё же не
// уложится и в эти 10 минут, агент получит timeout и может повторить
// действие, а исполненное на сервере действие к этому моменту уже могло
// пройти — идемпотентности на этом пути нет. Таймаут снижает вероятность
// такого гонки, но не закрывает её полностью.
const BROWSER_TIMEOUT_MS = 600_000;

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
    browserObserve: (body: unknown) => call<BrowserObserveResult>('/browser/observe', body, BROWSER_TIMEOUT_MS),
    browserAct: (body: unknown) => call<BrowserActResult>('/browser/act', body, BROWSER_TIMEOUT_MS),
    browserExtract: (body: unknown) => call<unknown>('/browser/extract', body, BROWSER_TIMEOUT_MS),
    browserClose: async (body: unknown) => { await call<Record<string, never>>('/browser/close', body, BROWSER_TIMEOUT_MS); },
  };
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;
