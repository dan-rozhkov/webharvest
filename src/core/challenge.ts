import type { Page } from 'playwright';

const TURNSTILE_FRAME = 'iframe[src*="challenges.cloudflare.com"][src*="turnstile"]';

/**
 * Маркеры БЛОКИРУЮЩЕГО челленджа в DOM — структурные id/class самой
 * challenge-страницы Cloudflare. Их нет на обычных страницах, которые лишь
 * встраивают Turnstile-виджет для формы (логин/контакт): у тех есть iframe
 * turnstile и div.cf-turnstile, но нет challenge-stage/form.
 *
 * Намеренно НЕ включаем сюда сам iframe / `#cf-turnstile` / `#turnstile-wrapper`:
 * они есть и у безобидного встроенного виджета, который никуда не исчезает, —
 * тогда isChallengeActive вечно возвращал бы true, и ожидание сжигало бы весь
 * бюджет (до 20с) на каждой легитимной странице с формой, ещё и кликая по
 * чекбоксу. Полный HTML-анализ (detectChallenge из escalation.ts) здесь не
 * нужен — работаем с живым DOM, этих селекторов и заголовка достаточно,
 * чтобы отличить блокирующий челлендж от безобидного виджета.
 */
const CHALLENGE_SELECTORS = [
  '#challenge-running',
  '#challenge-form',
  '#challenge-stage',
  '.cf-browser-verification',
];

/** Заголовок классического CF-интерстишеля («Just a moment…»). Только
 *  запасной путь к селекторам выше: Cloudflare локализует эту страницу по
 *  Accept-Language, а регексп англоязычный. Штатно этого достаточно —
 *  browser-launch поднимает контекст с locale 'en-US' (см. CONTEXT_OPTS), и
 *  современный managed challenge всё равно ловится по `#challenge-*`
 *  независимо от языка. */
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser/i;

/** Есть ли на странице iframe Turnstile (нужен только для клика: сам по себе
 *  он челленджа не означает — см. комментарий к CHALLENGE_SELECTORS). */
async function hasTurnstileFrame(page: Page): Promise<boolean> {
  try {
    return (await page.locator(TURNSTILE_FRAME).count()) > 0;
  } catch (e) {
    // Та же развилка, что в isChallengeActive: закрытая страница — реальная
    // ошибка, transient-навигация — просто «сейчас не видно».
    if (page.isClosed()) throw e;
    return false;
  }
}

/** Недорогая проверка: страница сейчас показывает БЛОКИРУЮЩИЙ челлендж? */
export async function isChallengeActive(page: Page): Promise<boolean> {
  for (const sel of CHALLENGE_SELECTORS) {
    try {
      if ((await page.locator(sel).count()) > 0) return true;
    } catch (e) {
      // Закрытая/уничтоженная страница (shutdown/eviction в гонке) — это не
      // «челленджа нет», а реальная ошибка: пробрасываем, иначе caller
      // отдаст агенту мёртвую сессию (или проглотит поломку в рендере).
      if (page.isClosed()) throw e;
      // Иначе — transient-навигация (контекст исполнения пересоздаётся
      // прямо сейчас): считаем не-челленджем и идём дальше.
    }
  }
  let title = '';
  try {
    title = await page.title();
  } catch (e) {
    if (page.isClosed()) throw e;
  }
  return CHALLENGE_TITLE.test(title);
}

/** Клик по чекбоксу Turnstile. Сначала — по элементу внутри фрейма
 *  (cross-origin frameLocator поддерживается), затем fallback — мышью по
 *  левой части виджета. Ошибки глотаем: клик — best-effort. */
export async function clickTurnstileCheckbox(page: Page): Promise<void> {
  if (!(await hasTurnstileFrame(page))) return;
  const widget = page.locator(TURNSTILE_FRAME).first();
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
    if (!clicked && Date.now() - started > 4000 && (await hasTurnstileFrame(page))) {
      await clickTurnstileCheckbox(page).catch(() => {});
      clicked = true;
    }
    // Не оборачиваем: waitForTimeout падает только на закрытой странице, а
    // это ровно тот случай, который мы и хотим пробросить наверх.
    await page.waitForTimeout(500);
  }
  return !(await isChallengeActive(page));
}
