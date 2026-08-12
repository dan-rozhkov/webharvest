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

export function createDaemonClient(baseUrl: string) {
  async function call<T>(path: string, body: unknown): Promise<T> {
    let res;
    try {
      res = await request(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        headersTimeout: 120_000,
        bodyTimeout: 120_000,
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
    browserOpen: (body: unknown) => call<BrowserOpenResult>('/browser/open', body),
    browserObserve: (body: unknown) => call<BrowserObserveResult>('/browser/observe', body),
    browserAct: (body: unknown) => call<BrowserActResult>('/browser/act', body),
    browserExtract: (body: unknown) => call<unknown>('/browser/extract', body),
    browserClose: async (body: unknown) => { await call<Record<string, never>>('/browser/close', body); },
  };
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;
