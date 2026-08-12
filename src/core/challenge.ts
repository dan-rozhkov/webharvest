import type { Page } from 'playwright';

const TURNSTILE_FRAME = 'iframe[src*="challenges.cloudflare.com"][src*="turnstile"]';

/** Быстрые маркеры челленджа в DOM. Работаем с живым DOM, поэтому полный
 *  HTML-анализ (detectChallenge из escalation.ts) здесь не нужен — эти
 *  селекторы и заголовок покрывают и классический CF-интерстишель, и
 *  Turnstile-виджет. */
const QUICK_SELECTORS = [
  TURNSTILE_FRAME,
  '#cf-turnstile',
  '#turnstile-wrapper',
  '#challenge-running',
  '#challenge-form',
  '#challenge-stage',
  '.cf-browser-verification',
];

/** Недорогая проверка: страница сейчас показывает челлендж? */
export async function isChallengeActive(page: Page): Promise<boolean> {
  for (const sel of QUICK_SELECTORS) {
    try {
      if ((await page.locator(sel).count()) > 0) return true;
    } catch {
      // страница может навигироваться прямо сейчас — считаем не-челленджем
    }
  }
  const title = await page.title().catch(() => '');
  if (/just a moment|attention required|checking your browser/i.test(title)) {
    return true;
  }
  return false;
}

/** Клик по чекбоксу Turnstile. Сначала — по элементу внутри фрейма
 *  (cross-origin frameLocator поддерживается), затем fallback — мышью по
 *  левой части виджета. Ошибки глотаем: клик — best-effort. */
export async function clickTurnstileCheckbox(page: Page): Promise<void> {
  const widget = page.locator(TURNSTILE_FRAME).first();
  if ((await widget.count()) === 0) return;
  try {
    const checkbox = page
      .frameLocator(TURNSTILE_FRAME)
      .locator('input[type="checkbox"], [role="checkbox"]')
      .first();
    await checkbox.click({ timeout: 1500 });
    return;
  } catch {
    // fallthrough к клику мышью
  }
  try {
    const box = await widget.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
    }
  } catch {
    // ничего не вышло — пусть ждём по таймауту
  }
}

/**
 * Ждёт, пока активный челлендж исчезнет (или вернёт false по таймауту).
 * Не делает ничего на обычных страницах — isChallengeActive() дешёвый.
 * Через ~4с, если Turnstile-виджет всё ещё на странице, один раз кликает
 * чекбокс (interactive-режим).
 */
export async function waitForChallengeResolution(page: Page, opts: { timeoutMs: number }): Promise<boolean> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  let clicked = false;

  while (Date.now() < deadline) {
    const active = await isChallengeActive(page);
    if (!active) return true;
    if (!clicked && Date.now() - started > 4000 && (await page.locator(TURNSTILE_FRAME).count()) > 0) {
      await clickTurnstileCheckbox(page).catch(() => {});
      clicked = true;
    }
    await page.waitForTimeout(500);
  }
  return !(await isChallengeActive(page));
}
