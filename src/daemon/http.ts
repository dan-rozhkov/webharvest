import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HarvestError, type ErrorCode } from '../core/errors.js';
import type { Service } from './service.js';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_url: 400,
  invalid_query: 400,
  not_html: 415,
  blocked: 422,
  too_large: 413,
  timeout: 504,
  network: 502,
  search_unavailable: 503,
  daemon_down: 503,
  internal: 500,
};

const scrapeSchema = z.object({
  url: z.string().min(1),
  includeLinks: z.boolean().optional(),
  refresh: z.boolean().optional(),
});

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  fetchContent: z.boolean().optional(),
});

/** Calls service.isBrowserRunning() defensively: a broken status probe must
 *  degrade /health to "unknown" (false), not blow up the whole endpoint —
 *  readiness reporting shouldn't itself be a new way to go down. */
function safeBrowserRunning(service: Service): boolean {
  try {
    return service.isBrowserRunning?.() ?? false;
  } catch {
    return false;
  }
}

export function createHttpServer(service: Service): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({
    ok: true,
    browser: safeBrowserRunning(service),
    version: '0.1.0',
  }));

  app.post('/scrape', async (req) => {
    const parsed = scrapeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HarvestError('invalid_url', 'Требуется поле url');
    }
    return service.scrape(parsed.data);
  });

  app.post('/search', async (req) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HarvestError('invalid_query', 'Требуется непустое поле query');
    }
    // Потолок применяется здесь, а не только внутри service.search: тест
    // на /search проверяет, что сервис реально получает уже ограниченный
    // limit, а не полагается только на внутреннюю защиту сервиса.
    const limit = Math.min(parsed.data.limit ?? 5, 10);
    const results = await service.search({ ...parsed.data, limit });
    // Wrapped (not a bare array) on purpose: search has pending metadata —
    // which provider answered, whether fetchContent got truncated, how many
    // dedupe dropped — and a top-level array can never gain a sibling key
    // without a breaking change. One wrapper key now is cheaper than a
    // renegotiation with every client later.
    return { results };
  });

  // Routes above only ever throw HarvestError (validation) or let whatever
  // service.scrape/search throws propagate — Fastify catches both from an
  // async handler and forwards here. Centralizing the mapping means every
  // failure path (validation, HarvestError, Fastify's own body-parsing
  // errors, and truly unexpected exceptions) goes through the same envelope
  // and the same "never leak internals" rule, instead of two ad hoc
  // try/catch blocks that only covered two of those four cases.
  app.setErrorHandler((err, _req, reply) => {
    if (HarvestError.is(err)) {
      return reply.status(STATUS_BY_CODE[err.code]).send({ error: err.toJSON() });
    }
    // Fastify's own request-parsing failures (malformed JSON body, bad
    // content-type, oversized payload, ...) carry a 4xx statusCode and a
    // stable FST_ERR_* code. Route them through our envelope instead of
    // Fastify's default {statusCode,error,message} shape, but never forward
    // err.message itself — it can echo raw request bytes back to the client.
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: 'invalid_request', message: 'Некорректный запрос' },
      });
    }
    // Anything else is an unexpected internal failure. No file paths, no
    // stack frames, no config values (e.g. braveApiKey) — a fixed generic
    // message regardless of what err.message actually says.
    return reply.status(500).send({
      error: { code: 'internal', message: 'Внутренняя ошибка демона, смотри логи' },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: `Маршрут не найден: ${req.method} ${req.url}` },
    });
  });

  return app;
}
