import { request } from 'undici';
import { HarvestError, type ErrorCode } from '../core/errors.js';
import type { ScrapePayload } from '../core/format.js';
import type { SearchResult } from '../core/search/types.js';

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
    } catch {
      throw new HarvestError(
        'daemon_down',
        'Демон webharvest не отвечает. Запусти его командой `webharvest start` и повтори.',
      );
    }

    const payload = (await res.body.json()) as T & ErrorBody;
    if (res.statusCode >= 400) {
      const err = payload.error;
      throw new HarvestError(err?.code ?? 'network', err?.message ?? `Демон вернул ${res.statusCode}`, err?.detail);
    }
    return payload;
  }

  return {
    scrape: (body: unknown) => call<ScrapePayload>('/scrape', body),
    search: async (body: unknown) => (await call<{ results: SearchResult[] }>('/search', body)).results,
  };
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;
