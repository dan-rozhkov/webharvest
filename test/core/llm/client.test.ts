import { describe, it, expect } from 'vitest';
import { z } from 'zod';
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
});
