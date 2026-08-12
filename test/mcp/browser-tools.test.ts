import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../../src/mcp/tools.js';

function tool(name: string) {
  const found = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!found) throw new Error(`инструмент ${name} не объявлен`);
  return found;
}

const ALL_BROWSER_TOOLS = [
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_hover',
  'browser_fill',
  'browser_type',
  'browser_press',
  'browser_select',
  'browser_scroll',
  'browser_close',
];

describe('mcp: инструменты browser use', () => {
  it('объявляет по инструменту на каждое действие плюс open/snapshot/close', () => {
    for (const name of ALL_BROWSER_TOOLS) {
      expect(() => tool(name)).not.toThrow();
    }
  });

  it('browser_open требует только url', () => {
    expect(tool('browser_open').inputSchema.required).toEqual(['url']);
  });

  it('browser_snapshot требует только sessionId', () => {
    expect(tool('browser_snapshot').inputSchema.required).toEqual(['sessionId']);
  });

  it('действия над элементом требуют sessionId и elementId', () => {
    for (const name of ['browser_click', 'browser_hover']) {
      expect([...tool(name).inputSchema.required].sort()).toEqual(['elementId', 'sessionId']);
    }
  });

  it('browser_fill/browser_type требуют текст и допускают variables', () => {
    for (const name of ['browser_fill', 'browser_type']) {
      const schema = tool(name).inputSchema;
      expect([...schema.required].sort()).toEqual(['elementId', 'sessionId', 'text']);
      expect(schema.properties).toHaveProperty('variables');
    }
  });

  it('browser_press требует key, browser_select — value, browser_scroll — percent', () => {
    expect([...tool('browser_press').inputSchema.required].sort()).toEqual(['elementId', 'key', 'sessionId']);
    expect([...tool('browser_select').inputSchema.required].sort()).toEqual(['elementId', 'sessionId', 'value']);
    expect([...tool('browser_scroll').inputSchema.required].sort()).toEqual(['elementId', 'percent', 'sessionId']);
  });

  it('описания на русском, объясняют когда инструмент нужен и откуда брать elementId', () => {
    for (const name of ['browser_open', 'browser_snapshot', 'browser_click', 'browser_fill']) {
      const d = tool(name).description;
      expect(d).toMatch(/[а-яА-Я]/);
    }
    // Только browser_open/browser_snapshot объясняют формат адреса...
    for (const name of ['browser_open', 'browser_snapshot']) {
      expect(tool(name).description).toMatch(/0-18372/);
    }
    // ...а действия — что адрес нужно скопировать из последнего снапшота.
    for (const name of ['browser_click', 'browser_fill', 'browser_select']) {
      expect(tool(name).description).toMatch(/снапшота/);
    }
  });

  it('browser_fill объясняет подстановку секретов через variables, без вранья про «модель не увидит»', () => {
    const d = tool('browser_fill').description;
    expect(d).toMatch(/variables/);
    expect(d).toMatch(/%.*%/);
    expect(d).not.toMatch(/модель/);
  });

  it('не ломает существующие инструменты', () => {
    expect(() => tool('scrape')).not.toThrow();
    expect(() => tool('search')).not.toThrow();
  });
});
