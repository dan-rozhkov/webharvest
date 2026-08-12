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
  it('требует адрес с ординалом фрейма', () => {
    expect(() => parseObservation({ elements: [{ elementId: '18372', description: 'd', method: 'click', arguments: [] }] }))
      .toThrow();
  });

  it('отвергает неподдерживаемый метод', () => {
    expect(() => parseObservation({ elements: [{ elementId: '0-1', description: 'd', method: 'dragAndDrop', arguments: [] }] }))
      .toThrow();
  });

  it('пропускает корректный ответ', () => {
    const ok = parseObservation({ elements: [{ elementId: '0-1', description: 'кнопка входа', method: 'click', arguments: [] }] });
    expect(ok.elements).toHaveLength(1);
  });

  it('запрещает лишние поля в схеме для модели', () => {
    expect(OBSERVATION_SCHEMA.additionalProperties).toBe(false);
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
