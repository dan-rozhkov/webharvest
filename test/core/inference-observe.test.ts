import { describe, it, expect } from 'vitest';
import { parseObservation, OBSERVATION_SCHEMA } from '../../src/core/llm/schemas.js';
import { observe } from '../../src/core/inference.js';
import type { LlmClient } from '../../src/core/llm/client.js';
import type { A11ySnapshot } from '../../src/core/a11y/types.js';

const SNAPSHOT: A11ySnapshot = {
  outline: '[0-1] button: Войти\n[0-2] link: Помощь',
  urlMap: { '0-2': 'https://example.com/help' },
  xpathMap: { '0-1': '/body[1]/button[1]', '0-2': '/body[1]/a[1]' },
  tagNameMap: { '0-1': 'button', '0-2': 'a' },
};

/** LLM-заглушка: отдаёт заготовленный ответ через настоящий валидатор. */
function fakeLlm(reply: unknown): LlmClient & { lastPrompt?: string } {
  const stub: LlmClient & { lastPrompt?: string } = {
    async generateStructured(req, validate) {
      stub.lastPrompt = req.userPrompt;
      return validate(reply);
    },
  };
  return stub;
}

describe('llm/schemas: observation', () => {
  it('отбрасывает адрес без ординала фрейма, не проваливая весь ответ', () => {
    const r = parseObservation({ elements: [{ elementId: '18372', description: 'd', method: 'click', arguments: [] }] });
    expect(r.elements).toEqual([]);
  });

  it('отбрасывает элемент с неподдерживаемым методом, не проваливая весь ответ', () => {
    const r = parseObservation({ elements: [{ elementId: '0-1', description: 'd', method: 'dragAndDrop', arguments: [] }] });
    expect(r.elements).toEqual([]);
  });

  it('один невалидный элемент рядом с валидными не топит весь ответ — по-русски: один плохой id не должен выкидывать хорошие', () => {
    const r = parseObservation({
      elements: [
        { elementId: '18372', description: 'выдуманный AX id без ординала фрейма', method: 'click', arguments: [] },
        { elementId: '0-1', description: 'кнопка входа', method: 'click', arguments: [] },
        { elementId: '0-2', description: 'ссылка помощи', method: 'click', arguments: [] },
      ],
    });
    expect(r.elements).toEqual([
      { elementId: '0-1', description: 'кнопка входа', method: 'click', arguments: [] },
      { elementId: '0-2', description: 'ссылка помощи', method: 'click', arguments: [] },
    ]);
  });

  it('падает на структурно некорректном ответе (elements — не массив)', () => {
    expect(() => parseObservation({ elements: 'не массив' })).toThrow();
  });

  it('пропускает корректный ответ', () => {
    const ok = parseObservation({ elements: [{ elementId: '0-1', description: 'кнопка входа', method: 'click', arguments: [] }] });
    expect(ok.elements).toHaveLength(1);
  });

  it('запрещает лишние поля в схеме для модели', () => {
    expect(OBSERVATION_SCHEMA.additionalProperties).toBe(false);
  });

  it('не содержит pattern — недокументированный для structured outputs ключ, который может 400-ить как HIGH 1', () => {
    // zod уже проверяет тот же формат id на выходе (ELEMENT_ID) — снятие
    // pattern из JSON Schema не ослабляет валидацию, только убирает риск.
    expect(JSON.stringify(OBSERVATION_SCHEMA)).not.toContain('pattern');
  });
});

describe('inference: observe', () => {
  it('возвращает найденные элементы', async () => {
    const llm = fakeLlm({ elements: [{ elementId: '0-1', description: 'кнопка входа', method: 'click', arguments: [] }] });
    const found = await observe({ llm }, { instruction: 'найди вход', snapshot: SNAPSHOT });
    expect(found).toEqual([{ elementId: '0-1', description: 'кнопка входа', method: 'click', arguments: [] }]);
  });

  it('кладёт дерево в промпт', async () => {
    const llm = fakeLlm({ elements: [] });
    await observe({ llm }, { instruction: 'найди вход', snapshot: SNAPSHOT });
    expect(llm.lastPrompt).toContain('[0-1] button: Войти');
  });

  it('отбрасывает элементы, которых нет в снапшоте', async () => {
    // Модель изредка выдумывает адрес; пускать такой в исполнение нельзя.
    const llm = fakeLlm({ elements: [{ elementId: '0-999', description: 'призрак', method: 'click', arguments: [] }] });
    const found = await observe({ llm }, { instruction: 'найди', snapshot: SNAPSHOT });
    expect(found).toEqual([]);
  });

  it('спокойно отдаёт пустой список', async () => {
    const llm = fakeLlm({ elements: [] });
    expect(await observe({ llm }, { instruction: 'найди', snapshot: SNAPSHOT })).toEqual([]);
  });
});
