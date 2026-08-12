import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { captureSnapshot } from '../../src/core/a11y/capture.js';
import { resolveElement } from '../../src/core/a11y/resolve.js';
import { HarvestError } from '../../src/core/errors.js';

const live = process.env.WEBHARVEST_LIVE === '1' ? describe : describe.skip;

// Без ;charset=utf-8 Chromium декодирует data:-урл как Latin-1, и кириллица
// превращается в мойбейк — заголовок ниже специально по-русски, чтобы это
// вскрылось сразу, а не мимикрировало под случайно совпавшую ASCII-строку.
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html><body>
    <!-- Кнопки для проверки резолва адреса в живой элемент -->
    <button id="login">Войти</button>
    <div id="host"></div>
    <script>
      const host = document.querySelector('#host');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<button id="inner">Внутри тени</button>';
    </script>
  </body></html>
`)}`;

live('a11y/resolve: резолв на живой странице', () => {
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

  /** Находит адрес строки outline по подстроке имени. */
  function idOf(outline: string, name: string): string {
    const line = outline.split('\n').find((l) => l.includes(name));
    if (!line) throw new Error(`в дереве нет строки с «${name}»:\n${outline}`);
    return /\[([\d-]+)\]/.exec(line)![1]!;
  }

  it('поднимает кликабельный элемент по адресу', async () => {
    const snap = await captureSnapshot(page);
    const el = await resolveElement(page, idOf(snap.outline, 'Войти'), snap);
    expect(await el.textContent()).toBe('Войти');
    await el.click(); // не должно бросить
  });

  it('достаёт элемент из-под shadow root', async () => {
    const snap = await captureSnapshot(page);
    const el = await resolveElement(page, idOf(snap.outline, 'Внутри тени'), snap);
    expect(await el.textContent()).toBe('Внутри тени');
  });

  it('переживает перерисовку узла, падая на путь по XPath', async () => {
    const snap = await captureSnapshot(page);
    const id = idOf(snap.outline, 'Войти');
    // Пересоздаём кнопку: backendNodeId становится недействительным, XPath — нет.
    await page.evaluate(() => {
      const old = document.querySelector('#login')!;
      const fresh = document.createElement('button');
      fresh.id = 'login';
      fresh.textContent = 'Войти';
      old.replaceWith(fresh);
    });
    const el = await resolveElement(page, id, snap);
    expect(await el.textContent()).toBe('Войти');
  });

  it('внятно жалуется на исчезнувший элемент', async () => {
    const snap = await captureSnapshot(page);
    const id = idOf(snap.outline, 'Войти');
    await page.evaluate(() => document.querySelector('#login')!.remove());
    await expect(resolveElement(page, id, snap)).rejects.toThrow(HarvestError);
  });
});
