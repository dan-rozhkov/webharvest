import { describe, it, expect } from 'vitest';
import { extract } from '../../src/core/inference.js';
import type { LlmClient } from '../../src/core/llm/client.js';
import type { A11ySnapshot } from '../../src/core/a11y/types.js';

const SNAPSHOT: A11ySnapshot = {
  outline: '[0-1] heading: Новости\n[0-2] link: Первая статья\n[0-3] link: Вторая статья',
  urlMap: { '0-2': 'https://example.com/a', '0-3': 'https://example.com/b' },
  xpathMap: { '0-1': '/x', '0-2': '/y', '0-3': '/z' },
  tagNameMap: { '0-1': 'h1', '0-2': 'a', '0-3': 'a' },
};

const SCHEMA = {
  type: 'object',
  properties: { links: { type: 'array', items: { type: 'string' } } },
  required: ['links'],
  additionalProperties: false,
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

describe('inference: extract', () => {
  it('отдаёт данные как есть, когда ссылок нет', async () => {
    const llm = fakeLlm({ title: 'Новости' });
    const out = await extract({ llm }, { instruction: 'заголовок', snapshot: SNAPSHOT, schema: SCHEMA });
    expect(out).toEqual({ title: 'Новости' });
  });

  it('заменяет адреса элементов на настоящие ссылки', async () => {
    // Модель не видит URL вовсе — она возвращает ID, мы подставляем адрес.
    const llm = fakeLlm({ links: ['0-2', '0-3'] });
    const out = await extract({ llm }, { instruction: 'все ссылки', snapshot: SNAPSHOT, schema: SCHEMA });
    expect(out).toEqual({ links: ['https://example.com/a', 'https://example.com/b'] });
  });

  it('подставляет ссылки и во вложенных структурах', async () => {
    const llm = fakeLlm({ items: [{ name: 'Первая', href: '0-2' }] });
    const out = await extract({ llm }, { instruction: 'статьи', snapshot: SNAPSHOT, schema: SCHEMA });
    expect(out).toEqual({ items: [{ name: 'Первая', href: 'https://example.com/a' }] });
  });

  it('не трогает строки, похожие на адрес, но отсутствующие в карте ссылок', async () => {
    const llm = fakeLlm({ code: '0-1' });
    const out = await extract({ llm }, { instruction: 'что-то', snapshot: SNAPSHOT, schema: SCHEMA });
    expect(out).toEqual({ code: '0-1' });
  });

  it('не даёт ключу __proto__ подменить прототип результата', async () => {
    // JSON.parse сам не создаёт опасного "__proto__" (он делает обычное
    // собственное свойство), но наивная сборка `out[k] = v` в resolveLinks
    // трактует присваивание по этому имени как запись в [[Prototype]].
    const reply = JSON.parse('{"__proto__":{"polluted":"yes"},"title":"Новости"}') as unknown;
    const llm = fakeLlm(reply);
    const out = (await extract({ llm }, { instruction: 'заголовок', snapshot: SNAPSHOT, schema: SCHEMA })) as Record<
      string,
      unknown
    >;

    expect((Object.getPrototypeOf(out) as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.title).toBe('Новости');
  });

  it('кладёт дерево в промпт', async () => {
    const llm = fakeLlm({ links: [] });
    await extract({ llm }, { instruction: 'ссылки', snapshot: SNAPSHOT, schema: SCHEMA });
    expect(llm.lastPrompt).toContain('[0-2] link: Первая статья');
  });
});
