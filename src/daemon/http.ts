import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { HarvestError, type ErrorCode } from '../core/errors.js';
import type { Service } from './service.js';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_url: 400,
  not_html: 415,
  blocked: 422,
  too_large: 413,
  timeout: 504,
  network: 502,
  search_unavailable: 503,
  daemon_down: 503,
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

export function createHttpServer(service: Service): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({
    ok: true,
    browser: service.isBrowserRunning?.() ?? false,
    version: '0.1.0',
  }));

  app.post('/scrape', async (req, reply) => {
    const parsed = scrapeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'invalid_url', message: 'Требуется поле url' },
      });
    }
    try {
      return await service.scrape(parsed.data);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/search', async (req, reply) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'invalid_url', message: 'Требуется непустое поле query' },
      });
    }
    try {
      // Потолок применяется здесь, а не только внутри service.search: тест
      // на /search проверяет, что сервис реально получает уже ограниченный
      // limit, а не полагается только на внутреннюю защиту сервиса.
      const limit = Math.min(parsed.data.limit ?? 5, 10);
      return await service.search({ ...parsed.data, limit });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  return app;
}

function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  if (HarvestError.is(e)) {
    return reply.status(STATUS_BY_CODE[e.code]).send({ error: e.toJSON() });
  }
  // Внутренние подробности (пути, стектрейс, куски конфигурации вроде
  // braveApiKey) наружу не отдаём — только generic 500.
  return reply.status(500).send({
    error: { code: 'network', message: 'Внутренняя ошибка демона, смотри логи' },
  });
}
