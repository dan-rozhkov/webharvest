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
    img.replaceWith(doc.createTextNode(`изображение: ${alt}`));
  }
}

/** Невидимые символы: soft hyphen, zero-width, word joiner, BOM. */
// Только escape-последовательности: литералы этих символов невидимы в исходнике
// и теряются при любом копировании.
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

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
    let target: URL;
    try {
      target = new URL(raw, base);
    } catch {
      continue;
    }
    if (!target.hash) continue;
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
  return name.startsWith('utm_') || TRACKING_PARAMS.has(name);
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

    let parsed: URL;
    try {
      parsed = new URL(raw, baseUrl);
    } catch {
      continue;
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
  // Порядок важен: якорь `<a href="#x"><img alt=""></a>` опознаётся как пустой
  // только до того, как картинки превратятся в текст.
  stripPermalinks(doc, baseUrl);
  replaceImages(doc);
  stripTrackingParams(doc, baseUrl);
  stripInvisibleChars(doc);
}
