/**
 * Исполнение одного действия над элементом, найденным по адресу из снапшота.
 *
 * Набор методов сознательно узкий и совпадает с тем, что перечислено модели в
 * промпте: всё, что модель может назвать, должно быть исполнимо, и наоборот.
 * Расширять набор — значит менять обе стороны одновременно.
 */
import type { Page } from 'playwright';
import type { A11ySnapshot } from './a11y/types.js';
import { resolveElement } from './a11y/resolve.js';
import { HarvestError } from './errors.js';

export const SUPPORTED_ACTIONS = [
  'click',
  'fill',
  'type',
  'press',
  'hover',
  'selectOptionFromDropdown',
  'scrollTo',
] as const;

export type SupportedAction = (typeof SUPPORTED_ACTIONS)[number];

export function isSupportedAction(value: string): value is SupportedAction {
  return (SUPPORTED_ACTIONS as readonly string[]).includes(value);
}

export interface ActionRequest {
  elementId: string;
  method: SupportedAction;
  arguments: string[];
}

/** Действие без аргумента там, где он обязателен, — почти всегда галлюцинация модели. */
function requireArg(req: ActionRequest): string {
  const arg = req.arguments[0];
  if (arg === undefined || arg === '') {
    throw new HarvestError(
      'not_found',
      `Метод ${req.method} требует аргумент, но он не передан для элемента ${req.elementId}`,
    );
  }
  return arg;
}

export async function executeAction(
  page: Page,
  req: ActionRequest,
  snapshot: A11ySnapshot,
): Promise<void> {
  if (!isSupportedAction(req.method)) {
    throw new HarvestError('not_found', `Неизвестное действие: ${req.method}`);
  }

  const el = await resolveElement(page, req.elementId, snapshot);
  try {
    switch (req.method) {
      case 'click':
        await el.click();
        return;

      case 'hover':
        await el.hover();
        return;

      case 'fill':
        // fill очищает поле перед вводом — это то, что нужно почти всегда.
        await el.fill(requireArg(req));
        return;

      case 'type':
        // Печатает посимвольно поверх текущего значения, генерируя события
        // клавиатуры: нужен там, где поле слушает keydown (автокомплиты,
        // маски ввода). `elementHandle.type()` помечен @deprecated в пользу
        // `locator.pressSequentially()` — но эта замена существует только на
        // `Locator`, а не на `ElementHandle`, который здесь и резолвится
        // (`pressSequentially` там просто отсутствует в типах). Раз замены
        // с той же сигнатурой нет, а `type()` не печатает предупреждение в
        // рантайме (проверено вручную), оставляем `type()`.
        await el.type(requireArg(req));
        return;

      case 'press':
        await el.press(requireArg(req));
        return;

      case 'selectOptionFromDropdown':
        // Работает только с нативным <select>. Кастомные дропдауны модель
        // обязана раскрывать кликом (двухшаговый сценарий) — см. промпт act.
        await el.selectOption({ label: requireArg(req) });
        return;

      case 'scrollTo': {
        // Модель отдаёт долю страницы в процентах: «пролистай до половины».
        const raw = requireArg(req).replace('%', '').trim();
        const percent = Number(raw);
        if (!Number.isFinite(percent)) {
          throw new HarvestError('not_found', `scrollTo ожидает проценты, получено «${raw}»`);
        }
        const ratio = Math.min(100, Math.max(0, percent)) / 100;
        await el.evaluate((node, r) => {
          const target = node as HTMLElement;
          // Скроллим сам элемент, если он прокручиваемый, иначе всю страницу.
          const scroller =
            target.scrollHeight > target.clientHeight ? target : document.scrollingElement;
          if (!scroller) return;
          scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * r;
        }, ratio);
        return;
      }
    }
  } catch (e) {
    if (HarvestError.is(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout/i.test(msg)) {
      throw new HarvestError(
        'timeout',
        `Действие ${req.method} над ${req.elementId} не завершилось: ${msg}`,
      );
    }
    throw new HarvestError(
      'network',
      `Действие ${req.method} над ${req.elementId} не удалось: ${msg}`,
    );
  } finally {
    await el.dispose().catch(() => {});
  }
}
