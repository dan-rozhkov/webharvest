import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import DefuddleExport from 'defuddle';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { sanitizeDocument, stripInvisibleFromText } from './sanitize.js';

export interface ExtractedLink {
  href: string;
  text: string;
}

export interface Extracted {
  markdown: string;
  title: string;
  description: string | null;
  links: ExtractedLink[];
  meta: { author?: string; publishedAt?: string; siteName?: string; lang?: string };
  /** Длина читаемого текста в markdown без разметки. Эвристика эскалации Task 7. */
  textLength: number;
  /**
   * Есть ли в материале поля, которые заполняет человек (видимый ввод любого
   * заполняемого типа, `textarea`, `select`). Нужно правилу Turnstile-виджета:
   * страница формы — не стена, даже если материала на ней мало.
   */
  hasFormField: boolean;
  /**
   * Тот же материал, но без текста сохранённых озаглавленных подвалов и
   * сайдбаров. Это мера для правила Turnstile-виджета: обвязка, окружающая
   * стену, не должна поднимать её «материал» выше порога и превращать стену в
   * статью. Для настоящей статьи разница мала, для стены в шаблоне сайта —
   * решающая.
   */
  proseTextLength: number;
}

/**
 * Обвязка, которая контентом быть не может: удаляем всегда — и из
 * семантического контейнера, и из сырого body, и из готовой выдачи извлекателя.
 */
const STRUCTURAL_STRIP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  '[aria-hidden="true"]',
  '[hidden]',
  '.cookie-banner',
  '#cookie-banner',
  '.newsletter',
  '.advertisement',
  // Скрытая инлайновым стилем ФОРМА — обвязка (куки-панель, трекер). Именно
  // форма, а не любой скрытый блок: под `display:none` бывает и настоящий
  // материал вкладки или аккордеона (ревью, раунд 4 — терялся транскрипт).
  'form[style*="display:none"]',
  'form[style*="display: none"]',
  'form[style*="visibility:hidden"]',
  'form[style*="visibility: hidden"]',
];

/**
 * Обвязка, которая материалом быть не может: меню и поиск. Удаляется всегда, вне
 * зависимости от заголовков внутри. Замер, из-за которого правило такое:
 * подвал с `<h2>Resources</h2>` внутри `<main>` оставался в тексте стены
 * Turnstile, поднимал объём материала выше порога, и стена уезжала агенту как
 * контент (ревью, раунд 2).
 */
const ALWAYS_CHROME_SELECTORS = ['nav', '[role="navigation"]', '[role="search"]'];

/**
 * Шапка, подвал и сайдбар бывают и обвязкой, и материалом — но признаки у них
 * разные.
 *
 * - `header` сохраняем, если он внутри контейнера материала. Внутри статьи это
 *   её заголовок с лидом; шапка сайта, из-за которой в markdown уезжал «Sign up»
 *   (тест github-repo), лежит на уровне страницы — вне контейнера. Заголовок
 *   внутри шапки не требуем: у лида он бывает и рядом с ней —
 *   `<h1>…</h1><article><header><p>ЛИД` терял лид (ревью, раунд 3).
 * - `aside`/`footer` сохраняем только если внутри есть заголовок И в контейнере
 *   есть материал помимо них. Заметка редактора и список источников — материал;
 *   подвал-обвязка, который изображает из себя содержимое стены, материала не
 *   несёт — именно так стена и проходила за контент.
 *
 * Цена решения: шапка с лидом на вёрстке БЕЗ article/main (например,
 * `<div id="content"><header><h1>…`), считается обвязкой, и лид в markdown не
 * попадёт (незакрытый контрпример ревью, раунд 3). Осознанный выбор в пользу
 * того, чтобы шапки сайтов не уезжали в контент; заголовок документа при этом
 * всё равно отдаётся отдельным полем.
 */
const CONTENT_HEADER_SELECTORS = ['header', '[role="banner"]'];
const CONTENT_BLOCK_SELECTORS = ['aside', 'footer', '[role="complementary"]', '[role="contentinfo"]'];

/** Заголовок, отличающий материал от обвязки, у подвалов и сайдбаров. */
const CONTENT_HEADING = 'h1, h2, h3';

/** Контейнеры, внутри которых лежит материал статьи. */
const CONTENT_ROOT = 'article, main, [role="main"]';

/** Видимое поле: ввод заполняемого типа, `textarea`, `select`. Кнопки и файлы
 *  не «заполнить», а отправить/приложить; скрытый токен Turnstile
 *  (`type="hidden"`) полем тоже не считается. */
const VISIBLE_FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="image"]):not([type="file"]), textarea, select';

/** Имя класса/идентификатор, по которому поле явно спрятано: ловушка для ботов
 *  (`honeypot`), утилиты доступности (`visually-hidden`, `sr-only`). Вычисленных
 *  стилей на HTTP-пути у нас нет, поэтому это подсказка по имени, а не проверка. */
const HIDDEN_LOOKING = /(^|[\s_-])(hidden|honeypot|visually-?hidden|sr-only)([\s_-]|$)/i;

/** Видимая кнопка отправки: форма с ней — материал, а не трекер. */
const SUBMIT_CONTROL_SELECTOR = 'button, input[type="submit"], input[type="image"]';

/** Разметка самого виджета Turnstile: поля внутри неё — не поля страницы. */
const WIDGET_CONTAINER_SELECTOR = '.cf-turnstile, [data-sitekey]';

/**
 * Материал ли подвал/сайдбар: он внутри контейнера материала и несёт заголовок.
 *
 * Длину блока с остатком контейнера НЕ сравниваем. Сравнение (`rest >= blockText`)
 * давало обе ошибки сразу: выбрасывало содержательное дополнение длиннее статьи
 * (интервью, транскрипт) и всё равно сохраняло длинную обвязку стены (ревью,
 * раунд 4). Мусор в markdown — приемлемая плата за сохранённый материал, а от
 * обвязки стену защищает отдельная мера: правило виджета считает материал БЕЗ
 * озаглавленных подвалов/сайдбаров (см. `proseTextLength`).
 */
function isContentBlock(el: Element): boolean {
  return el.closest(CONTENT_ROOT) !== null && el.querySelector(CONTENT_HEADING) !== null;
}

/**
 * Шапка материала ли это. Шапка сайта внутри `<main>` — обвязка: если в контейнере
 * есть `article`, материал — он, а шапка рядом с ним принадлежит странице
 * (ревью, раунд 4: `<main><header>SITE NAVIGATION</header><article>…`).
 */
function isContentHeader(el: Element): boolean {
  const root = el.closest(CONTENT_ROOT);
  if (!root) return false;
  const article = root.querySelector('article');
  return !article || article.contains(el);
}

/** Измеренные меры материала, нужные правилу Turnstile-виджета в escalation.ts. */
interface CleanedContent {
  html: string;
  hasFormField: boolean;
  /** Объём текста в сохранённых озаглавленных подвалах/сайдбарах. Вычитается из
   *  материала для правила виджета: обвязка стены не должна превращать стену в
   *  статью (см. `Extracted.proseTextLength`). */
  blockTextLength: number;
}

/**
 * Есть ли в срезе материала поле, которое заполняет человек. Поля внутри самого
 * виджета не в счёт: чекбокс Turnstile живёт в кросс-доменном iframe, а in-page
 * там только скрытый токен; иначе стена с виджетом считалась бы страницей формы.
 * Поля, спрятанные по имени класса (honeypot, visually-hidden), тоже не в счёт —
 * у настоящей формы рядом остаются видимые поля.
 */
function hasFormField(root: Element): boolean {
  for (const field of Array.from(root.querySelectorAll(VISIBLE_FIELD_SELECTOR))) {
    if (field.closest(WIDGET_CONTAINER_SELECTOR)) continue;
    const name = `${field.getAttribute('class') ?? ''} ${field.getAttribute('id') ?? ''}`;
    if (HIDDEN_LOOKING.test(name)) continue;
    return true;
  }
  return false;
}

/**
 * Скип-линки («Skip to main content», «Jump to content») — навигационные
 * помощники для клавиатуры. Лежат прямыми детьми `<body>`, то есть вне
 * `nav`/`header`, поэтому STRIP_SELECTORS их не ловит. Селекторы сняты с живых
 * страниц, на которых тесты ловили утечку: Wikipedia (vector skin), MDN,
 * VitePress (документация vitest), Docusaurus (документация playwright).
 */
const SKIP_LINK_SELECTORS = [
  'a.mw-jump-link',
  '.a11y-menu',
  '.VPSkipLink',
  '[class^="skipToContent"]',
  '[role="region"][aria-label^="Skip to"]',
];

/**
 * Обвязка блоков кода: ярлык языка и кнопка «скопировать». Убираем до извлечения —
 * Defuddle приклеивает такой ярлык к первой строке кода (`bashnpm install`), а язык
 * мы и так берём из класса и выносим в заголовок ограждённого блока.
 */
const CODE_CHROME_SELECTORS = ['span.lang', 'span.language-name', 'button.copy'];

/** Минимальный объём текста, при котором результат извлекателя считается удачным. */
const MIN_USEFUL_TEXT = 200;

/** Теги табличной вёрстки, которые разворачиваем в div у layout-таблиц. */
const TABLE_TAGS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION']);

function languageOf(el: Element | null): string {
  for (const cls of Array.from(el?.classList ?? [])) {
    const m = /^(?:language|lang|highlight-source)-([\w+#-]+)$/.exec(cls);
    if (m?.[1]) return m[1];
  }
  const brush = /brush:\s*([\w+#-]+)/.exec(el?.getAttribute('class') ?? '');
  return brush?.[1] ?? '';
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript']);
  // Блоки кода с языком: подсказка нужна агенту, а turndown берёт класс
  // только с <code>, тогда как половина сайтов вешает его на <pre>.
  td.addRule('fencedCodeWithLanguage', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const el = node as unknown as Element;
      const codes = Array.from(el.querySelectorAll('code'));
      // Несколько <code> в одном <pre> — это части одного листинга: берём весь <pre>.
      const source = codes.length === 1 ? codes[0]! : el;
      const lang = languageOf(codes[0] ?? null) || languageOf(el);
      const text = (source.textContent ?? '').replace(/\n+$/, '');
      // Ограждение должно быть длиннее самой длинной цепочки кавычек внутри кода.
      const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });
  return td;
}

function absolutize(doc: Document, baseUrl: string): void {
  for (const el of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = el.getAttribute('href');
    if (!href) continue;
    try {
      el.setAttribute('href', new URL(href, baseUrl).toString());
    } catch {
      /* нерезолвимый href оставляем как есть */
    }
  }
  for (const el of Array.from(doc.querySelectorAll('img[src]'))) {
    const src = el.getAttribute('src');
    if (!src) continue;
    try {
      el.setAttribute('src', new URL(src, baseUrl).toString());
    } catch {
      /* нерезолвимый src оставляем как есть */
    }
  }
}

/**
 * `<base href>` overrides the document's own URL as the base for every
 * relative link/src on the page — common on docs generators and GitHub
 * Pages. Ignoring it (resolving against the fetched `url` instead) silently
 * produces wrong absolute URLs that look plausible, and the agent then goes
 * on to scrape the wrong pages.
 */
function resolveBase(doc: Document, url: string): string {
  const raw = doc.querySelector('base[href]')?.getAttribute('href');
  if (!raw) return url;
  try {
    return new URL(raw, url).toString();
  } catch {
    return url;
  }
}

function metaContent(doc: Document, names: string[]): string | undefined {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    const c = el?.getAttribute('content')?.trim();
    if (c) return c;
  }
  return undefined;
}

function collectLinks(doc: Document, baseUrl: string): ExtractedLink[] {
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const raw = a.getAttribute('href');
    if (!raw) continue;
    let href: string;
    try {
      href = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: (a.textContent ?? '').trim().slice(0, 200) });
  }
  return links;
}

/**
 * Считает читаемый текст: содержимое блоков кода сохраняется (агент его читает),
 * а разметка — символы markdown, экранирование, цели ссылок и уцелевшие теги — нет.
 */
function plainTextLength(markdown: string): number {
  return markdown
    .replace(/<[^>]+>/g, '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/[#>*_`|]/g, '')
    .replace(/^[ \t]*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim().length;
}

function cleanupMarkdown(md: string): string {
  return md
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Таблица с данными (есть собственная шапка) конвертируется в GFM; всё прочее — вёрстка.
 * Шапка вложенной таблицы не считается: иначе layout-таблица, обёрнутая вокруг таблицы
 * с данными, никогда не развернётся и уедет в markdown сырым HTML.
 */
function isDataTable(table: Element): boolean {
  return Array.from(table.querySelectorAll('th, thead')).some(
    (head) => head.closest('table') === table,
  );
}

/**
 * Разворачивает layout-таблицы в div: turndown не умеет их конвертировать и
 * оставляет сырой HTML в markdown (например, вся главная Hacker News).
 */
function unwrapLayoutTables(root: Element, doc: Document): void {
  for (let guard = 0; guard < 10_000; guard++) {
    const table = Array.from(root.querySelectorAll('table')).find((t) => !isDataTable(t));
    if (!table) return;
    renameToDiv(table, doc);
  }
}

function renameToDiv(el: Element, doc: Document): void {
  const div = doc.createElement('div');
  while (el.firstChild) div.appendChild(el.firstChild);
  el.replaceWith(div);
  for (const child of Array.from(div.querySelectorAll('*'))) {
    if (!TABLE_TAGS.has(child.tagName)) continue;
    if (child.tagName === 'TABLE' && isDataTable(child)) continue;
    if (child.closest('table') !== null) continue; // внутри уцелевшей таблицы с данными
    renameToDiv(child, doc);
  }
  for (const dead of Array.from(div.querySelectorAll('colgroup, col'))) dead.remove();
}

interface Picked {
  content: string;
  title?: string;
  /** Объём читаемого текста в `content` — по нему выбираем лучшую стратегию. */
  text: number;
  /**
   * Уборка обвязки. Ленивая намеренно: closure держит документ, в котором
   * кандидат уже разобран, поэтому уборка не требует нового JSDOM, но и не
   * выполняется для кандидатов, до которых не дошла очередь. Замер на
   * nodejs-blog: уборка всех трёх кандидатов давала +12% ко времени extract()
   * (892 → 1004 мс), ленивая уборка одного победителя держит лучший прогон на
   * уровне HEAD (887 против 893 мс; средние шумят под нагрузкой машины).
   */
  clean: () => CleanedContent;
}

/** Выбранный кандидат: очищенный материал плюс его меры для эскалации. */
interface Chosen {
  content: string;
  title?: string;
  text: number;
  hasFormField: boolean;
  /** См. CleanedContent.blockTextLength. */
  blockTextLength: number;
}

/**
 * Разметочный контейнер страницы, очищенный от обвязки. Извлекатели-эвристики
 * склонны терять лид: на MDN, например, `<h1>` и вводные абзацы лежат в соседнем
 * блоке, и Defuddle с Readability отдают статью, начиная со второго заголовка.
 */
function runSemantic(html: string, url: string): Picked | null {
  try {
    const doc = new JSDOM(html, { url }).window.document;
    const el =
      doc.querySelector('article') ??
      doc.querySelector('main') ??
      doc.querySelector('[role="main"]');
    if (!el) return null;
    const content = el.innerHTML;
    const text = plainTextLength(content);
    if (text > MIN_USEFUL_TEXT) {
      // Чистим НА МЕСТЕ, а не в отцепленном контейнере: контейнер материала
      // (article/main) тут настоящий, и признак «внутри контейнера» должен
      // работать по живой странице — иначе <header> с заголовком статьи
      // потеряет свой article и уедет вместе с обвязкой.
      return {
        content,
        text,
        clean: () => {
          const { blockTextLength } = stripChrome(el);
          return { html: el.innerHTML, hasFormField: hasFormField(el), blockTextLength };
        },
      };
    }
  } catch {
    /* деградируем до эвристических извлекателей */
  }
  return null;
}

/**
 * Точка входа `defuddle/node` объявлена только для `import` и вдобавок асинхронна,
 * а её JSDOM ходит в сеть (`resources: 'usable'`). Берём синхронный класс из
 * основной точки входа: extract обязан быть чистой функцией без I/O.
 * Типы пакета собраны для ESM и под NodeNext теряют конструктор, отсюда приведение.
 */
const DefuddleClass = DefuddleExport as unknown as new (
  doc: Document,
  options?: { url?: string },
) => { parse(): { content?: string; title?: string } | null };

/**
 * Defuddle безусловно пишет в stdout «Initial parse returned very little content»
 * на каждой скудной странице. Нам нужен чистый вывод тестов и логов демона,
 * а вызов синхронный — подменить console.log на время разбора безопасно.
 */
function withoutConsoleLog<T>(fn: () => T): T {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

/** Основной извлекатель. Класс синхронный — extract обязан быть чистой функцией без I/O. */
function runDefuddle(html: string, url: string): Picked | null {
  try {
    const dom = new JSDOM(html, { url });
    const result = withoutConsoleLog(() => new DefuddleClass(dom.window.document, { url }).parse());
    if (!result?.content) return null;
    const content = result.content;
    const text = plainTextLength(content);
    if (text > MIN_USEFUL_TEXT) {
      // Выдачу эвристики разбираем в отцепленном контейнере (см. cleanFragment):
      // её разметка уже не связана со страницей, и признак «внутри контейнера
      // материала» отвечает честно — шапка маркетинговой страницы GitHub с
      // заголовком внутри себя контейнером не является и уезжает как обвязка.
      return { content, title: result.title, text, clean: () => cleanFragment(dom.window.document, content) };
    }
  } catch {
    /* деградируем до Readability */
  }
  return null;
}

function runReadability(html: string, url: string): Picked | null {
  try {
    const dom = new JSDOM(html, { url });
    const parsed = new Readability(dom.window.document).parse();
    if (!parsed?.content) return null;
    const content = parsed.content;
    const text = plainTextLength(content);
    if (text > MIN_USEFUL_TEXT) {
      return {
        content,
        title: parsed.title ?? undefined,
        text,
        clean: () => cleanFragment(dom.window.document, content),
      };
    }
  } catch {
    /* деградируем до сырого body */
  }
  return null;
}

/** Последний рубеж: чистим body руками. Скрипты и стили обязаны исчезнуть. */
function runRawBody(html: string, url: string): Chosen {
  let bodyHtml = '';
  let hasField = false;
  let blockTextLength = 0;
  try {
    const doc = new JSDOM(html, { url }).window.document;
    // Чистим весь документ, а не только контейнеры извлекателей: сырой body —
    // это и есть та ветка, где обвязка попадает в markdown, если её не убрать.
    blockTextLength = stripChrome(doc.documentElement).blockTextLength;
    bodyHtml = doc.body?.innerHTML ?? '';
    hasField = doc.body ? hasFormField(doc.body) : false;
  } catch {
    /* остаётся пустая строка */
  }
  return { content: bodyHtml, text: plainTextLength(bodyHtml), hasFormField: hasField, blockTextLength };
}

/**
 * Убирает обвязку из готового содержимого (или из документа страницы).
 *
 * Это НАША гарантия, а не надежда на извлекатель. Повод измеренный: ночной bump
 * поднял jsdom 30.0.1 → 30.1.x и вместе с ним `@asamuzakjp/dom-selector` 8.3.2 →
 * 9.2.x, где появился лимит длины селектора в 2048 символов. Defuddle 0.19.4 на
 * страницах тестовой пачки строит селектор длиннее лимита, ловит RangeError
 * своим `removeBySelector`-onError, пишет «Defuddle Error processing document»
 * в stdout и **продолжает работу без чистки**. Обвязка (скип-линки, шапка,
 * подвал) остаётся в его выдаче, а так как она же делала выдачу самой длинной,
 * грязный кандидат ещё и выигрывал выбор в pickContent.
 *
 * Поэтому чистим кандидатов сами и до сравнения объёма — упавшая уборка не
 * должна означать «отдай мусор агенту». Элементы с заголовком внутри не
 * трогаем: см. CHROME_STRIP_SELECTORS.
 */
function stripChrome(root: Element): { blockTextLength: number } {
  for (const sel of STRUCTURAL_STRIP_SELECTORS) {
    for (const dead of Array.from(root.querySelectorAll(sel))) dead.remove();
  }
  for (const sel of ALWAYS_CHROME_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) el.remove();
  }
  // Форма без единого видимого поля — обвязка трекинга. Форма с полями, с
  // кнопкой отправки или с прозой остаётся: это материал страницы (заказ, вход,
  // `<form><h2>Шаг 1</h2><p>…`).
  for (const form of Array.from(root.querySelectorAll('form'))) {
    if (form.querySelector(VISIBLE_FIELD_SELECTOR)) continue;
    if (form.querySelector(SUBMIT_CONTROL_SELECTOR)) continue;
    if (plainTextLength(form.innerHTML) > MIN_USEFUL_TEXT) continue;
    form.remove();
  }
  // Подвалы и сайдбары: сохраняем материал (заметки, источники), удаляем
  // обвязку. Сумма текста сохранённых блоков становится мерой кандидата.
  let blockTextLength = 0;
  for (const sel of CONTENT_BLOCK_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) {
      if (!isContentBlock(el)) {
        el.remove();
        continue;
      }
      blockTextLength += plainTextLength(el.innerHTML);
    }
  }
  for (const sel of [...CONTENT_HEADER_SELECTORS, ...SKIP_LINK_SELECTORS]) {
    for (const el of Array.from(root.querySelectorAll(sel))) {
      // Шапка внутри контейнера материала — шапка статьи, а не сайта.
      if (CONTENT_HEADER_SELECTORS.includes(sel) && isContentHeader(el)) continue;
      el.remove();
    }
  }
  return { blockTextLength };
}

/**
 * Разбирает выдачу извлекателя в уже открытом документе и сразу чистит её.
 * Отдельный JSDOM на кандидата не нужен: разбор фрагмента в готовом документе
 * дешевле на порядок (замер ревью на статье: 53.6 мс → 75.4 мс, если заводить
 * новый JSDOM на каждого кандидата).
 */
function cleanFragment(doc: Document, contentHtml: string): CleanedContent {
  const holder = doc.createElement('div');
  holder.innerHTML = contentHtml;
  const { blockTextLength } = stripChrome(holder);
  return { html: holder.innerHTML, hasFormField: hasFormField(holder), blockTextLength };
}

/**
 * Три стратегии видят страницу по-разному. Порядок — по объёму СЫРОГО текста,
 * а пригодность решаем по очищенному: уборка обвязки ленивая (см. Picked.clean),
 * поэтому обычно платим за неё один раз — за победителя. Кандидат, который
 * после уборки остался без материала, пропускаем: значит, он и был обвязкой.
 */
function pickContent(html: string, url: string): Chosen {
  const candidates = [runSemantic(html, url), runDefuddle(html, url), runReadability(html, url)].filter(
    (c): c is Picked => c !== null,
  );
  let fallback: Chosen | null = null;
  for (const c of [...candidates].sort((a, b) => b.text - a.text)) {
    const cleaned = c.clean();
    const text = plainTextLength(cleaned.html);
    const picked: Chosen = {
      content: cleaned.html,
      text,
      hasFormField: cleaned.hasFormField,
      blockTextLength: cleaned.blockTextLength,
    };
    if (c.title) picked.title = c.title;
    if (text > MIN_USEFUL_TEXT) return picked;
    if (!fallback || text > fallback.text) fallback = picked;
  }
  return fallback ?? runRawBody(html, url);
}

function toMarkdown(contentHtml: string, url: string): string {
  try {
    const doc = new JSDOM('<body></body>', { url }).window.document;
    const holder = doc.createElement('div');
    holder.innerHTML = contentHtml;
    unwrapLayoutTables(holder, doc);
    return cleanupMarkdown(makeTurndown().turndown(holder.innerHTML));
  } catch {
    return '';
  }
}

export function extract(html: string, url: string): Extracted {
  const source = html.trim() ? html : '<html><body></body></html>';
  const dom = new JSDOM(source, { url });
  const doc = dom.window.document;

  const documentTitle =
    doc.querySelector('title')?.textContent?.trim() ||
    metaContent(doc, ['og:title', 'twitter:title']) ||
    doc.querySelector('h1')?.textContent?.trim() ||
    '';
  const description =
    metaContent(doc, ['og:description', 'description', 'twitter:description']) ?? null;
  const meta = {
    author: metaContent(doc, ['author', 'article:author']),
    publishedAt: metaContent(doc, ['article:published_time', 'datePublished']),
    siteName: metaContent(doc, ['og:site_name']),
    lang: doc.documentElement.getAttribute('lang') ?? undefined,
  };

  const effectiveBase = resolveBase(doc, url);
  absolutize(doc, effectiveBase);
  // До collectLinks: тогда чистыми выходят и markdown, и список ссылок.
  sanitizeDocument(doc, effectiveBase);
  const links = collectLinks(doc, effectiveBase);
  for (const sel of CODE_CHROME_SELECTORS) {
    for (const dead of Array.from(doc.querySelectorAll(sel))) dead.remove();
  }
  const normalizedHtml = doc.documentElement.outerHTML;

  const picked = pickContent(normalizedHtml, url);
  const markdown = toMarkdown(picked.content, url);
  const textLength = plainTextLength(markdown);

  return {
    markdown,
    // `sanitizeDocument` чистит невидимые символы только в body: title и
    // description читаются из head раньше, поэтому чистим их отдельно.
    title: stripInvisibleFromText(documentTitle || picked.title?.trim() || ''),
    description: description === null ? null : stripInvisibleFromText(description),
    links,
    meta,
    textLength,
    hasFormField: picked.hasFormField,
    // Мера для правила Turnstile-виджета: материал без сохранённых
    // озаглавленных подвалов и сайдбаров. Обвязка стены не должна превращать
    // стену в статью (ревью, раунды 2 и 4). Вычитаем объём, измеренный по
    // разметке, — на порог 1200 расхождение с markdown не влияет.
    proseTextLength: Math.max(0, textLength - picked.blockTextLength),
  };
}
