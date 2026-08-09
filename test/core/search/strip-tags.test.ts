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

  it('не трогает generic-тип с многобуквенным параметром (Vec<Type>)', () => {
    expect(stripTags('Vec<Type> parameter')).toBe('Vec<Type> parameter');
  });

  it('не трогает generic-тип List<int> в прозе про C#', () => {
    expect(stripTags('List<int> in C#')).toBe('List<int> in C#');
  });

  it('не трогает generic-тип с двумя параметрами (Result<T, Error>)', () => {
    expect(stripTags('Result<T, Error> is the standard error type')).toBe(
      'Result<T, Error> is the standard error type',
    );
  });

  it('не трогает generic-тип HashMap<K, V>', () => {
    expect(stripTags('HashMap<K, V> stores key-value pairs')).toBe('HashMap<K, V> stores key-value pairs');
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

  it.each(['span', 'strong', 'b', 'em', 'i', 'mark', 'u', 'small', 'code', 'a', 'p', 'div', 'sup', 'sub', 'del', 'ins', 'font'])(
    'вырезает известный тег <%s> в нижнем, верхнем и смешанном регистре',
    (tag) => {
      const mixed = tag.length > 1 ? tag[0]!.toUpperCase() + tag.slice(1) : tag.toUpperCase();
      expect(stripTags(`<${tag}>x</${tag}>`)).toBe('x');
      expect(stripTags(`<${tag.toUpperCase()}>x</${tag.toUpperCase()}>`)).toBe('x');
      expect(stripTags(`<${mixed}>x</${mixed}>`)).toBe('x');
    },
  );

  it('вырезает самозакрывающиеся теги br и wbr', () => {
    expect(stripTags('line1<br>line2')).toBe('line1line2');
    expect(stripTags('long<wbr>word')).toBe('longword');
    expect(stripTags('LINE1<BR>LINE2')).toBe('LINE1LINE2');
  });

  it('вырезает тег с котированным атрибутом, содержащим ">"', () => {
    expect(stripTags('<a title="a>b">текст</a>')).toBe('текст');
  });

  it('вырезает тег с атрибутом в одинарных кавычках, содержащим ">"', () => {
    expect(stripTags("<a title='a>b'>текст</a>")).toBe('текст');
  });

  it('вырезает вложенные теги', () => {
    expect(stripTags('<em><strong>совпадение</strong></em> текст')).toBe('совпадение текст');
  });

  it('вырезает оборванный тег в конце строки', () => {
    expect(stripTags('текст <sp')).toBe('текст');
  });

  it('вырезает оборванный закрывающий тег в конце строки', () => {
    expect(stripTags('текст </sp')).toBe('текст');
  });

  it('вырезает оборванный тег foo <strong в конце строки', () => {
    expect(stripTags('foo <strong')).toBe('foo');
  });

  it('вырезает оборванный закрывающий тег foo </STRONG в верхнем регистре', () => {
    expect(stripTags('foo </STRONG')).toBe('foo');
  });

  it('не трогает entity-encoded &lt;strong&gt; (это не настоящий тег)', () => {
    expect(stripTags('&lt;strong&gt;текст&lt;/strong&gt;')).toBe('&lt;strong&gt;текст&lt;/strong&gt;');
  });

  it('обрезает пробелы по краям после вырезания тегов', () => {
    expect(stripTags('  <b>x</b>  ')).toBe('x');
  });
});
