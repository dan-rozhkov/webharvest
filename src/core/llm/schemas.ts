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

const observationSchema = z.object({ elements: z.array(elementSchema) }).strict();
const actSchema = z
  .object({ action: elementSchema.nullable(), twoStep: z.boolean() })
  .strict();

export function parseObservation(raw: unknown): { elements: ObservedElement[] } {
  return observationSchema.parse(raw);
}

export function parseActResult(raw: unknown): {
  action: ObservedElement | null;
  twoStep: boolean;
} {
  return actSchema.parse(raw);
}

const ELEMENT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    elementId: {
      type: 'string',
      pattern: '^\\d+-\\d+$',
      description:
        'The complete frame ordinal and backend node ID copied from the accessibility tree, without square brackets.',
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
