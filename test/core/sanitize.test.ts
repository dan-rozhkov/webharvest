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
