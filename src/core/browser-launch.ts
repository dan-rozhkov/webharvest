import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { applyStealth, STEALTH_ARGS, STEALTH_UA } from './stealth.js';

export type BrowserChannel = 'chromium' | 'chrome';

export interface LaunchOptions {
  headless: boolean;
  channel?: BrowserChannel;
  /** Если задан — persistent context (cookies переживают рестарты). */
  profileDir?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  deviceScaleFactor?: number;
  extraHTTPHeaders?: Record<string, string>;
}

export interface LaunchedBrowser {
  browser: Browser;
  context: BrowserContext;
  usedChannel: BrowserChannel;
  persistent: boolean;
}

const CONTEXT_OPTS = (opts: LaunchOptions) => ({
  userAgent: STEALTH_UA,
  viewport: opts.viewport ?? { width: 1440, height: 900 },
  locale: opts.locale ?? 'en-US',
  ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}),
  ...(opts.deviceScaleFactor ? { deviceScaleFactor: opts.deviceScaleFactor } : {}),
  ...(opts.extraHTTPHeaders ? { extraHTTPHeaders: opts.extraHTTPHeaders } : {}),
});

/**
 * Признак «Chrome не установлен» в ошибке Playwright. Именно на него — и
 * только на него — завязан фолбэк на bundled chromium: остальные причины
 * (упавший процесс, залоченный чужим запуском userDataDir/SingletonLock,
 * сбой applyStealth) фолбэком не лечатся, а молча подменять явно выбранный
 * оператором канал на другой браузер — то самое тихое вырождение, которое
 * проект не допускает (см. комментарий к parsePort в daemon/config.ts).
 */
const CHROME_NOT_INSTALLED = /Executable doesn't exist|is not found at|channel .* is not installed/i;

/**
 * Единая точка запуска браузера для обоих пулов.
 * - channel 'chrome' → системный Google Chrome; если Playwright не находит
 *   Chrome, повторяем запуск с bundled chromium (fallback, чтобы демон
 *   работал на машинах без установленного Chrome) и пишем об этом в лог —
 *   деградация канала не должна быть беззвучной.
 * - profileDir → launchPersistentContext (один userDataDir на процесс!).
 */
export async function launchBrowser(opts: LaunchOptions): Promise<LaunchedBrowser> {
  const channels: (BrowserChannel | undefined)[] =
    opts.channel === 'chrome' ? ['chrome', undefined] : [undefined];
  const profileDir = opts.profileDir;

  let lastError: unknown = null;
  for (const channel of channels) {
    try {
      if (profileDir) {
        mkdirSync(profileDir, { recursive: true });
        const context = await chromium.launchPersistentContext(profileDir, {
          headless: opts.headless,
          ...(channel ? { channel } : {}),
          args: STEALTH_ARGS,
          ...CONTEXT_OPTS(opts),
        });
        try {
          await applyStealth(context);
        } catch (e) {
          // Зеркально неpersistent-ветке ниже: launchPersistentContext уже
          // поднял процесс Chromium, и если addInitScript упал, контекст
          // нельзя оставить без владельца — иначе осиротевший Chromium с
          // заблокированным userDataDir (SingletonLock) живёт до смерти
          // демона, а фолбэк-запуск того же профиля падает на локале и
          // маскирует исходную ошибку. В persistent-режиме владелец
          // процесса — контекст: context.close() закроет и браузер.
          await context.close().catch(() => {});
          throw e;
        }
        // context.browser() типизирован как Browser | null, но для
        // persistent-контекста всегда возвращает браузер (проверено на
        // playwright 1.62): контекст без браузера существовать не может.
        return { browser: context.browser()!, context, usedChannel: channel ?? 'chromium', persistent: true };
      }
      const browser = await chromium.launch({
        headless: opts.headless,
        ...(channel ? { channel } : {}),
        args: STEALTH_ARGS,
      });
      try {
        const context = await browser.newContext(CONTEXT_OPTS(opts));
        await applyStealth(context);
        return { browser, context, usedChannel: channel ?? 'chromium', persistent: false };
      } catch (e) {
        // newContext/applyStealth упали — уже запущенный процесс Chromium
        // нельзя оставить без владельца: закрываем и пробуем следующий канал.
        await browser.close().catch(() => {});
        throw e;
      }
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Фолбэк — только на «Chrome не установлен». Любую другую ошибку
      // отдаём вызывающему как есть: повторный запуск того же профиля в
      // chromium её не починит, зато скроет настоящую причину.
      if (channel !== 'chrome' || !CHROME_NOT_INSTALLED.test(msg)) break;
      console.warn(
        `[webharvest] системный Chrome не найден, откатываюсь на bundled chromium: ${msg}`,
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
