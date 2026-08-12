import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { captureSnapshot } from '../../src/core/a11y/capture.js';

// Тесты в test/live/** самоскипаются без WEBHARVEST_LIVE=1 — здесь это нужно
// не ради сети, а ради настоящего Chromium.
const live = process.env.WEBHARVEST_LIVE === '1' ? describe : describe.skip;

// `;charset=utf-8` обязателен: без него Chromium трактует data:-URL как
// us-ascii/windows-1252 и кириллица приходит битой уже на уровне DOM,
// до всякого захвата.
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html><body>
    <form>
      <label>Email <input type="email"></label>
      <label>Пароль <input type="password"></label>
      <label><input type="checkbox" checked> Запомнить меня</label>
      <select><option>Кипр</option><option>Грузия</option></select>
      <button>Войти</button>
    </form>
    <div><div><div><a href="https://example.com/help">Помощь</a></div></div></div>
  </body></html>
`)}`;

live('a11y/capture: снапшот живой страницы', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(PAGE);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('печатает интерактивные элементы с адресами', async () => {
    const snap = await captureSnapshot(page);
    expect(snap.outline).toMatch(/\[0-\d+\] button: Войти/);
    expect(snap.outline).toMatch(/\[0-\d+\] textbox: Email/);
  });

  it('помечает отмеченный чекбокс флагом', async () => {
    const snap = await captureSnapshot(page);
    expect(snap.outline).toMatch(/checkbox.*\[checked\]/);
  });

  it('называет нативный дропдаун select, а не combobox', async () => {
    const snap = await captureSnapshot(page);
    expect(snap.outline).toContain('] select');
    expect(snap.outline).not.toContain('] combobox');
  });

  it('схлопывает вложенные пустые обёртки', async () => {
    const snap = await captureSnapshot(page);
    // Три вложенных div вокруг ссылки не должны дать трёх строк подряд.
    expect(snap.outline).not.toMatch(/\] div\n\s+\[[\d-]+\] div/);
  });

  it('уносит ссылки в urlMap, а не в текст дерева', async () => {
    const snap = await captureSnapshot(page);
    expect(snap.outline).not.toContain('https://example.com/help');
    expect(Object.values(snap.urlMap)).toContain('https://example.com/help');
  });

  it('заполняет карты тегов и путей для каждого адреса из дерева', async () => {
    const snap = await captureSnapshot(page);
    const ids = [...snap.outline.matchAll(/\[(\d+-\d+)\]/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) {
      expect(snap.tagNameMap[id], `нет тега для ${id}`).toBeDefined();
      expect(snap.xpathMap[id], `нет xpath для ${id}`).toBeDefined();
    }
  });
});
