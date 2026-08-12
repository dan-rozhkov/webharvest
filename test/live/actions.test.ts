import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page, type ConsoleMessage } from 'playwright';
import { captureSnapshot } from '../../src/core/a11y/capture.js';
import { executeAction } from '../../src/core/actions.js';
import { HarvestError } from '../../src/core/errors.js';

const live = process.env.WEBHARVEST_LIVE === '1' ? describe : describe.skip;

// `;charset=utf-8` обязателен: без него Chromium декодирует data: URL как
// Latin-1, и кириллица («Страна», «Отправить» и т. д.) превращается в кашу.
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html><body>
    <input id="email" type="email" aria-label="Email">
    <input id="prefilled" aria-label="Заполнено" value="старое значение">
    <input id="editable" aria-label="Клавиша">
    <input id="search" aria-label="Поиск">
    <select id="country" aria-label="Страна">
      <option>Кипр</option><option>Грузия</option>
    </select>
    <button id="submit">Отправить</button>
    <div id="hoverTarget" aria-label="Наведи">Наведи сюда</div>
    <div id="log"></div>
    <div id="scroller" style="height:100px;overflow:auto" aria-label="Лента">
      <div style="height:1000px"></div>
    </div>
    <script>
      document.querySelector('#submit')
        .addEventListener('click', () => { document.querySelector('#log').textContent = 'нажато'; });
      document.querySelector('#hoverTarget')
        .addEventListener('mouseenter', () => { document.querySelector('#log').textContent = 'наведено'; });
    </script>
  </body></html>
`)}`;

live('actions: исполнение на живой странице', () => {
  let browser: Browser;
  let page: Page;
  let consoleWarnings: string[];

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    consoleWarnings = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'warning') consoleWarnings.push(msg.text());
    });
    await page.goto(PAGE);
  });

  afterEach(async () => {
    await browser?.close();
  });

  function idOf(outline: string, name: string): string {
    const line = outline.split('\n').find((l) => l.includes(name));
    if (!line) throw new Error(`в дереве нет строки с «${name}»:\n${outline}`);
    return /\[([\d-]+)\]/.exec(line)![1]!;
  }

  it('кликает', async () => {
    const snap = await captureSnapshot(page);
    await executeAction(page, { elementId: idOf(snap.outline, 'Отправить'), method: 'click', arguments: [] }, snap);
    expect(await page.textContent('#log')).toBe('нажато');
  });

  it('наводит курсор', async () => {
    const snap = await captureSnapshot(page);
    await executeAction(page, { elementId: idOf(snap.outline, 'Наведи'), method: 'hover', arguments: [] }, snap);
    expect(await page.textContent('#log')).toBe('наведено');
  });

  it('заполняет поле', async () => {
    const snap = await captureSnapshot(page);
    await executeAction(
      page,
      { elementId: idOf(snap.outline, 'Email'), method: 'fill', arguments: ['a@b.example'] },
      snap,
    );
    expect(await page.inputValue('#email')).toBe('a@b.example');
  });

  it('очищает поле пустым fill', async () => {
    const snap = await captureSnapshot(page);
    expect(await page.inputValue('#prefilled')).toBe('старое значение');
    await executeAction(
      page,
      { elementId: idOf(snap.outline, 'Заполнено'), method: 'fill', arguments: [''] },
      snap,
    );
    expect(await page.inputValue('#prefilled')).toBe('');
  });

  it('печатает посимвольно (type)', async () => {
    const snap = await captureSnapshot(page);
    await executeAction(page, { elementId: idOf(snap.outline, 'Поиск'), method: 'type', arguments: ['привет'] }, snap);
    expect(await page.inputValue('#search')).toBe('привет');
    // Метод type() на ElementHandle помечен @deprecated в типах Playwright;
    // проверяем, что реального предупреждения в консоли страницы это не даёт.
    expect(consoleWarnings).toEqual([]);
  });

  it('отправляет нажатие клавиши (press)', async () => {
    const snap = await captureSnapshot(page);
    expect(await page.inputValue('#editable')).toBe('');
    // Поле изначально пустое: каретка гарантированно в позиции 0, поэтому
    // результат нажатия не зависит от того, куда браузер её ставит при фокусе.
    await executeAction(page, { elementId: idOf(snap.outline, 'Клавиша'), method: 'press', arguments: ['a'] }, snap);
    expect(await page.inputValue('#editable')).toBe('a');
  });

  it('выбирает опцию нативного дропдауна по видимому тексту', async () => {
    const snap = await captureSnapshot(page);
    await executeAction(
      page,
      { elementId: idOf(snap.outline, 'Страна'), method: 'selectOptionFromDropdown', arguments: ['Грузия'] },
      snap,
    );
    expect(await page.inputValue('#country')).toBe('Грузия');
  });

  it('прокручивает элемент до заданной доли', async () => {
    const snap = await captureSnapshot(page);
    await executeAction(
      page,
      { elementId: idOf(snap.outline, 'Лента'), method: 'scrollTo', arguments: ['50%'] },
      snap,
    );
    const top = await page.evaluate(() => document.querySelector('#scroller')!.scrollTop);
    expect(top).toBeGreaterThan(100);
  });

  it('внятно жалуется на отсутствующий обязательный аргумент и метит его как invalid_request', async () => {
    const snap = await captureSnapshot(page);
    const promise = executeAction(
      page,
      { elementId: idOf(snap.outline, 'Email'), method: 'fill', arguments: [] },
      snap,
    );
    await expect(promise).rejects.toThrow(HarvestError);
    await expect(promise).rejects.toMatchObject({ code: 'invalid_request' });
  });

  // Ожидаемый по постановке пример — «selectOptionFromDropdown с подписью,
  // которой нет ни у одной опции» — на практике НЕ падает быстрой ошибкой:
  // Playwright трактует отсутствие совпадения как ещё не готовое к действию
  // состояние элемента и молча повторяет попытку до истечения таймаута
  // (проверено вручную: `elementHandle.selectOption` с несуществующей
  // подписью на реальном <select> висит и в итоге бросает
  // «Timeout Nms exceeded»), так что настоящая ошибка получит код
  // `timeout`, а не `invalid_request` — и это соответствует ветке кода,
  // которая осталась нетронутой правкой. Поэтому для проверки быстрой,
  // недвусмысленно не-сетевой и не-таймаутной ошибки взят другой пример из
  // самого finding-а — вызов `selectOptionFromDropdown` на элементе, который
  // вообще не является `<select>`: Playwright бросает
  // «Element is not a <select> element» немедленно, без цикла ожидания.
  it('selectOptionFromDropdown на не-<select> элементе — не сетевая ошибка, а invalid_request', async () => {
    const snap = await captureSnapshot(page);
    const promise = executeAction(
      page,
      { elementId: idOf(snap.outline, 'Отправить'), method: 'selectOptionFromDropdown', arguments: ['что угодно'] },
      snap,
    );
    await expect(promise).rejects.toThrow(HarvestError);
    await expect(promise).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
