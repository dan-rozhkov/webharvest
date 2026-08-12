import { describe, it, expect } from 'vitest';
import {
  buildObserveSystemPrompt,
  buildObserveUserPrompt,
  buildActSystemPrompt,
  buildActUserPrompt,
  buildActStepTwoUserPrompt,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
} from '../../../src/core/llm/prompts.js';
import { SUPPORTED_ACTIONS } from '../../../src/core/actions.js';

// Действия, которые план сознательно не включил в v1 — промпты не должны их обещать модели.
const EXCLUDED_ACTIONS = ['nextChunk', 'prevChunk', 'dragAndDrop', 'doubleClick'];

function expectExactActionSet(prompt: string): void {
  for (const action of SUPPORTED_ACTIONS) {
    expect(prompt).toContain(action);
  }
  for (const action of EXCLUDED_ACTIONS) {
    expect(prompt).not.toContain(action);
  }
}

describe('llm/prompts: observe', () => {
  it('перечисляет ровно набор действий из SUPPORTED_ACTIONS, не больше и не меньше', () => {
    expectExactActionSet(buildObserveSystemPrompt());
  });

  it('требует копировать адрес целиком, включая ординал фрейма', () => {
    // Самая частая ошибка модели — вернуть 18372 вместо 0-18372.
    const p = buildObserveSystemPrompt();
    expect(p).toContain('0-18372');
    expect(p).toMatch(/never return only/i);
  });

  it('схлопнут в одну строку', () => {
    expect(buildObserveSystemPrompt()).not.toContain('\n');
  });

  it('перечисляет доступные переменные плейсхолдерами, без значений', () => {
    const p = buildObserveSystemPrompt(undefined, [{ name: 'password', description: 'пароль' }]);
    expect(p).toContain('%password%');
    expect(p).toContain('пароль');
  });

  it('вклеивает инструкции пользователя', () => {
    const p = buildObserveSystemPrompt('Работай только с формой входа');
    expect(p).toContain('Работай только с формой входа');
  });

  it('кладёт дерево в пользовательское сообщение', () => {
    const p = buildObserveUserPrompt('найди кнопку входа', '[0-1] button: Войти');
    expect(p).toContain('найди кнопку входа');
    expect(p).toContain('[0-1] button: Войти');
  });
});

describe('llm/prompts: act', () => {
  it('разрешает null и запрещает выдумывать элемент', () => {
    const p = buildActSystemPrompt();
    expect(p).toMatch(/set `?action`? to null/i);
    expect(p).toMatch(/do not fabricate/i);
  });

  it('перечисляет ровно набор действий из SUPPORTED_ACTIONS в первом шаге act', () => {
    expectExactActionSet(buildActUserPrompt('выбери страну в дропдауне', '[0-1] select'));
  });

  it('описывает оба случая дропдауна', () => {
    const p = buildActUserPrompt('выбери страну в дропдауне', '[0-1] select');
    expect(p).toContain('selectOptionFromDropdown');
    expect(p).toMatch(/twoStep to false/);
    expect(p).toMatch(/twoStep to true/);
    // CASE 1 — нативный select-элемент, CASE 2 — не select (кастомный виджет).
    expect(p).toMatch(/is a 'select' element/);
    expect(p).toMatch(/is NOT a 'select' element/);
  });

  it('на втором шаге сообщает, что уже сделано', () => {
    const p = buildActStepTwoUserPrompt('выбери страну', 'clicked the country dropdown', '[0-2] option: Кипр');
    expect(p).toContain('выбери страну');
    expect(p).toContain('clicked the country dropdown');
    expect(p).toContain('[0-2] option: Кипр');
  });

  it('перечисляет ровно набор действий из SUPPORTED_ACTIONS на втором шаге act', () => {
    expectExactActionSet(
      buildActStepTwoUserPrompt('выбери страну', 'clicked the country dropdown', '[0-2] option: Кипр'),
    );
  });

  it('передаёт имена переменных, не значения', () => {
    const p = buildActUserPrompt('введи пароль', '[0-1] textbox', [{ name: 'password' }]);
    expect(p).toContain('%password%');
  });
});

describe('llm/prompts: extract', () => {
  it('требует отдавать ссылки идентификаторами, а не текстом', () => {
    const p = buildExtractSystemPrompt();
    expect(p).toMatch(/ONLY the IDs of the link elements/i);
  });

  it('схлопнут в одну строку', () => {
    expect(buildExtractSystemPrompt()).not.toContain('\n');
  });

  it('кладёт инструкцию и дерево в пользовательское сообщение', () => {
    const p = buildExtractUserPrompt('собери заголовки', '[0-1] heading: Раз');
    expect(p).toContain('собери заголовки');
    expect(p).toContain('[0-1] heading: Раз');
  });
});
