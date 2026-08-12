/**
 * Промпты для act / observe / extract.
 *
 * Текст промптов оставлен на английском намеренно: он выверен на проде
 * Stagehand, и перевод — это изменение поведения модели, которое нечем
 * проверить. Комментарии здесь объясняют, зачем нужна каждая непонятная часть.
 *
 * Портировано из browserbase/stagehand (MIT), packages/extension/prompt.ts
 * Copyright (c) Browserbase, Inc. См. NOTICE в корне репозитория.
 */
import { SUPPORTED_ACTIONS } from '../actions.js';

export interface VariableSpec {
  name: string;
  /** Что это за значение — модель видит описание, но никогда не само значение. */
  description?: string;
}

/** Системные промпты схлопываются в одну строку: так они не читаются моделью как размеченный документ. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function userInstructionsBlock(userInstructions?: string): string {
  if (!userInstructions) return '';
  return `\n\n# Custom Instructions Provided by the User\n\nPlease keep the user's instructions in mind when performing actions. If the user's instructions are not relevant to the current task, ignore them.\n\nUser Instructions:\n${userInstructions}`;
}

function variablesClause(variables?: VariableSpec[]): string {
  if (!variables?.length) return '';
  const list = variables
    .map((v) => (v.description ? `%${v.name}% (${v.description})` : `%${v.name}%`))
    .join(', ');
  return ` Available variables: ${list}. When an action needs a dynamic or sensitive value, return the matching %variableName% placeholder in the action arguments instead of a literal value.`;
}

const ACTIONS = SUPPORTED_ACTIONS.join(', ');

export function buildObserveSystemPrompt(
  userInstructions?: string,
  variables?: VariableSpec[],
): string {
  // Требование копировать адрес целиком вынесено отдельным абзацем и с примером:
  // без него модель регулярно возвращает голый backendNodeId без ординала фрейма.
  const base = collapse(`
    You are helping the user automate the browser by finding elements based on what the user wants to observe in the page.

    You will be given:
    1. an instruction of elements to observe
    2. a hierarchical accessibility tree showing the semantic structure of the page. The tree is a hybrid of the DOM and the accessibility tree.

    Return an array of elements that match the instruction if they exist, otherwise return an empty array.
    When returning elements, include the appropriate method from the supported actions list.

    Supported actions: ${ACTIONS}.${variablesClause(variables)}

    Each element in the accessibility tree has an ID in square brackets, like [0-18372]. The ID has two parts: frame ordinal and backend node ID. Always copy the complete ID exactly as shown inside the brackets into elementId, including the frame ordinal and hyphen. For example, if the tree shows [0-18372], return elementId "0-18372"; never return only "18372".
  `);
  return collapse(base + userInstructionsBlock(userInstructions));
}

export function buildObserveUserPrompt(instruction: string, outline: string): string {
  return `instruction: ${instruction}\nAccessibility Tree: \n${outline}\n`;
}

export function buildActSystemPrompt(userInstructions?: string): string {
  const base = collapse(`
    You are helping the user automate the browser by finding elements based on what action the user wants to take on the page.

    You will be given:
    1. a user defined instruction about what action to take
    2. a hierarchical accessibility tree showing the semantic structure of the page. The tree is a hybrid of the DOM and the accessibility tree.

    Return the element that matches the instruction if it exists. If no element on the page matches the instruction, set \`action\` to null. Do not fabricate or guess an element — empty strings or placeholder values for elementId/description/method are not acceptable.

    Each element in the accessibility tree has an ID in square brackets, like [0-18372]. Always copy the complete ID exactly as shown, including the frame ordinal and hyphen; never return only "18372".
  `);
  return collapse(base + userInstructionsBlock(userInstructions));
}

/**
 * Двухшаговые дропдауны — единственное место с ветвлением по кейсам, и оно
 * необходимое. Нативный `<select>` выбирается одним действием, кастомный
 * сначала надо раскрыть кликом, и только потом во втором проходе инференса
 * выбрать пункт из обновившегося дерева.
 */
export function buildActUserPrompt(
  instruction: string,
  outline: string,
  variables?: VariableSpec[],
): string {
  return `Find the most relevant element to perform an action on given the following action: ${instruction}.
IF AND ONLY IF the action EXPLICITLY includes the word 'dropdown' and implies choosing/selecting an option from a dropdown, ignore the 'General Instructions' section, and follow the 'Dropdown Specific Instructions' section carefully.

General Instructions:
  Provide an action for this element such as ${ACTIONS}. Remember that to users, buttons and links look the same in most cases.
  If the action is completely unrelated to a potential action to be taken on the page, or no matching element exists, set \`action\` to null. Do not fabricate or guess an element.
  ONLY return one action. If multiple actions are relevant, return the most relevant one.
  If the user is asking to scroll to a position on the page, e.g., 'halfway' or 0.75, etc, you must return the argument formatted as the correct percentage, e.g., '50%' or '75%', etc.
  If the action implies a key press, e.g., 'press enter', 'press a', 'press space', etc., always choose the press method with the appropriate key as argument — e.g. 'a', 'Enter', 'Space'. Do not choose a click action on an on-screen keyboard. Capitalize the first character like 'Enter', 'Tab', 'Escape' only for special keys.

Dropdown Specific Instructions:
  For interacting with dropdowns, there are two specific cases that you need to handle.

  CASE 1: the element is a 'select' element.
    - choose the selectOptionFromDropdown method,
    - set the argument to the exact text of the option that should be selected,
    - set twoStep to false.
  CASE 2: the element is NOT a 'select' element:
    - do not attempt to directly choose the element from the dropdown. You will need to click to expand the dropdown first. You will achieve this by following these instructions:
      - choose the node that most closely corresponds to the given instruction EVEN if it is a 'StaticText' element, or otherwise does not appear to be interactable.
      - choose the 'click' method
      - set twoStep to true.
${variablesClause(variables)}

Accessibility Tree:
${outline}
`;
}

export function buildActStepTwoUserPrompt(
  originalInstruction: string,
  previousAction: string,
  outline: string,
  variables?: VariableSpec[],
): string {
  return `The original user action was: ${originalInstruction}.
You have just taken the following action which completed step 1 of 2: ${previousAction}.

Now, you must find the most relevant element to perform an action on in order to complete step 2 of 2.

General Instructions:
  Provide an action for this element such as ${ACTIONS}. Remember that to users, buttons and links look the same in most cases.
  If the action is completely unrelated to a potential action to be taken on the page, or no matching element exists, set \`action\` to null. Do not fabricate or guess an element.
  ONLY return one action. If multiple actions are relevant, return the most relevant one.
${variablesClause(variables)}

Accessibility Tree:
${outline}
`;
}

export function buildExtractSystemPrompt(userInstructions?: string): string {
  // Требование отдавать ссылки идентификаторами — защита от галлюцинаций: URL
  // в дереве не печатаются вовсе, модель физически не может их выдумать,
  // а мы резолвим ID через urlMap уже у себя.
  const base = collapse(`
    You are extracting content on behalf of a user.
    If a user asks you to extract a 'list' of information, or 'all' information, YOU MUST EXTRACT ALL OF THE INFORMATION THAT THE USER REQUESTS.

    You will be given:
    1. An instruction
    2. A hierarchical accessibility tree of the page to extract from.

    Print the exact text from the elements with all symbols, characters, and endlines as is.
    Print null or an empty string if no new information is found.

    If a user is attempting to extract links or URLs, you MUST respond with ONLY the IDs of the link elements. Do not attempt to extract links directly from the text unless absolutely necessary.
  `);
  return collapse(base + userInstructionsBlock(userInstructions));
}

export function buildExtractUserPrompt(instruction: string, outline: string): string {
  return `Instruction: ${instruction}\nAccessibility Tree: \n${outline}`;
}
