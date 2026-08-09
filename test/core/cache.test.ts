import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Cache, scrapeKey } from '../../src/core/cache.js';

let cache: Cache;
beforeEach(() => { cache = new Cache(':memory:'); });
afterEach(() => { cache.close(); });

describe('Cache', () => {
  it('возвращает записанное значение', () => {
    cache.set('k', 'v', 60_000);
    expect(cache.get('k')).toBe('v');
  });

  it('возвращает null для отсутствующего ключа', () => {
    expect(cache.get('нет')).toBeNull();
  });

  it('не возвращает просроченное значение', () => {
    cache.set('k', 'v', -1);
    expect(cache.get('k')).toBeNull();
  });

  it('перезаписывает значение по тому же ключу', () => {
    cache.set('k', 'old', 60_000);
    cache.set('k', 'new', 60_000);
    expect(cache.get('k')).toBe('new');
  });

  it('удаляет по ключу', () => {
    cache.set('k', 'v', 60_000);
    cache.delete('k');
    expect(cache.get('k')).toBeNull();
  });

  it('purgeExpired удаляет только просроченное и возвращает счётчик', () => {
    cache.set('live', 'v', 60_000);
    cache.set('dead1', 'v', -1);
    cache.set('dead2', 'v', -1);
    expect(cache.purgeExpired()).toBe(2);
    expect(cache.get('live')).toBe('v');
  });
});

describe('scrapeKey', () => {
  it('одинаков для URL, различающихся только нормализуемой частью', () => {
    expect(scrapeKey('https://Example.com/a/?utm_source=x', { includeLinks: false }))
      .toBe(scrapeKey('https://example.com/a#top', { includeLinks: false }));
  });

  it('различается при разном includeLinks', () => {
    expect(scrapeKey('https://example.com/a', { includeLinks: true }))
      .not.toBe(scrapeKey('https://example.com/a', { includeLinks: false }));
  });

  it('различается для разных URL', () => {
    expect(scrapeKey('https://example.com/a', { includeLinks: false }))
      .not.toBe(scrapeKey('https://example.com/b', { includeLinks: false }));
  });
});
