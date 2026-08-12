import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { createLlmClient, type AnthropicLike } from '../../../src/core/llm/client.js';
import { HarvestError } from '../../../src/core/errors.js';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const parse = (raw: unknown) => z.object({ ok: z.boolean() }).parse(raw);

/** Поддельный SDK: отдаёт заданный ответ и запоминает параметры запроса. */
function fakeAnthropic(reply: unknown): AnthropicLike & { lastParams?: Record<string, unknown> } {
  const stub: AnthropicLike & { lastParams?: Record<string, unknown> } = {
    messages: {
      async create(params: Record<string, unknown>) {
        stub.lastParams = params;
        if (reply instanceof Error) throw reply;
        return reply as { content: Array<{ type: string; text?: string }> };
      },
    },
  };
  return stub;
}

const req = {
  name: 'Test',
  systemPrompt: 'system',
  userPrompt: 'user',
  schema: SCHEMA,
};

describe('llm/client: generateStructured', () => {
  it('разбирает и валидирует JSON из текстового блока', async () => {
    const anthropic = fakeAnthropic({ content: [{ type: 'text', text: '{"ok":true}' }] });
    const result = await createLlmClient({ anthropic }).generateStructured(req, parse);
    expect(result).toEqual({ ok: true });
  });

  it('шлёт нужную модель и схему, и не шлёт запрещённых параметров', async () => {
    const anthropic = fakeAnthropic({ content: [{ type: 'text', text: '{"ok":true}' }] });
    await createLlmClient({ anthropic }).generateStructured(req, parse);
    const p = anthropic.lastParams!;
    expect(p.model).toBe('claude-opus-5');
    // Эти три параметра на Opus 5 возвращают 400 — их не должно быть вовсе.
    expect(p.temperature).toBeUndefined();
    expect(p.top_p).toBeUndefined();
    expect(p.top_k).toBeUndefined();
    // Устаревший output_format тоже не должен появляться.
    expect(p.output_format).toBeUndefined();
    const outputConfig = p.output_config as { format?: { schema?: unknown } };
    expect(outputConfig.format?.schema).toEqual(SCHEMA);
  });

  it('пропускает блоки мышления и берёт текстовый', async () => {
    const anthropic = fakeAnthropic({
      content: [{ type: 'thinking' }, { type: 'text', text: '{"ok":false}' }],
    });
    const result = await createLlmClient({ anthropic }).generateStructured(req, parse);
    expect(result).toEqual({ ok: false });
  });

  it('падает понятной ошибкой на невалидном JSON', async () => {
    const anthropic = fakeAnthropic({ content: [{ type: 'text', text: 'не json' }] });
    await expect(createLlmClient({ anthropic }).generateStructured(req, parse)).rejects.toThrow(HarvestError);
  });

  it('падает понятной ошибкой, когда текстового блока нет вовсе', async () => {
    const anthropic = fakeAnthropic({ content: [{ type: 'thinking' }] });
    await expect(createLlmClient({ anthropic }).generateStructured(req, parse)).rejects.toThrow(HarvestError);
  });

  it('заворачивает ошибку API в HarvestError', async () => {
    const anthropic = fakeAnthropic(new Error('rate limited'));
    await expect(createLlmClient({ anthropic }).generateStructured(req, parse)).rejects.toThrow(HarvestError);
  });

  it('отказ модели (stop_reason: refusal) заворачивается в HarvestError с кодом blocked', async () => {
    const anthropic = fakeAnthropic({
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'refusal',
    });
    await expect(createLlmClient({ anthropic }).generateStructured(req, parse)).rejects.toMatchObject({
      code: 'blocked',
    });
  });

  it('обрезанный ответ (stop_reason: max_tokens) заворачивается в HarvestError с кодом internal', async () => {
    const anthropic = fakeAnthropic({
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'max_tokens',
    });
    await expect(createLlmClient({ anthropic }).generateStructured(req, parse)).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('таймаут соединения (APIConnectionTimeoutError) маппится в код timeout', async () => {
    const anthropic = fakeAnthropic(new Anthropic.APIConnectionTimeoutError());
    await expect(createLlmClient({ anthropic }).generateStructured(req, parse)).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('превышение лимита запросов (RateLimitError, 429) маппится в код upstream_error', async () => {
    // API реально ответил (соединение состоялось), просто с ошибочным статусом —
    // это upstream_error, а не network.
    const anthropic = fakeAnthropic(
      new Anthropic.RateLimitError(429, { type: 'rate_limit_error' }, 'rate limited', new Headers()),
    );
    await expect(createLlmClient({ anthropic }).generateStructured(req, parse)).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('некорректный запрос (BadRequestError, 400) маппится в код invalid_request', async () => {
    const anthropic = fakeAnthropic(
      new Anthropic.BadRequestError(400, { type: 'invalid_request_error' }, 'bad request', new Headers()),
    );
    await expect(createLlmClient({ anthropic }).generateStructured(req, parse)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('прочая ошибка API (общий APIError) маппится в код upstream_error', async () => {
    // Инстанс базового класса напрямую — стенд-ин для любого статуса API,
    // не покрытого более узкими подклассами (5xx и т.п.).
    const anthropic = fakeAnthropic(
      new Anthropic.APIError(503, { type: 'overloaded_error' }, 'service unavailable', new Headers()),
    );
    await expect(createLlmClient({ anthropic }).generateStructured(req, parse)).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });
});
