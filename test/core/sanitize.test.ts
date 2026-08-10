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

  it('отделяет alt пробелом от соседних слов, если пробела ещё нет', () => {
    const html = clean('<p>текст<img src="https://cdn.example.com/a.png" alt="схема">после</p>');
    expect(html).toContain('текст изображение: схема после');
  });

  it('не плодит двойных пробелов, если сосед уже отделён пробелом', () => {
    const html = clean('<p>текст <img src="https://cdn.example.com/a.png" alt="схема"> после</p>');
    expect(html).toContain('текст изображение: схема после');
    expect(html).not.toMatch(/ {2,}/);
  });

  it('отделяет alt от заголовка, к которому картинка приклеена справа', () => {
    const html = clean('<h2>Заголовок<img src="https://cdn.example.com/icon.png" alt="иконка"></h2>');
    expect(html).toContain('Заголовок изображение: иконка');
  });

  it('сохраняет содержательную картинку внутри permalink-подобного якоря', () => {
    const html = clean(
      '<figure><a href="/page#fig1"><img src="https://cdn.example.com/d.png" alt="Диаграмма потока данных"></a><figcaption>Рис 1</figcaption></figure>',
    );
    expect(html).toContain('изображение: Диаграмма потока данных');
  });

  it('всё равно убирает декоративный якорь-картинку без alt', () => {
    const html = clean(
      '<h2>Заголовок<a href="#x"><img src="https://cdn.example.com/deco.png" alt=""></a></h2>',
    );
    expect(html).not.toContain('#x');
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

  it('убирает голый якорь href="#"', () => {
    const html = clean('<p><a href="#">\u200B</a></p>');
    expect(html).not.toContain('href="#"');
  });

  it('убирает якорь href="/page#" на ту же страницу с пустым хешем', () => {
    const html = clean('<p><a href="/page#">\u200B</a></p>');
    expect(html).not.toContain('href="/page#"');
  });
});

describe('sanitize: трекинговые параметры', () => {
  it('вычищает utm и подобное, сохраняя значимые параметры', () => {
    const html = clean(
      '<a href="https://shop.example.com/item?id=7&utm_source=news&utm_medium=email&fbclid=abc">товар</a>',
    );
    expect(html).toContain('id=7');
    expect(html).not.toContain('utm_source');
    expect(html).not.toContain('utm_medium');
    expect(html).not.toContain('fbclid');
  });

  it('убирает знак вопроса, если значимых параметров не осталось', () => {
    const html = clean('<a href="https://example.org/post?utm_source=news">пост</a>');
    expect(html).toContain('href="https://example.org/post"');
    expect(html).not.toContain('?');
  });

  it('не трогает ref и прочие неоднозначные параметры', () => {
    const html = clean('<a href="https://example.org/p?ref=hn&gclid=x">пост</a>');
    expect(html).toContain('ref=hn');
    expect(html).not.toContain('gclid');
  });

  it('не ломает ссылку без параметров', () => {
    const html = clean('<a href="https://example.org/plain">пост</a>');
    expect(html).toContain('href="https://example.org/plain"');
  });

  it('оставляет относительную ссылку относительной', () => {
    const html = clean('<a href="/page?utm_source=x&id=7">тут</a>');
    expect(html).toContain('href="/page?id=7"');
  });

  it('не переэкодирует значимые параметры', () => {
    const html = clean('<a href="https://example.org/s?q=a%20b&utm_source=x">поиск</a>');
    expect(html).toContain('q=a%20b');
    expect(html).not.toContain('q=a+b');
  });

  it('сохраняет фрагмент после чистки', () => {
    const html = clean('<a href="https://example.org/doc?utm_source=x#part">док</a>');
    expect(html).toContain('href="https://example.org/doc#part"');
  });
});

describe('sanitize: невидимые символы', () => {
  it('вычищает zero-width и soft hyphen из текста', () => {
    const html = clean('<p>сло\u00ADvo\u200B и\u2060 ещё\uFEFF</p>');
    expect(html).toContain('слоvo и ещё');
    expect(html).not.toMatch(/[\u00AD\u200B\u2060\uFEFF]/);
  });

  it('не трогает невидимые символы внутри code и pre', () => {
    const html = clean('<pre><code>const a = "\u200B";</code></pre>');
    expect(html).toContain('\u200B');
  });

  it('не трогает невидимые символы в inline-коде', () => {
    const html = clean('<p>смотри <code>a\u200Bb</code></p>');
    expect(html).toContain('a\u200Bb');
  });

  it('не трогает ZWNJ в персидском тексте', () => {
    const html = clean('<p>\u0645\u06CC\u200C\u0631\u0648\u062F</p>');
    expect(html).toContain('\u0645\u06CC\u200C\u0631\u0648\u062F');
  });

  it('не трогает ZWJ внутри emoji-последовательности', () => {
    const html = clean('<p>\u{1F468}\u200D\u{1F469}\u200D\u{1F467}</p>');
    expect(html).toContain('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}');
  });
});

describe('sanitize: регистр трекинговых параметров', () => {
  it('распознаёт UTM в верхнем регистре', () => {
    const html = clean('<a href="https://e.org/s?UTM_SOURCE=x&id=1">поиск</a>');
    expect(html).toContain('id=1');
    expect(html).not.toContain('UTM_SOURCE');
  });
});

describe('sanitize: невалидный baseUrl не отключает трекинг-чистку', () => {
  it('чистит трекинг у абсолютной ссылки, даже если baseUrl не парсится', () => {
    const doc = new JSDOM(
      '<html><body><a href="https://shop.example.com/item?utm_source=x&id=1">товар</a></body></html>',
      { url: PAGE },
    ).window.document;
    sanitizeDocument(doc, 'not a valid url');
    const html = doc.body.innerHTML;
    expect(html).toContain('id=1');
    expect(html).not.toContain('utm_source');
  });
});
