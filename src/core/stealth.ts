import type { BrowserContext } from 'playwright';

/**
 * Общий stealth-модуль для обоих пулов браузеров.
 *
 * Раньше усиленный init-скрипт и UA жили только в browser.ts (пул рендера), а
 * session-pool.ts (пул живых страниц для browser use) вообще не применял stealth —
 * сессии browser use были открытой дырой для Turnstile и прочих антиботов.
 * Теперь всё общее вынесено сюда, и оба пула применяют его единообразно через
 * applyStealth().
 */

/** Chrome UA без следов HeadlessChrome — тот же, что был в browser.ts/session-pool.ts. */
export const STEALTH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

/** Аргументы запуска Chromium, снижающие детектируемость автоматизации. */
export const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
];

/**
 * Скрывает типичные следы Playwright/headless от навигатора.
 * Выполняется в контексте страницы до любого скрипта сайта.
 */
export const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ru'] });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3].map((i) => ({ name: 'Chrome PDF Plugin ' + i })),
  });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
  window.chrome = window.chrome || { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {}, webstore: {} };
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(p);
`;

/** Единая точка применения stealth к контексту. Асинхронная намеренно:
 *  addInitScript может упасть (браузер умер в узком окне после newContext) —
 *  await на месте вызова превращает это в нормальную ошибку пула, а не в
 *  unhandled rejection, роняющий процесс демона. */
export async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(STEALTH_INIT);
}
