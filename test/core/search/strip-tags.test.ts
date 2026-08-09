import { describe, it, expect } from 'vitest';
import { stripTags } from '../../../src/core/search/strip-tags.js';

describe('stripTags', () => {
  it('не трогает числовые сравнения в прозе', () => {
    expect(stripTags('Sorting: 3 < 5 and 7 > 2 in JS')).toBe('Sorting: 3 < 5 and 7 > 2 in JS');
  });

  it('не трогает булевы сравнения в коде', () => {
    expect(stripTags('if (a < b && c > d)')).toBe('if (a < b && c > d)');
  });

  it('не трогает generic-типы (Vec<T>)', () => {
    expect(stripTags('Rust: Vec<T> is a growable array')).toBe('Rust: Vec<T> is a growable array');
  });

  it('не трогает shell-редиректы', () => {
    expect(stripTags('run: cmd < input.txt > output.txt')).toBe('run: cmd < input.txt > output.txt');
  });

  it('не трогает shell cat с ">"', () => {
    expect(stripTags('cat a > b')).toBe('cat a > b');
  });

  it('не трогает "<3" в прозе', () => {
    expect(stripTags('a <3 heart')).toBe('a <3 heart');
  });

  it('вырезает настоящий тег без атрибутов', () => {
    expect(stripTags('<b>жирный</b> текст')).toBe('жирный текст');
  });

  it('вырезает настоящий тег с атрибутами', () => {
    expect(stripTags('<span class="highlight">совпадение</span>')).toBe('совпадение');
  });

  it('вырезает тег в верхнем регистре', () => {
    expect(stripTags('<SPAN class="hl">upper</SPAN>')).toBe('upper');
  });

  it('вырезает тег в смешанном регистре', () => {
    expect(stripTags('<Mark>mixed</Mark> case')).toBe('mixed case');
  });

  it('вырезает тег с котированным атрибутом, содержащим ">"', () => {
    expect(stripTags('<a title="a>b">текст</a>')).toBe('текст');
  });

  it('вырезает оборванный тег в конце строки', () => {
    expect(stripTags('текст <sp')).toBe('текст');
  });

  it('вырезает оборванный закрывающий тег в конце строки', () => {
    expect(stripTags('текст </sp')).toBe('текст');
  });

  it('обрезает пробелы по краям после вырезания тегов', () => {
    expect(stripTags('  <b>x</b>  ')).toBe('x');
  });
});
