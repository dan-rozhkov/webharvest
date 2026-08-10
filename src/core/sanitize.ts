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

export function sanitizeDocument(doc: Document, baseUrl: string): void {
  // Порядок важен: якорь `<a href="#x"><img alt=""></a>` опознаётся как пустой
  // только до того, как картинки превратятся в текст.
  stripPermalinks(doc, baseUrl);
  replaceImages(doc);
}
