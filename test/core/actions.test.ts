import { describe, it, expect } from 'vitest';
import { SUPPORTED_ACTIONS, isSupportedAction } from '../../src/core/actions.js';

describe('actions: набор поддерживаемых методов', () => {
  it('содержит ровно то, что обещано модели в промпте', () => {
    expect([...SUPPORTED_ACTIONS]).toEqual([
      'click',
      'fill',
      'type',
      'press',
      'hover',
      'selectOptionFromDropdown',
      'scrollTo',
    ]);
  });

  it('распознаёт свой метод', () => {
    expect(isSupportedAction('click')).toBe(true);
  });

  it('отвергает чужой метод', () => {
    expect(isSupportedAction('dragAndDrop')).toBe(false);
    expect(isSupportedAction('')).toBe(false);
  });
});
