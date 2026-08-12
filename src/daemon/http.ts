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
  // Origin server itself answered with an error status — we're relaying
  // that failure, not the daemon's own. 502 (Bad Gateway) is the closest
  // honest fit: the daemon acted as a gateway to a backend that failed.
  upstream_error: 502,
  invalid_request: 400,
  not_found: 404,
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

const browserOpenSchema = z.object({ url: z.string().min(1) });

const browserObserveSchema = z.object({
  sessionId: z.string().min(1),
  instruction: z.string().min(1),
});

const browserActSchema = z.object({
  sessionId: z.string().min(1),
  instruction: z.string().min(1),
  variables: z.record(z.string()).optional(),
});

const browserExtractSchema = z.object({
  sessionId: z.string().min(1),
  instruction: z.string().min(1),
  schema: z.record(z.unknown()),
});

const browserCloseSchema = z.object({ sessionId: z.string().min(1) });

/** Тот же способ, что и у /scrape выше: назвать поле, которое реально не
 *  прошло валидацию, а не всегда одно и то же захардкоженное имя. */
function invalidRequest(parsed: z.SafeParseReturnType<unknown, unknown>): HarvestError {
  const issue = (parsed as z.SafeParseError<unknown>).error.issues[0];
  const field = issue?.path.join('.') || 'body';
  return new HarvestError(
    'invalid_request',
    `Некорректное поле "${field}": ${issue?.message ?? 'не прошло валидацию'}`,
  );
}

/** Browser-use сервис опционален в интерфейсе Service (см. service.ts) —
 *  тестовые заглушки Service его не реализуют. На настоящем демоне метод
 *  всегда есть; not_found здесь означает баг проводки, а не "сессия не
 *  найдена" (эта ошибка приходит из самого сервиса другим HarvestError). */
function requireBrowserMethod<T>(method: T | undefined, name: string): T {
  if (!method) {
    throw new HarvestError('internal', `Метод ${name} не реализован в сервисе демона`);
  }
  return method;
}

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
    // ok: true always at this point because the HTTP server is responding.
    // If daemon shutdown is implemented in the future (e.g., graceful SIGTERM handling),
    // set ok: false during shutdown so clients can distinguish "daemon down" from
    // "daemon up but degraded". For now, the three-state CLI status logic still works:
    // - Connection fails → "not running"
    // - Response is 200 with ok=true → "running"
    // - (ok=false case is unreachable now but reserved for future use)
    ok: true,
    browser: safeBrowserRunning(service),
    version: '0.1.0',
  }));

  app.post('/scrape', async (req) => {
    const parsed = scrapeSchema.safeParse(req.body);
    if (!parsed.success) {
      // Name the field zod actually rejected, not always "url": a client
      // sending {"url": "...", "refresh": "yes"} fails on `refresh`, but
      // hardcoding 'invalid_url'/"Требуется поле url" here used to tell the
      // model to go fix a URL that was never the problem. Only genuine
      // url-field failures (missing/wrong type) keep the invalid_url code -
      // everything else about the request being malformed is invalid_request.
      const issue = parsed.error.issues[0];
      const field = issue?.path.join('.') || 'body';
      if (field === 'url') {
        throw new HarvestError('invalid_url', 'Требуется поле url');
      }
      throw new HarvestError(
        'invalid_request',
        `Некорректное поле "${field}": ${issue?.message ?? 'не прошло валидацию'}`,
      );
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

  app.post('/browser/open', async (req) => {
    const parsed = browserOpenSchema.safeParse(req.body);
    if (!parsed.success) throw invalidRequest(parsed);
    return requireBrowserMethod(service.browserOpen, 'browserOpen')(parsed.data);
  });

  app.post('/browser/observe', async (req) => {
    const parsed = browserObserveSchema.safeParse(req.body);
    if (!parsed.success) throw invalidRequest(parsed);
    return requireBrowserMethod(service.browserObserve, 'browserObserve')(parsed.data);
  });

  app.post('/browser/act', async (req) => {
    const parsed = browserActSchema.safeParse(req.body);
    if (!parsed.success) throw invalidRequest(parsed);
    return requireBrowserMethod(service.browserAct, 'browserAct')(parsed.data);
  });

  app.post('/browser/extract', async (req) => {
    const parsed = browserExtractSchema.safeParse(req.body);
    if (!parsed.success) throw invalidRequest(parsed);
    return requireBrowserMethod(service.browserExtract, 'browserExtract')(parsed.data);
  });

  app.post('/browser/close', async (req) => {
    const parsed = browserCloseSchema.safeParse(req.body);
    if (!parsed.success) throw invalidRequest(parsed);
    await requireBrowserMethod(service.browserClose, 'browserClose')(parsed.data);
    // POST/scrape и /search всегда отвечают объектом — пустой body ломает
    // JSON.parse на стороне DaemonClient (см. mcp/client.ts), поэтому здесь
    // тоже отдаём объект, а не undefined.
    return {};
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
