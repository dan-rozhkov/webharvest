/**
 * Схемы ответов модели: JSON Schema уходит в запрос и ограничивает генерацию,
 * zod-парсер проверяет результат уже у нас. Дублирование намеренное — JSON
 * Schema влияет на модель, zod даёт типы и защищает от расхождений.
 */
import { z } from 'zod';
import { SUPPORTED_ACTIONS, type SupportedAction } from '../actions.js';
import type { JsonSchema } from './client.js';

export interface ObservedElement {
  elementId: string;
  description: string;
  method: SupportedAction;
  arguments: string[];
}

/** Адрес обязан содержать ординал фрейма — иначе резолвер его не примет. */
const ELEMENT_ID = /^\d+-\d+$/;

const elementSchema = z
  .object({
    elementId: z.string().regex(ELEMENT_ID),
    description: z.string(),
    method: z.enum(SUPPORTED_ACTIONS as unknown as [SupportedAction, ...SupportedAction[]]),
    arguments: z.array(z.string()),
  })
  .strict();

// Верхнеуровневая форма проверяется строго (это контракт с API — если он
// нарушен, что-то сломано серьёзнее одного плохого элемента), а вот сами
// элементы — по одному. Печатаемый outline в format.ts иногда даёт узлу
// голый AX id вместо `frame-backendNodeId` (когда у узла нет
// backendDOMNodeId), и если модель его скопирует, elementId не пройдёт
// ELEMENT_ID. Раньше это валило элементом весь .parse() и вместе с ним —
// все остальные, валидные, элементы того же ответа. Теперь плохой элемент
// просто отбрасывается, а хорошие проходят как обычно (их дополнительно
// подчищает existsInSnapshot в inference.ts).
const looseObservationSchema = z.object({ elements: z.array(z.unknown()) }).strict();
const looseActSchema = z.object({ action: z.unknown(), twoStep: z.boolean() }).strict();

export function parseObservation(raw: unknown): { elements: ObservedElement[] } {
  const { elements } = looseObservationSchema.parse(raw);
  const kept: ObservedElement[] = [];
  for (const e of elements) {
    const r = elementSchema.safeParse(e);
    if (r.success) kept.push(r.data);
  }
  return { elements: kept };
}

export function parseActResult(raw: unknown): {
  action: ObservedElement | null;
  twoStep: boolean;
} {
  const { action, twoStep } = looseActSchema.parse(raw);
  if (action === null) return { action: null, twoStep };
  const r = elementSchema.safeParse(action);
  return { action: r.success ? r.data : null, twoStep };
}

const ELEMENT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    elementId: {
      type: 'string',
      // `pattern` не входит в задокументированный набор поддерживаемых
      // ключевых слов structured outputs (basic types, enum, const, anyOf,
      // allOf, $ref/$def, string format, additionalProperties: false) — если
      // API его отвергнет, это тот же отказ, что и HIGH 1 (400 на каждый
      // вызов). zod уже проверяет этот же формат на выходе (см. ELEMENT_ID
      // выше), так что снятие pattern из JSON Schema ничего не стоит.
      description:
        'The complete frame ordinal and backend node ID copied from the accessibility tree, without square brackets, formatted as two integers joined by a hyphen (e.g. "0-18372").',
    },
    description: {
      type: 'string',
      description: 'A description of the accessible element and its purpose.',
    },
    method: {
      type: 'string',
      enum: [...SUPPORTED_ACTIONS],
      description: 'The supported browser interaction method for this element.',
    },
    arguments: {
      type: 'array',
      items: { type: 'string' },
      description: 'The arguments to pass to the selected interaction method.',
    },
  },
  required: ['elementId', 'description', 'method', 'arguments'],
  additionalProperties: false,
};

export const OBSERVATION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { elements: { type: 'array', items: ELEMENT_JSON_SCHEMA } },
  required: ['elements'],
  additionalProperties: false,
};

export const ACT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    action: {
      anyOf: [ELEMENT_JSON_SCHEMA, { type: 'null' }],
      description: 'The element to act on, or null when no matching element exists.',
    },
    twoStep: {
      type: 'boolean',
      description: 'Whether the selected interaction requires a second action to finish the request.',
    },
  },
  required: ['action', 'twoStep'],
  additionalProperties: false,
};
