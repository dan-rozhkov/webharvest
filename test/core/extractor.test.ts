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

  it('разворачивает layout-таблицу, даже если внутри есть таблица с данными', () => {
    const html = `<html><body><table><tr><td><b>menu</b></td><td><table><tr><th>col</th></tr><tr><td>1</td></tr></table></td></tr></table></body></html>`;
    const md = extract(html, 'https://example.com/').markdown;
    expect(md).not.toContain('<table');
    expect(md).toContain('| col |');
  });

  it('не теряет второй <code> внутри <pre>', () => {
    const html = '<html><body><article><pre><code>AAA</code><code>BBB</code></pre></article></body></html>';
    expect(extract(html, 'https://example.com/').markdown).toContain('BBB');
  });

  it('удлиняет ограждение, если в коде есть тройная кавычка', () => {
    const html =
      '<html><body><article><pre><code>```\nне ограждение\n```</code></pre></article></body></html>';
    const md = extract(html, 'https://example.com/').markdown;
    expect(md).toContain('````');
    expect(md).toContain('не ограждение');
  });

  it('textLength не растёт от длинных адресов ссылок', () => {
    const href = 'https://example.com/' + 'x'.repeat(2000);
    const html = `<html><body><div id="app"><a href="${href}">ссылка</a></div></body></html>`;
    const { textLength, markdown } = extract(html, 'https://example.com/');
    expect(markdown).toContain(href);
    expect(textLength).toBeLessThan(100);
  });

  it('читает описание и отдаёт абсолютные адреса в links', () => {
    const html =
      '<html><head><meta name="description" content="Про страницу"></head>' +
      '<body><article><p>текст</p><a href="../up">вверх</a></article></body></html>';
    const { description, links } = extract(html, 'https://example.com/dir/page');
    expect(description).toBe('Про страницу');
    expect(links).toContainEqual({ href: 'https://example.com/up', text: 'вверх' });
  });

  it('чистит невидимые символы в title и description', () => {
    const html =
      '<html><head><title>a\u200Bb</title>' +
      '<meta name="description" content="c\uFEFFd"></head>' +
      '<body><article><p>обычный текст статьи без ничего особенного тут</p></article></body></html>';
    const { title, description } = extract(html, 'https://example.com/');
    expect(title).toBe('ab');
    expect(description).toBe('cd');
  });

  it('использует <base href>, а не URL страницы, для относительных ссылок', () => {
    const html =
      '<html><head><base href="https://cdn.example.com/assets/"></head>' +
      '<body><article><p>текст</p><a href="page">rel</a><img src="pic.png"></article></body></html>';
    const { markdown, links } = extract(html, 'https://example.com/dir/other');
    const haystack = markdown + JSON.stringify(links);
    expect(haystack).toContain('https://cdn.example.com/assets/page');
    expect(haystack).not.toContain('https://example.com/dir/page');
  });

  it('без <base> резолвит относительно URL страницы, как раньше', () => {
    const html = '<html><body><article><p>текст</p><a href="page">rel</a></article></body></html>';
    const { links } = extract(html, 'https://example.com/dir/other');
    expect(links).toContainEqual({ href: 'https://example.com/dir/page', text: 'rel' });
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

  it('не тащит в markdown адреса картинок, но сохраняет alt', () => {
    const html =
      '<html><body><article><p>текст страницы для объёма</p>' +
      '<img src="https://camo.githubusercontent.com/59c4ae90" alt="Organization">' +
      '</article></body></html>';
    const md = extract(html, 'https://example.com/').markdown;
    expect(md).toContain('изображение: Organization');
    expect(md).not.toContain('camo.githubusercontent.com');
  });

  it('не трогает пример картинки внутри блока кода', () => {
    const html =
      '<html><body><article><p>текст страницы для объёма</p>' +
      '<pre><code>![alt](https://cdn.example.com/a.png)</code></pre></article></body></html>';
    const md = extract(html, 'https://example.com/').markdown;
    expect(md).toContain('![alt](https://cdn.example.com/a.png)');
  });

  it('чистит трекинговые хвосты и в markdown, и в списке ссылок', () => {
    const html =
      '<html><body><article><p>текст страницы для объёма</p>' +
      '<a href="https://shop.example.com/item?id=7&utm_source=news">товар</a>' +
      '</article></body></html>';
    const { markdown, links } = extract(html, 'https://example.com/');
    expect(markdown).toContain('id=7');
    expect(markdown + JSON.stringify(links)).not.toContain('utm_source');
  });

  it('короткие бейджи не дотягивают до порога полезности', () => {
    const badges = Array.from(
      { length: 6 },
      (_, i) => `<a href="https://x.example/${i}"><img src="https://camo.example/${i}" alt="Badge ${i}"></a>`,
    ).join('');
    const { textLength } = extract(`<html><body><div>${badges}</div></body></html>`, 'https://example.com/');
    expect(textLength).toBeLessThan(200);
  });

  it('длинные alt считаются как текст: раньше их не было видно вовсе', () => {
    const alt = 'Подробная подпись к диаграмме архитектуры сервиса, объясняющая поток данных';
    const imgs = Array.from(
      { length: 4 },
      (_, i) => `<img src="https://camo.example/${i}" alt="${alt} ${i}">`,
    ).join('');
    const { markdown, textLength } = extract(`<html><body><div>${imgs}</div></body></html>`, 'https://example.com/');
    expect(markdown).not.toContain('camo.example');
    expect(textLength).toBeGreaterThan(200);
  });

  it('на фикстуре github-repo убирает camo-адреса из markdown', () => {
    const md = extract(load('github-repo'), 'https://github.com/searxng/searxng').markdown;
    expect(md).not.toContain('camo.githubusercontent.com');
  });
});
