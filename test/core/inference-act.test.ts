import { describe, it, expect } from 'vitest';
import { planAct, planActStepTwo, substituteVariables } from '../../src/core/inference.js';
import type { LlmClient } from '../../src/core/llm/client.js';
import type { A11ySnapshot } from '../../src/core/a11y/types.js';

const SNAPSHOT: A11ySnapshot = {
  outline: '[0-1] select: Страна\n[0-2] textbox: Пароль\n[0-3] StaticText: Выберите город',
  urlMap: {},
  xpathMap: { '0-1': '/x', '0-2': '/y', '0-3': '/z' },
  tagNameMap: { '0-1': 'select', '0-2': 'input, password', '0-3': 'span' },
};

function fakeLlm(reply: unknown): LlmClient & { lastPrompt?: string } {
  const stub: LlmClient & { lastPrompt?: string } = {
    async generateStructured(req, validate) {
      stub.lastPrompt = req.userPrompt;
      return validate(reply);
    },
  };
  return stub;
}

describe('inference: substituteVariables', () => {
  it('подставляет значение вместо плейсхолдера', () => {
    expect(substituteVariables(['%password%'], { password: 'ы' })).toEqual(['ы']);
  });

  it('подставляет несколько плейсхолдеров в одной строке', () => {
    expect(substituteVariables(['%a%-%b%'], { a: '1', b: '2' })).toEqual(['1-2']);
  });

  it('оставляет неизвестный плейсхолдер как есть', () => {
    expect(substituteVariables(['%нет%'], { a: '1' })).toEqual(['%нет%']);
  });

  it('ничего не делает без переменных', () => {
    expect(substituteVariables(['обычный текст'])).toEqual(['обычный текст']);
  });
});

describe('inference: planAct', () => {
  it('строит одношаговый план для нативного select', async () => {
    const llm = fakeLlm({
      action: { elementId: '0-1', description: 'дропдаун страны', method: 'selectOptionFromDropdown', arguments: ['Кипр'] },
      twoStep: false,
    });
    const plan = await planAct({ llm }, { instruction: 'выбери Кипр в дропдауне', snapshot: SNAPSHOT });
    expect(plan).not.toBeNull();
    expect(plan!.needsSecondStep).toBe(false);
    expect(plan!.first).toEqual({ elementId: '0-1', method: 'selectOptionFromDropdown', arguments: ['Кипр'] });
  });

  it('помечает кастомный дропдаун как требующий второго шага', async () => {
    const llm = fakeLlm({
      action: { elementId: '0-3', description: 'кастомный дропдаун города', method: 'click', arguments: [] },
      twoStep: true,
    });
    const plan = await planAct({ llm }, { instruction: 'выбери город в дропдауне', snapshot: SNAPSHOT });
    expect(plan!.needsSecondStep).toBe(true);
    expect(plan!.first.method).toBe('click');
  });

  it('возвращает null, когда подходящего элемента нет', async () => {
    const llm = fakeLlm({ action: null, twoStep: false });
    expect(await planAct({ llm }, { instruction: 'нажми несуществующее', snapshot: SNAPSHOT })).toBeNull();
  });

  it('возвращает null на выдуманный адрес', async () => {
    const llm = fakeLlm({
      action: { elementId: '0-999', description: 'призрак', method: 'click', arguments: [] },
      twoStep: false,
    });
    expect(await planAct({ llm }, { instruction: 'нажми', snapshot: SNAPSHOT })).toBeNull();
  });

  it('подставляет секрет только в план, не в промпт', async () => {
    const llm = fakeLlm({
      action: { elementId: '0-2', description: 'поле пароля', method: 'fill', arguments: ['%password%'] },
      twoStep: false,
    });
    const plan = await planAct(
      { llm },
      { instruction: 'введи пароль', snapshot: SNAPSHOT, variables: { password: 'секрет123' } },
    );
    expect(plan!.first.arguments).toEqual(['секрет123']);
    // Главное свойство механизма: значение не должно было попасть в контекст модели.
    expect(llm.lastPrompt).not.toContain('секрет123');
    expect(llm.lastPrompt).toContain('%password%');
  });
});

describe('inference: planActStepTwo', () => {
  it('строит действие второго шага по обновлённому дереву', async () => {
    const llm = fakeLlm({
      action: { elementId: '0-3', description: 'пункт Тбилиси', method: 'click', arguments: [] },
      twoStep: false,
    });
    const step = await planActStepTwo(
      { llm },
      { originalInstruction: 'выбери город', previousDescription: 'кликнул по дропдауну', snapshot: SNAPSHOT },
    );
    expect(step).toEqual({ elementId: '0-3', method: 'click', arguments: [] });
    expect(llm.lastPrompt).toContain('кликнул по дропдауну');
  });

  it('возвращает null, когда второй шаг не нашёлся', async () => {
    const llm = fakeLlm({ action: null, twoStep: false });
    const step = await planActStepTwo(
      { llm },
      { originalInstruction: 'выбери город', previousDescription: 'кликнул', snapshot: SNAPSHOT },
    );
    expect(step).toBeNull();
  });
});
