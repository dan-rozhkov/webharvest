import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../../src/mcp/tools.js';

function tool(name: string) {
  const found = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!found) throw new Error(`инструмент ${name} не объявлен`);
  return found;
}

describe('mcp: инструменты browser use', () => {
  it('объявляет пять инструментов', () => {
    for (const name of ['browser_open', 'browser_observe', 'browser_act', 'browser_extract', 'browser_close']) {
      expect(() => tool(name)).not.toThrow();
    }
  });

  it('browser_open требует только url', () => {
    expect(tool('browser_open').inputSchema.required).toEqual(['url']);
  });

  it('browser_act требует сессию и инструкцию', () => {
    expect([...tool('browser_act').inputSchema.required].sort()).toEqual(['instruction', 'sessionId']);
  });

  it('browser_extract требует схему результата', () => {
    expect([...tool('browser_extract').inputSchema.required].sort()).toEqual(['instruction', 'schema', 'sessionId']);
  });

  it('описания на русском и объясняют, когда инструмент нужен', () => {
    for (const name of ['browser_open', 'browser_act']) {
      const d = tool(name).description;
      expect(d).toMatch(/[а-яА-Я]/);
      expect(d).toMatch(/Используй/);
    }
  });

  it('не ломает существующие инструменты', () => {
    expect(() => tool('scrape')).not.toThrow();
    expect(() => tool('search')).not.toThrow();
  });
});
