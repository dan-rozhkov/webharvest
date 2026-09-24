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

  it('вырезает скип-линки и обвязку, которые извлекатель не убрал', () => {
    // Регрессия: defuddle 0.19.4 под jsdom 30.1 падает на своём селекторе
    // (лимит длины 2048) и МОЛЧА пропускает уборку обвязки, а его вывод —
    // самый длинный, поэтому он же и побеждает в выборе кандидата. На этой
    // странице нет article/main, так что семантическая ветка не спасёт.
    const page =
      '<html><head><title>Страница</title></head><body>' +
      '<a class="mw-jump-link" href="#content">Jump to content</a>' +
      '<ul class="a11y-menu"><li><a href="#search">Skip to main content</a></li></ul>' +
      '<div id="content"><h1>Заголовок</h1><p>' +
      'слово '.repeat(300) +
      '</p><footer><p>Privacy policy</p></footer></div>' +
      '</body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('Заголовок');
    expect(md).not.toContain('Jump to content');
    expect(md).not.toContain('Skip to main content');
    expect(md).not.toContain('Privacy policy');
  });

  it('чистит и запасную ветку: сырой body без кандидатов', () => {
    // Здесь ни одна из трёх стратегий не даёт полезного текста, и ответ строится
    // из сырого body — обвязка обязана исчезнуть и там.
    const page = '<html><body><a class="mw-jump-link" href="#content">Jump to content</a><p>кр</p></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).not.toContain('Jump to content');
  });

  it('сохраняет лид из <header> внутри статьи', () => {
    // Обвязку нельзя удалять по одному лишь тегу: <header> внутри статьи несёт
    // её заголовок и лид. Замер ревью: до этой проверки markdown такой страницы
    // получался пустым.
    const page =
      '<html><body><article><header><h1>Критичный заголовок</h1>' +
      '<p>Лид, без которого статья не читается.</p></header>' +
      '<section><p>' +
      'тело '.repeat(80) +
      '</p></section></article></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('Критичный заголовок');
    expect(md).toContain('Лид, без которого статья не читается');
  });

  it('сохраняет содержимое <form>, если это материал страницы', () => {
    const page =
      '<html><body><article><h1>Как оформить заказ</h1><form><h2>Шаг 1</h2><p>' +
      'описание заказа '.repeat(60) +
      '</p></form></article></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('Шаг 1');
    expect(md).toContain('описание заказа');
  });

  it('сохраняет форму внутри статьи, даже если заголовка в ней нет', () => {
    // Замер ревью (раунд 2): заголовок стоял ПЕРЕД формой, форма считалась
    // обвязкой и уезжала целиком.
    const page =
      '<html><body><article><h1>Оформление</h1><form><p>' +
      'описание заказа '.repeat(60) +
      '</p></form></article></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('описание заказа');
  });

  it('подвал с заголовком сохраняется как материал, но не считается мерой статьи', () => {
    // Ревью (раунд 2) показало, что подвал с <h2> внутри <main> мог раздувать
    // материал выше порога и прикрывать стену Turnstile. Решение раунда 4:
    // подвал как материал СОХРАНЯЕТСЯ (терять подписи и источники нельзя), а
    // стена ловится отдельной мерой — proseTextLength считает текст БЕЗ
    // озаглавленных подвалов/сайдбаров (см. тест про стену в escalation.test.ts).
    const page =
      '<html><body><main><p>' +
      'текст '.repeat(40) +
      '</p><footer><h2>Resources</h2><p>' +
      'подвал '.repeat(200) +
      '</p></footer></main></body></html>';
    const { markdown, textLength, proseTextLength } = extract(page, 'https://example.com/');
    expect(markdown).toContain('Resources');
    expect(textLength).toBeGreaterThan(1200);
    expect(proseTextLength).toBeLessThan(1200);
  });

  it('сохраняет заметку и источники в статье: это материал, а не обвязка', () => {
    // Обратная сторона того же правила (ревью, раунд 3): дополнение к статье
    // терять нельзя. Подвал/сайдбар остаются, если вокруг них есть материал.
    const page =
      '<html><body><article><p>' +
      'текст статьи '.repeat(40) +
      '</p><aside><h2>Примечание редактора</h2><p>УНИКАЛЬНАЯ ЗАМЕТКА</p></aside>' +
      '<footer><h2>Источники</h2><p>УНИКАЛЬНЫЙ ИСТОЧНИК</p></footer></article></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('УНИКАЛЬНАЯ ЗАМЕТКА');
    expect(md).toContain('УНИКАЛЬНЫЙ ИСТОЧНИК');
  });

  it('сохраняет лид, когда H1 стоит рядом с шапкой, а не внутри неё', () => {
    // Ревью (раунд 3): требование «H1 внутри шапки» теряло лид статьи.
    const page =
      '<html><body><h1>Заголовок</h1><article><header><p>УНИКАЛЬНЫЙ ЛИД</p></header><p>' +
      'тело '.repeat(80) +
      '</p></article></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('УНИКАЛЬНЫЙ ЛИД');
  });

  it('сохраняет дополнение длиннее статьи: заметка-интервью не теряется', () => {
    // Ревью (раунд 4): сравнение длины блока с остатком контейнера выбрасывало
    // материал, который длиннее самой статьи.
    const page =
      '<html><body><article><h1>Новость</h1><p>' +
      'коротко '.repeat(10) +
      '</p><aside><h2>Полное интервью</h2><p>' +
      'интервью '.repeat(120) +
      '</p></aside></article></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('Полное интервью');
    expect(md).toContain('интервью');
  });

  it('материал в скрытой вкладке не удаляется вместе со скрывающим стилем', () => {
    // Ревью (раунд 4): произвольно скрытый блок — не обвязка, под display:none
    // бывает настоящий материал (транскрипт, вкладка). Скрывающий стиль теперь
    // снимает только формы.
    const page =
      '<html><body><article><h1>История</h1><p>' +
      'вступление '.repeat(20) +
      '</p><section style="display:none"><h2>Транскрипт</h2><p>УНИКАЛЬНЫЙ ТРАНСКРИПТ</p></section>' +
      '</article></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('УНИКАЛЬНЫЙ ТРАНСКРИПТ');
  });

  it('форма с одной кнопкой сохранена, а форма-трекер без полей и прозы — нет', () => {
    // Ревью (раунд 4): кнопка отправки — тоже причина считать форму материалом.
    const page =
      '<html><body><main><h1>Оформление</h1><form><button>ПОДТВЕРДИТЬ ЗАКАЗ</button></form><p>' +
      'описание '.repeat(30) +
      '</p><form><p>ТРЕКЕР</p></form></main></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('ПОДТВЕРДИТЬ ЗАКАЗ');
    expect(md).not.toContain('ТРЕКЕР');
  });

  it('шапка сайта внутри <main> не уезжает в материал, если в main есть article', () => {
    // Ревью (раунд 4): правило «шапка внутри контейнера материала» пропускало
    // навигацию страницы, когда она лежит внутри <main> рядом с article.
    const page =
      '<html><body><main><header><p>НАВИГАЦИЯ САЙТА</p></header><article><h1>Статья</h1><p>' +
      'текст '.repeat(80) +
      '</p></article></main></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).not.toContain('НАВИГАЦИЯ САЙТА');
    expect(md).toContain('Статья');
  });

  it('удаляет формы-обвязку: без полей и прозы, скрытые инлайновым стилем', () => {
    // Ревью (раунд 3): форма трекинга со скрытым полем и форма со
    // style="display:none" уезжали в markdown как материал.
    const page =
      '<html><body><main><p>' +
      'материал '.repeat(60) +
      '</p><form><input type="hidden" name="track"></form>' +
      '<form><p>Мы используем cookie</p></form>' +
      '<form style="display:none"><p>СКРЫТАЯ ФОРМА</p></form>' +
      '</main></body></html>';
    const md = extract(page, 'https://example.com/').markdown;
    expect(md).toContain('материал');
    expect(md).not.toContain('Мы используем cookie');
    expect(md).not.toContain('СКРЫТАЯ ФОРМА');
  });
});
