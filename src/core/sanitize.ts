/**
 * Чистка DOM от того, что потребитель-агент физически не может использовать:
 * картинки, permalink-якоря, трекинговые хвосты, невидимые символы. Смысловой
 * чистки здесь нет и не будет — правила опознают мусор по структуре, а не по
 * содержанию, поэтому функция остаётся чистой и синхронной.
 */

/**
 * Картинку агент не видит: в markdown от неё остаётся только огромный URL,
 * который на README-страницах съедает больше половины ответа. Смысл несёт
 * alt, его и оставляем — обычным текстом, без квадратных скобок, которые
 * turndown всё равно экранирует в `\[`.
 */
function replaceImages(doc: Document): void {
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const alt = (img.getAttribute('alt') ?? '').trim();
    if (!alt) {
      img.remove();
      continue;
    }
    // Инлайновые иконки в заголовках и прозе — обычное дело: без разделителя
    // текст и alt слипаются в мусорный токен («текстизображение: схемапосле»).
    // Добавляем пробел с той стороны, где соседнего пробела ещё нет; отсутствие
    // соседа или сосед, не являющийся текстовым узлом, тоже считаются «нет».
    const prev = img.previousSibling;
    const next = img.nextSibling;
    const hasLeadingSpace = prev !== null && prev.nodeType === 3 && /\s$/.test(prev.nodeValue ?? '');
    const hasTrailingSpace = next !== null && next.nodeType === 3 && /^\s/.test(next.nodeValue ?? '');
    const left = prev === null || hasLeadingSpace ? '' : ' ';
    const right = next === null || hasTrailingSpace ? '' : ' ';
    img.replaceWith(doc.createTextNode(`${left}изображение: ${alt}${right}`));
  }
}

/**
 * Невидимые символы: soft hyphen, zero-width space, word joiner, BOM, плюс
 * диапазон Private Use Area (U+E000–U+F8FF). В PUA сидят глифы иконочных
 * шрифтов — Font Awesome, Material Icons и подобных. Без своего шрифта такой
 * символ не рендерится ничем осмысленным, но занимает токен и ломает поиск
 * по тексту.
 * ZWNJ (U+200C) и ZWJ (U+200D) сюда сознательно не входят: это не типографский
 * мусор, а значимые символы — ZWNJ разделяет словоформы в персидском, арабском
 * и индийских письменностях, а ZWJ склеивает emoji-последовательности (семья,
 * флаги). Их удаление меняет смысл текста.
 */
// Только escape-последовательности: литералы этих символов невидимы в исходнике
// и теряются при любом копировании.
const INVISIBLE = /[\u00AD\u200B\u2060\uFEFF\uE000-\uF8FF]/g;

/**
 * Та же чистка невидимых символов, но для отдельной строки, а не DOM —
 * для `title`/`description`, которые читаются из `<head>` до вызова
 * `sanitizeDocument` (который обходит только `body`).
 */
export function stripInvisibleFromText(text: string): string {
  return text.replace(INVISIBLE, '');
}

/** Значки, которыми генераторы документации помечают ссылку на саму себя. */
const PERMALINK_GLYPHS = /[¶#§🔗]/gu;

/**
 * Генераторы документации (Docusaurus, MkDocs, Sphinx, GitHub) вешают на каждый
 * заголовок ссылку на его же якорь с пустым или значковым текстом. Для агента это
 * чистый шум: перехода никуда нет, а в markdown попадает и URL, и title.
 * Ссылка на якорь с осмысленным текстом («см. раздел Установка») — не шум,
 * её не трогаем.
 */
function stripPermalinks(doc: Document, baseUrl: string): void {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return; // без валидной базы «та же страница» не определить
  }
  base.hash = '';

  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const raw = a.getAttribute('href');
    if (!raw) continue;
    // `target.hash` теряет голый `#`: `new URL('#', base).hash === ''`, из-за
    // чего `href="#"` и `href="/page#"` не отличить от ссылки вообще без
    // фрагмента. Проверяем наличие `#` по сырой строке, а не по разобранному URL.
    if (!raw.includes('#')) continue;
    let target: URL;
    try {
      target = new URL(raw, base);
    } catch {
      continue;
    }
    target.hash = '';
    if (target.href !== base.href) continue;

    const visible = (a.textContent ?? '')
      .replace(INVISIBLE, '')
      .replace(PERMALINK_GLYPHS, '')
      .trim();
    if (visible !== '') continue;
    a.remove();
  }
}

/**
 * Закрытый список: только параметры, которые заведомо ничего не значат для
 * содержимого. `ref`, `source` и подобные не трогаем — на форумах и в
 * документации они бывают значимыми, а сломанная ссылка хуже длинной.
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'igshid',
]);

function isTracking(name: string): boolean {
  // Почтовые клиенты и CMS регулярно поднимают регистр имён параметров
  // (`UTM_SOURCE`); значения при этом не трогаем.
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

/**
 * Имя параметра из сырого куска запроса `name=value` (или голого `name`)
 * — с той же деэкодировкой, что использует `URLSearchParams`, но без
 * сборки самой строки, чтобы не трогать процентное кодирование значения.
 */
function paramName(pair: string): string {
  const eqIndex = pair.indexOf('=');
  const raw = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * Хвосты рекламных кампаний в ссылках: место занимают, смысла не несут.
 * Строку href пересобираем вручную, а не через `url.href`: пересборка через
 * `URL` абсолютизирует относительные ссылки, переэкодирует `%20` в `+` у
 * значений и подставляет умолчания (порт, хвостовой `/`) — этого никто
 * не просил, задача — убрать конкретные параметры, а не нормализовать URL.
 * `URL` используется только как парсер, чтобы понять, какие параметры есть.
 */
function stripTrackingParams(doc: Document, baseUrl: string): void {
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const raw = a.getAttribute('href');
    if (!raw) continue;
    const hashIndex = raw.indexOf('#');
    const fragment = hashIndex === -1 ? '' : raw.slice(hashIndex);
    const beforeHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
    const qIndex = beforeHash.indexOf('?');
    if (qIndex === -1) continue;
    const path = beforeHash.slice(0, qIndex);
    const query = beforeHash.slice(qIndex + 1);

    // Сперва пробуем разобрать `raw` сам по себе: абсолютная ссылка не должна
    // зависеть от валидности `baseUrl`. `sanitizeDocument` экспортирован, и
    // невалидный `baseUrl` — не то же самое, что нерезолвимый относительный href.
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      try {
        parsed = new URL(raw, baseUrl);
      } catch {
        continue;
      }
    }
    const hasTracking = Array.from(parsed.searchParams.keys()).some(isTracking);
    if (!hasTracking) continue;

    const keptPairs = query.split('&').filter((pair) => pair !== '' && !isTracking(paramName(pair)));
    const newQuery = keptPairs.length > 0 ? `?${keptPairs.join('&')}` : '';
    a.setAttribute('href', `${path}${newQuery}${fragment}`);
  }
}

/**
 * Zero-width и прочая типографская невидимота: токены ест, поиск по тексту
 * ломает. Внутри `pre` и `code` не трогаем — там такой символ может быть
 * предметом обсуждения.
 *
 * Обход рекурсивный, а не через TreeWalker: `NodeFilter` живёт на window
 * внутри jsdom, а в глобальной области Node.js его нет. По той же причине
 * тип текстового узла сравнивается с литералом 3, а не с `Node.TEXT_NODE`.
 */
function stripInvisibleChars(doc: Document): void {
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        child.nodeValue = (child.nodeValue ?? '').replace(INVISIBLE, '');
        continue;
      }
      const el = child as Element;
      if (el.tagName === 'PRE' || el.tagName === 'CODE') continue;
      walk(child);
    }
  };
  walk(doc.body ?? doc.documentElement);
}

export function sanitizeDocument(doc: Document, baseUrl: string): void {
  // Порядок важен: `replaceImages` должен идти первым. Если сначала убирать
  // permalink-якоря, то `<a href="#fig1"><img alt="Диаграмма потока данных">
  // </a>` на момент проверки текста якоря ещё содержит только картинку —
  // `textContent` у неё пустой, и осмысленная картинка удаляется вместе
  // с «пустым» на вид якорем. Если сначала превращать картинки в текст, то
  // декоративный случай `<a href="#x"><img alt=""></a>` всё равно схлопывается
  // корректно: картинка без alt удаляется своим правилом, якорь становится
  // пустым и его ловит `stripPermalinks`, а картинки с осмысленным alt к этому
  // моменту уже стали видимым текстом и выживают.
  replaceImages(doc);
  stripPermalinks(doc, baseUrl);
  stripTrackingParams(doc, baseUrl);
  stripInvisibleChars(doc);
}
