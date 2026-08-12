/**
 * Тонкая обёртка над Anthropic SDK: один вызов, структурированный ответ.
 *
 * Почему `messages.create` + ручной JSON.parse, а не `messages.parse()` с
 * zod-хелпером: хелпер завязан на конкретную мажорную версию zod, а в проекте
 * zod 3. `output_config.format` с сырой JSON Schema уже гарантирует, что модель
 * вернёт валидный по схеме JSON, а валидацию типов мы всё равно делаем своим
 * zod-парсером на выходе. Так слой не зависит от версии zod вообще.
 *
 * Модель — `claude-opus-5`. На ней `temperature`/`top_p`/`top_k` и ручной
 * `thinking: {type: 'enabled', budget_tokens}` возвращают 400: мышление
 * включено по умолчанию (адаптивное), поэтому явный `thinking` не передаём
 * вовсе — поле опущено намеренно, а не забыто.
 */
import Anthropic from '@anthropic-ai/sdk';
import { HarvestError } from '../errors.js';

export type JsonSchema = Record<string, unknown>;

export interface StructuredRequest {
  /** Имя схемы — попадает в запрос и в кэш скомпилированных схем на стороне API. */
  name: string;
  systemPrompt: string;
  userPrompt: string;
  schema: JsonSchema;
  effort?: 'low' | 'medium' | 'high';
}

/** Минимум от SDK, который нам нужен. Позволяет тестировать без сети и ключа. */
export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
      stop_reason?: string | null;
    }>;
  };
}

export interface LlmClient {
  generateStructured<T>(req: StructuredRequest, validate: (raw: unknown) => T): Promise<T>;
}

const MODEL = 'claude-opus-5';
// Потолок общий на мышление и текст: мышление на этой модели включено по
// умолчанию, и заниженный max_tokens обрезает ответ на середине рассуждения.
const MAX_TOKENS = 16_000;

/**
 * Заворачивает ошибку вызова API в HarvestError по типу из SDK, а не по
 * тексту сообщения: строки в ошибках API не являются стабильным контрактом.
 */
function wrapApiError(e: unknown, name: string): HarvestError {
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new HarvestError('timeout', `Модель не ответила вовремя на запрос ${name}`);
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new HarvestError('network', `Превышен лимит запросов к модели на запрос ${name}`, {
      status: e.status,
    });
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new HarvestError('invalid_request', `Некорректный запрос к модели ${name}: ${e.message}`, {
      status: e.status,
    });
  }
  if (e instanceof Anthropic.APIError) {
    return new HarvestError('network', `Ошибка API модели на запрос ${name}: ${e.message}`, {
      status: e.status,
    });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new HarvestError('network', `Модель не ответила на запрос ${name}: ${msg}`);
}

export function createLlmClient(deps: { anthropic?: AnthropicLike } = {}): LlmClient {
  // Без ключа в окружении SDK возьмёт профиль `ant auth login` — конструктор
  // без аргументов это уже умеет, свою резолвилку писать не нужно.
  const anthropic: AnthropicLike = deps.anthropic ?? (new Anthropic() as unknown as AnthropicLike);

  return {
    async generateStructured<T>(req: StructuredRequest, validate: (raw: unknown) => T): Promise<T> {
      let response: { content: Array<{ type: string; text?: string }>; stop_reason?: string | null };
      try {
        response = await anthropic.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: req.systemPrompt,
          messages: [{ role: 'user', content: req.userPrompt }],
          // Мышление на Opus 5 включено по умолчанию (адаптивное); поле
          // `thinking` намеренно не передаём — ручная конфигурация 400-ит.
          output_config: {
            effort: req.effort ?? 'low',
            format: { type: 'json_schema', name: req.name, schema: req.schema },
          },
        });
      } catch (e) {
        throw wrapApiError(e, req.name);
      }

      if (response.stop_reason === 'refusal') {
        throw new HarvestError('blocked', `Модель отказалась выполнить запрос ${req.name}`);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new HarvestError(
          'internal',
          `Ответ модели на запрос ${req.name} обрезан лимитом max_tokens`,
        );
      }

      // В ответе помимо текста приезжают блоки мышления — берём первый текстовый.
      const text = response.content.find((b) => b.type === 'text')?.text;
      if (!text) {
        throw new HarvestError(
          'internal',
          `Модель вернула ответ без текстового блока на запрос ${req.name}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HarvestError(
          'internal',
          `Модель вернула не-JSON на запрос ${req.name}: ${text.slice(0, 200)}`,
        );
      }

      try {
        return validate(parsed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new HarvestError('internal', `Ответ модели не подошёл под схему ${req.name}: ${msg}`);
      }
    },
  };
}
