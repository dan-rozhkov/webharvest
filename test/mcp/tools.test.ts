import { describe, it, expect, beforeEach } from 'vitest';
import { TOOL_DEFINITIONS, handleScrape, handleSearch } from '../../src/mcp/tools.js';
import { HarvestError } from '../../src/core/errors.js';

interface CallRecord {
  scrapeArgs?: Record<string, unknown>;
  searchArgs?: Record<string, unknown>;
}

let calls: CallRecord = {};
beforeEach(() => { calls = {}; });

const client = {
  scrape: async (args: unknown) => {
    calls.scrapeArgs = args as Record<string, unknown>;
    return { url: 'https://a/', title: 'Заголовок', markdown: 'a'.repeat(1000), via: 'http' as const, cached: false };
  },
  search: async (args: unknown) => {
    calls.searchArgs = args as Record<string, unknown>;
    return [{ url: 'https://a/', title: 'A', snippet: 's', engine: 'brave' }];
  },
};

describe('TOOL_DEFINITIONS', () => {
  it('объявляет ровно два инструмента', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(['scrape', 'search']);
  });

  it('у каждого есть непустое описание и схема с required', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.description.length).toBeGreaterThan(30);
      expect(((t.inputSchema as unknown) as { required: string[] }).required.length).toBeGreaterThan(0);
    }
  });
});

describe('handleScrape', () => {
  it('форматирует ответ с шапкой', async () => {
    const out = await handleScrape(client as never, { url: 'https://a/' });
    expect(out).toContain('# Заголовок');
    expect(out).toContain('via http');
  });

  it('усечение применяется по maxChars', async () => {
    const out = await handleScrape(client as never, { url: 'https://a/', maxChars: 100 });
    expect(out).toMatch(/обрезано/i);
  });

  it('ошибка приходит агенту читаемым текстом, а не стектрейсом', async () => {
    const failing = { ...client, scrape: async () => { throw new HarvestError('blocked', 'закрыто cloudflare', { by: 'cloudflare' }); } };
    const out = await handleScrape(failing as never, { url: 'https://a/' });
    expect(out).toContain('cloudflare');
    expect(out).not.toContain('at Object.');
  });

  it('передаёт дефолтные значения: refresh=false, includeLinks=false', async () => {
    await handleScrape(client as never, { url: 'https://a/' });
    expect(calls.scrapeArgs).toEqual({ url: 'https://a/', refresh: false, includeLinks: false });
  });

  it('переопределяет дефолты явными значениями', async () => {
    await handleScrape(client as never, { url: 'https://b/', refresh: true, includeLinks: true });
    expect(calls.scrapeArgs).toEqual({ url: 'https://b/', refresh: true, includeLinks: true });
  });
});

describe('handleSearch', () => {
  it('форматирует выдачу', async () => {
    const out = await handleSearch(client as never, { query: 'q' });
    expect(out).toContain('1.');
    expect(out).toContain('A');
  });

  it('передаёт дефолтные значения: limit=5, fetchContent=false', async () => {
    await handleSearch(client as never, { query: 'test' });
    expect(calls.searchArgs).toEqual({ query: 'test', limit: 5, fetchContent: false });
  });

  it('переопределяет дефолты явными значениями', async () => {
    await handleSearch(client as never, { query: 'test', limit: 10, fetchContent: true });
    expect(calls.searchArgs).toEqual({ query: 'test', limit: 10, fetchContent: true });
  });
});
