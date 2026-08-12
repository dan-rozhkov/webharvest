/**
 * act / observe / extract поверх снапшота.
 *
 * Слой сознательно не знает про браузер: он принимает снапшот и возвращает
 * намерение. Исполнение живёт в actions.ts, оркестрация — в демоне. Так
 * инференс тестируется без Chromium, а исполнение — без модели.
 */
import type { A11ySnapshot } from './a11y/types.js';
import type { LlmClient, JsonSchema } from './llm/client.js';
import type { ActionRequest } from './actions.js';
import {
  OBSERVATION_SCHEMA,
  ACT_SCHEMA,
  parseObservation,
  parseActResult,
  type ObservedElement,
} from './llm/schemas.js';
import {
  buildObserveSystemPrompt,
  buildObserveUserPrompt,
  buildActStepTwoUserPrompt,
  buildActSystemPrompt,
  buildActUserPrompt,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
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

/** Имя переменной → её значение. В контекст модели значения не попадают никогда. */
export type Variables = Record<string, string>;

export interface ActPlan {
  first: ActionRequest;
  /** Кастомный дропдаун сначала надо раскрыть кликом, потом выбирать пункт. */
  needsSecondStep: boolean;
  /** Что модель собиралась сделать — уходит во второй проход как контекст. */
  description: string;
}

const PLACEHOLDER = /%([A-Za-z0-9_]+)%/g;

/**
 * Подстановка происходит **после** инференса: модель видит только имена
 * переменных, значения появляются здесь, перед самым исполнением. Это и есть
 * весь механизм — пароль физически не может попасть в контекст LLM.
 * Неизвестный плейсхолдер оставляем как есть: молча подставить пустую строку
 * значит тихо ввести не то, что просили.
 */
export function substituteVariables(args: string[], variables?: Variables): string[] {
  if (!variables) return args;
  return args.map((arg) =>
    arg.replace(PLACEHOLDER, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name) ? variables[name]! : whole,
    ),
  );
}

/** Список имён переменных для промпта — без значений. */
function variableSpecs(variables?: Variables): VariableSpec[] | undefined {
  if (!variables) return undefined;
  return Object.keys(variables).map((name) => ({ name }));
}

export interface PlanActParams {
  instruction: string;
  snapshot: A11ySnapshot;
  variables?: Variables;
  userInstructions?: string;
}

export async function planAct(
  deps: InferenceDeps,
  params: PlanActParams,
): Promise<ActPlan | null> {
  const result = await deps.llm.generateStructured(
    {
      name: 'Act',
      systemPrompt: buildActSystemPrompt(params.userInstructions),
      userPrompt: buildActUserPrompt(
        params.instruction,
        params.snapshot.outline,
        variableSpecs(params.variables),
      ),
      schema: ACT_SCHEMA,
      effort: 'low',
    },
    parseActResult,
  );

  const action = result.action;
  if (!action || !existsInSnapshot(params.snapshot, action.elementId)) return null;

  return {
    first: {
      elementId: action.elementId,
      method: action.method,
      arguments: substituteVariables(action.arguments, params.variables),
    },
    needsSecondStep: result.twoStep,
    description: action.description,
  };
}

export interface PlanActStepTwoParams {
  originalInstruction: string;
  previousDescription: string;
  snapshot: A11ySnapshot;
  variables?: Variables;
}

/**
 * Второй проход по уже обновившемуся дереву: дропдаун раскрылся, и только
 * теперь в снапшоте появились его пункты.
 */
export async function planActStepTwo(
  deps: InferenceDeps,
  params: PlanActStepTwoParams,
): Promise<ActionRequest | null> {
  const result = await deps.llm.generateStructured(
    {
      name: 'ActStepTwo',
      systemPrompt: buildActSystemPrompt(),
      userPrompt: buildActStepTwoUserPrompt(
        params.originalInstruction,
        params.previousDescription,
        params.snapshot.outline,
        variableSpecs(params.variables),
      ),
      schema: ACT_SCHEMA,
      effort: 'low',
    },
    parseActResult,
  );

  const action = result.action;
  if (!action || !existsInSnapshot(params.snapshot, action.elementId)) return null;

  return {
    elementId: action.elementId,
    method: action.method,
    arguments: substituteVariables(action.arguments, params.variables),
  };
}

const ELEMENT_ID_LIKE = /^\d+-\d+$/;

/**
 * Рекурсивная замена адресов элементов на настоящие ссылки. Промпт extract
 * велит модели отдавать ссылки идентификаторами, а не текстом — так она
 * физически не может выдумать URL, потому что в дереве их нет. Здесь мы
 * возвращаем адреса обратно в ссылки.
 */
function resolveLinks(value: unknown, urlMap: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return ELEMENT_ID_LIKE.test(value) && urlMap[value] ? urlMap[value] : value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveLinks(v, urlMap));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    // defineProperty всегда создаёт собственное свойство на `out`, даже для
    // ключа "__proto__" — в отличие от `out[k] = v`, который для этого имени
    // трактуется как присваивание [[Prototype]] и подменяет прототип объекта
    // (prototype pollution). Модель отдаёт сырой JSON от пользовательской
    // схемы, поэтому такой ключ в принципе может прилететь.
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: resolveLinks(v, urlMap),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export interface ExtractParams {
  instruction: string;
  snapshot: A11ySnapshot;
  /** JSON Schema желаемого результата — её задаёт вызывающий. */
  schema: JsonSchema;
  userInstructions?: string;
}

export async function extract(deps: InferenceDeps, params: ExtractParams): Promise<unknown> {
  const raw = await deps.llm.generateStructured(
    {
      name: 'Extraction',
      systemPrompt: buildExtractSystemPrompt(params.userInstructions),
      userPrompt: buildExtractUserPrompt(params.instruction, params.snapshot.outline),
      schema: params.schema,
      // Извлечение требует больше внимания, чем выбор одного элемента:
      // здесь модель должна пройти всё дерево и ничего не потерять.
      effort: 'medium',
    },
    // Схему задаёт вызывающий, поэтому своей валидации здесь нет: гарантию
    // соответствия даёт output_config.format на стороне API.
    (v) => v,
  );

  return resolveLinks(raw, params.snapshot.urlMap);
}
