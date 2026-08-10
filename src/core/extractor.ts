import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import DefuddleExport from 'defuddle';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { sanitizeDocument } from './sanitize.js';

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
}

/** Обвязка страницы: меню, шапки, подвалы, скрипты. Вырезается из семантического
 *  контейнера и из сырого body. */
const STRIP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="search"]',
  '[aria-hidden="true"]',
  '[hidden]',
  '.cookie-banner',
  '#cookie-banner',
  '.newsletter',
  '.advertisement',
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
  /** Объём читаемого текста: по нему выбираем лучшую из стратегий. */
  text: number;
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
    for (const sel of STRIP_SELECTORS) {
      for (const dead of Array.from(el.querySelectorAll(sel))) dead.remove();
    }
    const content = el.innerHTML;
    const text = plainTextLength(content);
    if (text > MIN_USEFUL_TEXT) return { content, text };
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
    const text = result?.content ? plainTextLength(result.content) : 0;
    if (result?.content && text > MIN_USEFUL_TEXT) {
      return { content: result.content, title: result.title, text };
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
    const text = parsed?.content ? plainTextLength(parsed.content) : 0;
    if (parsed?.content && text > MIN_USEFUL_TEXT) {
      return {
        content: parsed.content,
        title: parsed.title ?? undefined,
        text,
      };
    }
  } catch {
    /* деградируем до сырого body */
  }
  return null;
}

/** Последний рубеж: чистим body руками. Скрипты и стили обязаны исчезнуть. */
function runRawBody(html: string, url: string): Picked {
  let bodyHtml = '';
  try {
    const doc = new JSDOM(html, { url }).window.document;
    for (const sel of STRIP_SELECTORS) {
      for (const el of Array.from(doc.querySelectorAll(sel))) el.remove();
    }
    bodyHtml = doc.body?.innerHTML ?? '';
  } catch {
    /* остаётся пустая строка */
  }
  return { content: bodyHtml, text: plainTextLength(bodyHtml) };
}

/**
 * Три стратегии видят страницу по-разному; берём ту, что вытащила больше текста,
 * а если не справилась ни одна — чистим сырой body.
 */
function pickContent(html: string, url: string): Picked {
  const candidates = [runSemantic(html, url), runDefuddle(html, url), runReadability(html, url)]
    .filter((c): c is Picked => c !== null);
  let best: Picked | null = null;
  for (const c of candidates) if (!best || c.text > best.text) best = c;
  return best ?? runRawBody(html, url);
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

  return {
    markdown,
    title: documentTitle || picked.title?.trim() || '',
    description,
    links,
    meta,
    textLength: plainTextLength(markdown),
  };
}
