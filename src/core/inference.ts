/**
 * act / observe / extract поверх снапшота.
 *
 * Слой сознательно не знает про браузер: он принимает снапшот и возвращает
 * намерение. Исполнение живёт в actions.ts, оркестрация — в демоне. Так
 * инференс тестируется без Chromium, а исполнение — без модели.
 */
import type { A11ySnapshot } from './a11y/types.js';
import type { LlmClient } from './llm/client.js';
import {
  OBSERVATION_SCHEMA,
  parseObservation,
  type ObservedElement,
} from './llm/schemas.js';
import {
  buildObserveSystemPrompt,
  buildObserveUserPrompt,
  type VariableSpec,
} from './llm/prompts.js';

export interface InferenceDeps {
  llm: LlmClient;
}

export interface ObserveParams {
  instruction: string;
  snapshot: A11ySnapshot;
  variables?: VariableSpec[];
  userInstructions?: string;
}

/**
 * Модель изредка возвращает адрес, которого в дереве не было. Пускать такой
 * дальше нельзя: резолвер попробует его найти, не найдёт и отдаст ошибку,
 * которую агент прочитает как «страница сломалась», а не «модель ошиблась».
 */
function existsInSnapshot(snapshot: A11ySnapshot, elementId: string): boolean {
  return elementId in snapshot.xpathMap;
}

export async function observe(
  deps: InferenceDeps,
  params: ObserveParams,
): Promise<ObservedElement[]> {
  const { elements } = await deps.llm.generateStructured(
    {
      name: 'Observation',
      systemPrompt: buildObserveSystemPrompt(params.userInstructions, params.variables),
      userPrompt: buildObserveUserPrompt(params.instruction, params.snapshot.outline),
      schema: OBSERVATION_SCHEMA,
      effort: 'low',
    },
    parseObservation,
  );

  return elements.filter((e) => existsInSnapshot(params.snapshot, e.elementId));
}
