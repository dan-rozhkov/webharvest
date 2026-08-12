import { describe, it, expect } from 'vitest';
import { cleanText, normaliseSpaces, formatTreeLine, encodeNodeId } from '../../../src/core/a11y/format.js';
import type { A11yNode } from '../../../src/core/a11y/types.js';

/** Минимальный узел — в тестах интересны только заполненные поля. */
function node(partial: Partial<A11yNode> & { role: string }): A11yNode {
  return { nodeId: '1', ...partial };
}

describe('a11y/format: encodeNodeId', () => {
  it('склеивает ординал фрейма и backendNodeId через дефис', () => {
    expect(encodeNodeId(0, 18372)).toBe('0-18372');
  });
});

describe('a11y/format: cleanText', () => {
  it('выкидывает глифы Private Use Area', () => {
    expect(cleanText('\uE001Войти')).toBe('Войти');
  });

  it('схлопывает неразрывные пробелы в один обычный', () => {
    expect(cleanText('Цена\u00A0\u00A01000')).toBe('Цена 1000');
  });

  it('обрезает края', () => {
    expect(cleanText('  Отправить  ')).toBe('Отправить');
  });
});

describe('a11y/format: normaliseSpaces', () => {
  it('схлопывает пробельные серии, но не обрезает края', () => {
    expect(normaliseSpaces(' a \n\t b ')).toBe(' a b ');
  });
});

describe('a11y/format: formatTreeLine', () => {
  it('печатает ID, роль и имя', () => {
    expect(formatTreeLine(node({ role: 'button', name: 'Войти', encodedId: '0-25' })))
      .toBe('[0-25] button: Войти');
  });

  it('опускает двоеточие у безымянного узла', () => {
    expect(formatTreeLine(node({ role: 'generic', encodedId: '0-7' }))).toBe('[0-7] generic');
  });

  it('добавляет флаги состояния', () => {
    expect(formatTreeLine(node({ role: 'checkbox', name: 'Запомнить', checked: true, encodedId: '0-31' })))
      .toBe('[0-31] checkbox: Запомнить [checked]');
  });

  it('отступает детей на два пробела за уровень', () => {
    const tree = node({
      role: 'form',
      encodedId: '0-1',
      children: [
        node({ role: 'textbox', name: 'Email', encodedId: '0-2' }),
        node({ role: 'button', name: 'Отправить', encodedId: '0-3' }),
      ],
    });
    expect(formatTreeLine(tree)).toBe(
      '[0-1] form\n  [0-2] textbox: Email\n  [0-3] button: Отправить',
    );
  });

  it('падает обратно на nodeId, если encodedId не проставлен', () => {
    expect(formatTreeLine(node({ role: 'text', nodeId: '99' }))).toBe('[99] text');
  });

  it('печатает value обычного поля как есть — иначе diff после fill пуст, и агент считает, что ввод не сработал', () => {
    expect(formatTreeLine(node({ role: 'textbox', name: 'Город', value: 'Тбилиси', encodedId: '0-9' })))
      .toBe('[0-9] textbox: Город = Тбилиси');
  });

  it('маскирует value поля пароля фиксированной строкой независимо от длины ввода', () => {
    const line = formatTreeLine(
      node({ role: 'textbox', name: 'Пароль', value: 'секретный-пароль-123', encodedId: '0-9' }),
      0,
      { '0-9': 'input, password' },
    );
    expect(line).toBe('[0-9] textbox: Пароль = ••••');
    expect(line).not.toContain('секретный-пароль-123');
  });

  it('не печатает value, когда его нет', () => {
    expect(formatTreeLine(node({ role: 'button', name: 'Ок', encodedId: '0-1' }))).toBe('[0-1] button: Ок');
  });
});
