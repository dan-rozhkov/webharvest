import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { captureSnapshot } from '../../src/core/a11y/capture.js';
import { executeAction } from '../../src/core/actions.js';
import { HarvestError } from '../../src/core/errors.js';

const live = process.env.WEBHARVEST_LIVE === '1' ? describe : describe.skip;

// `;charset=utf-8` обязателен: без него Chromium декодирует data: URL как
// Latin-1, и кириллица («Страна», «Отправить» и т. д.) превращается в кашу.
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html><body>
    <input id="email" type="email" aria-label="Email">
    <select id="country" aria-label="Страна">
      <option>Кипр</option><option>Грузия</option>
    </select>
    <button id="submit">Отправить</button>
    <div id="log"></div>
    <div id="scroller" style="height:100px;overflow:auto" aria-label="Лента">
      <div style="height:1000px"></div>
    </div>
    <script>
      document.querySelector('#submit')
        .addEventListener('click', () => { document.querySelector('#log').textContent = 'нажато'; });
    </script>
  </body></html>
`)}`;

live('actions: исполнение на живой странице', () => {
  let browser: Browser;
  let page: Page;

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
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

  it('заполняет поле', async () => {
    const snap = await captureSnapshot(page);
    await executeAction(
      page,
      { elementId: idOf(snap.outline, 'Email'), method: 'fill', arguments: ['a@b.example'] },
      snap,
    );
    expect(await page.inputValue('#email')).toBe('a@b.example');
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

  it('внятно жалуется на отсутствующий обязательный аргумент', async () => {
    const snap = await captureSnapshot(page);
    await expect(
      executeAction(page, { elementId: idOf(snap.outline, 'Email'), method: 'fill', arguments: [] }, snap),
    ).rejects.toThrow(HarvestError);
  });
});
