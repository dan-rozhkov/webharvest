import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { captureSnapshot } from '../../src/core/a11y/capture.js';
import { resolveElement } from '../../src/core/a11y/resolve.js';
import { HarvestError } from '../../src/core/errors.js';
import type { A11ySnapshot } from '../../src/core/a11y/types.js';

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

// Same-process iframe (srcdoc — тот же процесс, никакого OOPIF): проверяем
// и адрес самого <iframe>, и адрес элемента внутри его contentDocument.
const IFRAME_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html><body>
    <!-- Кадр на том же процессе: свой адрес у iframe, свой — у кнопки внутри -->
    <iframe id="frame" srcdoc="<button id=inner>Внутри кадра</button>"></iframe>
  </body></html>
`)}`;

/** Находит адрес строки outline по подстроке имени или роли. */
function idOf(outline: string, name: string): string {
  const line = outline.split('\n').find((l) => l.includes(name));
  if (!line) throw new Error(`в дереве нет строки с «${name}»:\n${outline}`);
  return /\[([\d-]+)\]/.exec(line)![1]!;
}

/** Находит адрес узла, чей путь в снапшоте — сам корень документа («/»). */
function rootIdOf(snapshot: A11ySnapshot): string {
  return idByXPath(snapshot, (xpath) => xpath === '/');
}

/**
 * Находит адрес по условию на сам XPath, а не по outline. Нужна для
 * содержимого same-process iframe: `Accessibility.getFullAXTree` не спускается
 * в дочерний фрейм автоматически, поэтому в outline кадр остаётся без детей —
 * это ограничение сборки снапшота (`capture.ts`), не резолва. `xpathMap` при
 * этом путь до кнопки внутри кадра строит верно (см. `dom-index.ts`), и именно
 * с ним работает `resolveElement`, так что тест бьёт по адресу напрямую.
 */
function idByXPath(snapshot: A11ySnapshot, predicate: (xpath: string) => boolean): string {
  const entry = Object.entries(snapshot.xpathMap).find(([, xpath]) => predicate(xpath));
  if (!entry) {
    throw new Error(`не нашли адрес по условию в xpathMap: ${JSON.stringify(snapshot.xpathMap)}`);
  }
  return entry[0];
}

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

  it('резолвит по адресу даже после пересоздания узла — тот же путь, другой DOM-объект', async () => {
    const snap = await captureSnapshot(page);
    const id = idOf(snap.outline, 'Войти');
    // Помечаем оригинальный узел и заменяем его на новый: адрес — это путь в
    // дереве, а не ссылка на конкретный объект, поэтому он остаётся валиден,
    // хотя элемент, на который он теперь указывает, — заведомо другой объект.
    await page.evaluate(() => {
      const old = document.querySelector<HTMLElement>('#login')!;
      old.dataset.original = 'true';
      const fresh = document.createElement('button');
      fresh.id = 'login';
      fresh.textContent = 'Войти';
      old.replaceWith(fresh);
    });
    const el = await resolveElement(page, id, snap);
    expect(await el.textContent()).toBe('Войти');
    // Если бы резолв каким-то образом вернул старый узел (например, из
    // закэшированного CDP-объекта), метка была бы на месте — а её нет.
    expect(await el.getAttribute('data-original')).toBeNull();
  });

  it('внятно жалуется на исчезнувший элемент', async () => {
    const snap = await captureSnapshot(page);
    const id = idOf(snap.outline, 'Войти');
    await page.evaluate(() => document.querySelector('#login')!.remove());
    await expect(resolveElement(page, id, snap)).rejects.toThrow(HarvestError);
  });

  it('резолвит адрес корня документа в <html>', async () => {
    const snap = await captureSnapshot(page);
    const el = await resolveElement(page, rootIdOf(snap), snap);
    expect(await el.evaluate((n) => n.tagName)).toBe('HTML');
  });
});

live('a11y/resolve: same-process iframe', () => {
  let browser: Browser;
  let page: Page;

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(IFRAME_PAGE);
    await page.waitForFunction(() => {
      const frame = document.querySelector('iframe');
      return !!frame?.contentDocument && frame.contentDocument.readyState === 'complete';
    });
  });

  afterEach(async () => {
    await browser?.close();
  });

  it('резолвит адрес самого <iframe>, а не его contentDocument', async () => {
    const snap = await captureSnapshot(page);
    const el = await resolveElement(page, idOf(snap.outline, 'Iframe'), snap);
    expect(await el.evaluate((n) => n.tagName)).toBe('IFRAME');
  });

  it('резолвит элемент внутри кадра', async () => {
    const snap = await captureSnapshot(page);
    const id = idByXPath(snap, (xpath) => xpath.endsWith('/iframe[1]/html[1]/body[1]/button[1]'));
    const el = await resolveElement(page, id, snap);
    expect(await el.textContent()).toBe('Внутри кадра');
  });
});
