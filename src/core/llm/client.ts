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
  /**
   * Внутренняя метка схемы — используется только в наших сообщениях об
   * ошибках. `output_config.format` у Messages API не принимает `name`
   * (см. `JSONOutputFormat` в SDK: только `type` и `schema`), поэтому в
   * запрос это поле не уходит вовсе — только `schema` и `type`.
   */
  name: string;
  systemPrompt: string;
  userPrompt: string;
  schema: JsonSchema;
  effort?: 'low' | 'medium' | 'high';
}

/**
 * Точная форма тела запроса, которое реально уходит в SDK. Так как ниже мы
 * всегда вызываем `create` с литералом объекта, excess-property checking
 * TypeScript ловит на компиляции любое лишнее поле (например, случайно
 * добавленный `name` внутрь `format`) — это и есть барьер, которого не было
 * у прежнего `Record<string, unknown>`.
 */
export interface StructuredCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  output_config: {
    effort: 'low' | 'medium' | 'high';
    format: { type: 'json_schema'; schema: JsonSchema };
  };
}

/** Минимум от SDK, который нам нужен. Позволяет тестировать без сети и ключа. */
export interface AnthropicLike {
  messages: {
    create(params: StructuredCreateParams): Promise<{
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
    // Реальный HTTP-ответ с ошибочным статусом (429) — это `upstream_error`,
    // а не `network`: соединение состоялось, отказал сам сервис API.
    return new HarvestError('upstream_error', `Превышен лимит запросов к модели на запрос ${name}`, {
      status: e.status,
    });
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new HarvestError('invalid_request', `Некорректный запрос к модели ${name}: ${e.message}`, {
      status: e.status,
    });
  }
  if (e instanceof Anthropic.APIError) {
    // Тот же случай: API ответил, просто с другим кодом ошибки (5xx и т.п.).
    return new HarvestError('upstream_error', `Ошибка API модели на запрос ${name}: ${e.message}`, {
      status: e.status,
    });
  }
  // Всё, что не является типизированной ошибкой SDK, — это неизвестный сбой
  // соединения (DNS, ECONNREFUSED и т.п.); стрингифицируем как есть. Если
  // будущая версия SDK начнёт бросать что-то с полезными метаданными вместо
  // Error, здесь стоит это учесть отдельной веткой, а не полагаться на String().
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
            // `name` сюда не входит намеренно: `output_config.format` — это
            // `JSONOutputFormat` из SDK, там только `type` и `schema`; лишнее
            // поле API отвергает как invalid_request_error на каждом вызове.
            format: { type: 'json_schema', schema: req.schema },
          },
        });
      } catch (e) {
        throw wrapApiError(e, req.name);
      }

      if (response.stop_reason === 'refusal') {
        throw new HarvestError('llm_refusal', `Модель отказалась выполнить запрос ${req.name}`);
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
