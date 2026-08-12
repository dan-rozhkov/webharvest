import { describe, it, expect } from 'vitest';
import { parseEncodedId } from '../../../src/core/a11y/resolve.js';
import { HarvestError } from '../../../src/core/errors.js';

describe('a11y/resolve: parseEncodedId', () => {
  it('разбирает корректный адрес', () => {
    expect(parseEncodedId('0-18372')).toEqual({ frameOrdinal: 0, backendNodeId: 18372 });
  });

  it('отвергает адрес без ординала фрейма', () => {
    // Именно эту ошибку модели делают чаще всего — промпт отдельно про неё
    // предупреждает, значит сообщение должно быть понятным.
    expect(() => parseEncodedId('18372')).toThrow(HarvestError);
    expect(() => parseEncodedId('18372')).toThrow(/0-18372/);
  });

  it('отвергает мусор', () => {
    expect(() => parseEncodedId('abc')).toThrow(HarvestError);
    expect(() => parseEncodedId('0-')).toThrow(HarvestError);
    expect(() => parseEncodedId('')).toThrow(HarvestError);
  });
});
