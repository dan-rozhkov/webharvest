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

export function sanitizeDocument(doc: Document, baseUrl: string): void {
  void baseUrl; // используется правилами из задач 2 и 3
  replaceImages(doc);
}
