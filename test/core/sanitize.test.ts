import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { sanitizeDocument } from '../../src/core/sanitize.js';

const PAGE = 'https://example.com/page';

/** Прогоняет фрагмент через чистку и отдаёт HTML тела — так виден результат правил. */
function clean(bodyHtml: string, url = PAGE): string {
  const doc = new JSDOM(`<html><body>${bodyHtml}</body></html>`, { url }).window.document;
  sanitizeDocument(doc, url);
  return doc.body.innerHTML;
}

describe('sanitize: картинки', () => {
  it('заменяет картинку на её alt', () => {
    const html = clean('<p><img src="https://cdn.example.com/a.png" alt="Схема архитектуры"></p>');
    expect(html).toContain('изображение: Схема архитектуры');
    expect(html).not.toContain('cdn.example.com');
  });

  it('оставляет ссылку рабочей, а бейдж внутри превращает в текст', () => {
    const html = clean(
      '<a href="https://github.com/searxng"><img src="https://camo.githubusercontent.com/59c4ae90" alt="Organization"></a>',
    );
    expect(html).toContain('href="https://github.com/searxng"');
    expect(html).toContain('изображение: Organization');
    expect(html).not.toContain('camo.githubusercontent.com');
  });

  it('удаляет картинку без alt целиком', () => {
    const html = clean('<p>текст<img src="https://cdn.example.com/spacer.gif" alt="">после</p>');
    expect(html).not.toContain('cdn.example.com');
    expect(html).not.toContain('изображение');
    expect(html).toContain('текст');
    expect(html).toContain('после');
  });

  it('удаляет картинку с пробельным alt', () => {
    const html = clean('<p><img src="https://cdn.example.com/x.gif" alt="   "></p>');
    expect(html).not.toContain('изображение');
    expect(html).not.toContain('cdn.example.com');
  });
});

describe('sanitize: permalink-якоря', () => {
  it('убирает якорь-паразит у заголовка', () => {
    const html = clean(
      '<h2>Version 1.62<a href="#version-162" title="Direct link">\u200B</a></h2>',
    );
    expect(html).toContain('Version 1.62');
    expect(html).not.toContain('#version-162');
  });

  it('убирает якорь из одного символа-пилькроу', () => {
    const html = clean('<h2>Установка<a href="/page#install">¶</a></h2>');
    expect(html).not.toContain('#install');
    expect(html).not.toContain('¶');
  });

  it('оставляет якорь с содержательным текстом', () => {
    const html = clean('<p><a href="#install">см. раздел Установка</a></p>');
    expect(html).toContain('#install');
    expect(html).toContain('см. раздел Установка');
  });

  it('оставляет ссылку на якорь другой страницы', () => {
    const html = clean('<p><a href="https://other.example.com/doc#part">\u200B</a></p>');
    expect(html).toContain('other.example.com/doc#part');
  });

  it('оставляет ссылку на ту же страницу без хеша', () => {
    const html = clean('<p><a href="/page">та же страница</a></p>');
    expect(html).toContain('href="/page"');
  });
});
