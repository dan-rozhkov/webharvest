import { describe, it, expect } from 'vitest';
import { diffOutlines } from '../../../src/core/a11y/diff.js';

describe('a11y/diff: diffOutlines', () => {
  it('возвращает только появившиеся строки', () => {
    const prev = '[0-1] form\n  [0-2] button: Войти';
    const next = '[0-1] form\n  [0-2] button: Войти\n  [0-3] alert: Неверный пароль';
    expect(diffOutlines(prev, next)).toBe('[0-3] alert: Неверный пароль');
  });

  it('игнорирует изменение отступа при сравнении', () => {
    const prev = '[0-2] button: Войти';
    const next = '[0-1] form\n    [0-2] button: Войти';
    expect(diffOutlines(prev, next)).toBe('[0-1] form');
  });

  it('сдвигает результат к нулевой колонке', () => {
    const prev = '[0-1] form';
    const next = '[0-1] form\n      [0-9] alert: Ошибка\n        [0-10] StaticText: Ошибка';
    expect(diffOutlines(prev, next)).toBe('[0-9] alert: Ошибка\n  [0-10] StaticText: Ошибка');
  });

  it('отдаёт пустую строку, когда ничего не появилось', () => {
    expect(diffOutlines('[0-1] form', '[0-1] form')).toBe('');
  });

  it('считает весь next новым, когда prev пуст', () => {
    expect(diffOutlines('', '[0-1] form')).toBe('[0-1] form');
  });
});
