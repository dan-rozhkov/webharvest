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

describe('llm/prompts: observe', () => {
  it('перечисляет поддерживаемые действия', () => {
    const p = buildObserveSystemPrompt();
    expect(p).toContain('click');
    expect(p).toContain('selectOptionFromDropdown');
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

  it('описывает оба случая дропдауна', () => {
    const p = buildActUserPrompt('выбери страну в дропдауне', '[0-1] select');
    expect(p).toContain('selectOptionFromDropdown');
    expect(p).toMatch(/twoStep to false/);
    expect(p).toMatch(/twoStep to true/);
  });

  it('на втором шаге сообщает, что уже сделано', () => {
    const p = buildActStepTwoUserPrompt('выбери страну', 'clicked the country dropdown', '[0-2] option: Кипр');
    expect(p).toContain('выбери страну');
    expect(p).toContain('clicked the country dropdown');
    expect(p).toContain('[0-2] option: Кипр');
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
