import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract, type Extracted } from '../../src/core/extractor.js';

interface Fixture {
  id: string;
  url: string;
  kind: string;
  expectTitleIncludes: string;
  minTextLength: number;
  mustNotInclude: string[];
}

const manifest: Fixture[] = JSON.parse(
  readFileSync(new URL('../fixtures/manifest.json', import.meta.url), 'utf8'),
);
const load = (id: string) =>
  readFileSync(new URL(`../fixtures/${id}.html`, import.meta.url), 'utf8');

describe.each(manifest)('extract: $id', (fx) => {
  // Извлечение большой страницы стоит секунды: считаем один раз на фикстуру.
  let cached: Extracted | undefined;
  const result = () => (cached ??= extract(load(fx.id), fx.url));

  it('находит заголовок', () => {
    expect(result().title).toContain(fx.expectTitleIncludes);
  });

  it('извлекает достаточно текста', () => {
    expect(result().textLength).toBeGreaterThanOrEqual(fx.minTextLength);
  });

  it('вычищает навигационный мусор', () => {
    const md = result().markdown;
    for (const junk of fx.mustNotInclude) expect(md).not.toContain(junk);
  });

  it('не оставляет тегов script и style', () => {
    const md = result().markdown;
    // Именно теги: в changelog Node.js есть легальный текст `<script-in-package-json>`.
    expect(md).not.toMatch(/<\/?(script|style)[\s>]|__INITIAL_STATE__/i);
  });

  it('не падает и всегда возвращает строку', () => {
    expect(typeof result().markdown).toBe('string');
  });
});

describe('extract: свойства', () => {
  it('делает ссылки абсолютными', () => {
    const html =
      '<html><body><article><p>текст</p><a href="/rel">rel</a></article></body></html>';
    const { markdown, links } = extract(html, 'https://example.com/dir/page');
    expect(markdown + JSON.stringify(links)).toContain('https://example.com/rel');
  });

  it('сохраняет структуру заголовков и код', () => {
    const html = `<html><body><article><h2>Раздел</h2><pre><code>const a = 1;</code></pre></article></body></html>`;
    const md = extract(html, 'https://example.com/').markdown;
    expect(md).toContain('## Раздел');
    expect(md).toContain('const a = 1;');
  });

  it('сохраняет таблицы в GFM', () => {
    const html =
      '<html><body><article><table><tr><th>a</th></tr><tr><td>1</td></tr></table></article></body></html>';
    expect(extract(html, 'https://example.com/').markdown).toContain('| a |');
  });

  it('не падает на пустом и на битом HTML', () => {
    expect(() => extract('', 'https://example.com/')).not.toThrow();
    expect(() => extract('<html><body><div><p>x', 'https://example.com/')).not.toThrow();
  });

  it('textLength считает текст, а не разметку', () => {
    const md = extract(
      '<html><body><article><p>' + 'a'.repeat(600) + '</p></article></body></html>',
      'https://example.com/',
    );
    expect(md.textLength).toBeGreaterThan(500);
  });
});
