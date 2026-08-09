import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dedupeResults, createSearch } from '../../src/core/search/index.js';
import { parseSearxng } from '../../src/core/search/searxng.js';
import { parseBrave } from '../../src/core/search/brave.js';
import type { SearchProvider, SearchResult } from '../../src/core/search/types.js';
import { HarvestError } from '../../src/core/errors.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('parseSearxng', () => {
  it('нормализует ответ в SearchResult', () => {
    const r = parseSearxng(fixture('searxng-response'), 10);
    expect(r[0]).toEqual({
      url: 'https://playwright.dev/docs/intro',
      title: 'Installation',
      snippet: 'Playwright Test was created…',
      engine: 'searxng:google',
    });
  });

  it('уважает limit', () => {
    expect(parseSearxng(fixture('searxng-response'), 2)).toHaveLength(2);
  });

  it('не падает на пустом ответе', () => {
    expect(parseSearxng({ results: [] }, 5)).toEqual([]);
    expect(parseSearxng({}, 5)).toEqual([]);
  });

  it('не падает когда results строка вместо массива', () => {
    expect(parseSearxng({ results: 'nope' }, 5)).toEqual([]);
  });

  it('не падает когда results число вместо массива', () => {
    expect(parseSearxng({ results: 42 }, 5)).toEqual([]);
  });
});

describe('parseBrave', () => {
  it('нормализует ответ и вычищает HTML из описания', () => {
    const r = parseBrave(fixture('brave-response'), 10);
    expect(r[0]).toEqual({
      url: 'https://vitest.dev/guide/',
      title: 'Getting Started | Vitest',
      snippet: 'Vitest is a fast test runner',
      engine: 'brave',
    });
  });

  it('не падает на пустом ответе', () => {
    expect(parseBrave({}, 5)).toEqual([]);
  });

  it('не падает когда web.results число вместо массива', () => {
    expect(parseBrave({ web: { results: 42 } }, 5)).toEqual([]);
  });

  it('вычищает HTML теги с атрибутами содержащими >', () => {
    const r = parseBrave({
      web: {
        results: [
          {
            url: 'https://example.com',
            title: '<a title="a>b">link</a>',
            description: 'text with <a title="a>b">html</a> tag',
          },
        ],
      },
    }, 10);
    expect(r[0]!.title).toBe('link');
    expect(r[0]!.snippet).toBe('text with html tag');
  });

  it('вычищает незакрытые теги в конце', () => {
    const r = parseBrave({
      web: {
        results: [
          {
            url: 'https://example.com',
            title: 'title <strong',
            description: 'snippet ends with <em',
          },
        ],
      },
    }, 10);
    expect(r[0]!.title).toBe('title');
    expect(r[0]!.snippet).toBe('snippet ends with');
  });

  it('не удаляет сравнение < в прозе (a < b)', () => {
    const r = parseBrave({
      web: {
        results: [
          {
            url: 'https://example.com',
            title: 'a < b',
            description: 'compare values a < b',
          },
        ],
      },
    }, 10);
    expect(r[0]!.title).toBe('a < b');
    expect(r[0]!.snippet).toBe('compare values a < b');
  });

  it('не удаляет сравнение < в коде (if (a < b))', () => {
    const r = parseBrave({
      web: {
        results: [
          {
            url: 'https://example.com',
            title: 'if (a < b)',
            description: 'condition if (a < b) true',
          },
        ],
      },
    }, 10);
    expect(r[0]!.title).toBe('if (a < b)');
    expect(r[0]!.snippet).toBe('condition if (a < b) true');
  });

  it('не удаляет сравнение в природном языке (Returns true if a < b)', () => {
    const r = parseBrave({
      web: {
        results: [
          {
            url: 'https://example.com',
            title: 'Returns true if a < b',
            description: 'Function returns true if a < b',
          },
        ],
      },
    }, 10);
    expect(r[0]!.title).toBe('Returns true if a < b');
    expect(r[0]!.snippet).toBe('Function returns true if a < b');
  });
});

describe('dedupeResults', () => {
  it('схлопывает URL, различающиеся только трекингом', () => {
    const r = dedupeResults(parseSearxng(fixture('searxng-response'), 10));
    expect(r).toHaveLength(2);
    expect(r[0]!.title).toBe('Installation');
  });

  it('сохраняет порядок первых вхождений', () => {
    const input: SearchResult[] = [
      { url: 'https://b.com/', title: 'b', snippet: '', engine: 'x' },
      { url: 'https://a.com/', title: 'a', snippet: '', engine: 'x' },
      { url: 'https://b.com/?utm_source=q', title: 'b2', snippet: '', engine: 'y' },
    ];
    expect(dedupeResults(input).map((r) => r.title)).toEqual(['b', 'a']);
  });
});

const provider = (name: string, impl: () => Promise<SearchResult[]>): SearchProvider =>
  ({ name, search: impl });

describe('createSearch', () => {
  it('возвращает результат первого удачного провайдера', async () => {
    const second = vi.fn();
    const s = createSearch([
      provider('a', async () => [{ url: 'https://x/', title: 't', snippet: '', engine: 'a' }]),
      provider('b', second as never),
    ]);
    expect(await s.search('q', 5)).toHaveLength(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('уходит к следующему провайдеру при ошибке', async () => {
    const s = createSearch([
      provider('a', async () => { throw new Error('капча'); }),
      provider('b', async () => [{ url: 'https://y/', title: 't', snippet: '', engine: 'b' }]),
    ]);
    expect((await s.search('q', 5))[0]!.engine).toBe('b');
  });

  it('считает пустую выдачу неудачей и идёт дальше', async () => {
    const s = createSearch([
      provider('a', async () => []),
      provider('b', async () => [{ url: 'https://y/', title: 't', snippet: '', engine: 'b' }]),
    ]);
    expect(await s.search('q', 5)).toHaveLength(1);
  });

  it('бросает search_unavailable с перечислением отказов', async () => {
    const s = createSearch([
      provider('searxng', async () => { throw new Error('connect ECONNREFUSED'); }),
      provider('brave', async () => { throw new Error('401'); }),
    ]);
    const err = await s.search('q', 5).catch((e) => e);
    expect(err).toBeInstanceOf(HarvestError);
    expect(err.code).toBe('search_unavailable');
    expect(err.message).toContain('searxng');
    expect(err.message).toContain('brave');
  });

  it('бросает search_unavailable, если провайдеров нет вовсе', async () => {
    const err = await createSearch([]).search('q', 5).catch((e) => e);
    expect(err).toBeInstanceOf(HarvestError);
    expect(err.code).toBe('search_unavailable');
    expect(err.message).toContain('не настроены');
    expect(err.message).toContain('BRAVE_API_KEY');
  });

  it('бросает search_unavailable с конкретной причиной для каждого провайдера', async () => {
    const s = createSearch([
      provider('searxng', async () => { throw new Error('connect ECONNREFUSED'); }),
      provider('brave', async () => { throw new Error('401'); }),
    ]);
    const err = await s.search('q', 5).catch((e) => e);
    expect(err).toBeInstanceOf(HarvestError);
    expect(err.code).toBe('search_unavailable');
    expect(err.message).toContain('searxng: connect ECONNREFUSED');
    expect(err.message).toContain('brave: 401');
  });
});
