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

/** Имя переменной → значение. Не путать с содержимым инструкции агента —
 *  значения сюда попадают только через параметр `variables` HTTP/MCP-вызова. */
export type Variables = Record<string, string>;

const PLACEHOLDER = /%([A-Za-z0-9_]+)%/g;

/**
 * Подстановка плейсхолдеров `%имя%` реальными значениями из `variables`.
 * Раньше это прятало секрет от модели, планирующей действие внутри демона;
 * этой модели больше нет — теперь вызывающий агент (Claude Code) сам решает,
 * какой elementId и какой текст передать, и он же видит собственную
 * инструкцию целиком. Смысл механизма не в этом: агент пишет плейсхолдер
 * `%password%` в аргументе `text`, а не настоящий пароль, — так секрет не
 * попадает в контекст вызывающего агента (историю диалога, логи, любой текст,
 * который он потом может процитировать или отправить куда-то ещё), а
 * подставляется демоном непосредственно перед исполнением действия в
 * браузере. Неизвестный плейсхолдер оставляем как есть: молча подставить
 * пустую строку значит тихо ввести не то, что просили.
 */
export function substituteVariables(args: string[], variables?: Variables): string[] {
  if (!variables) return args;
  return args.map((arg) =>
    arg.replace(PLACEHOLDER, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name) ? variables[name]! : whole,
    ),
  );
}

/**
 * Действие без аргумента там, где он обязателен, — почти всегда галлюцинация
 * модели. Пустая строка, в отличие от отсутствующего аргумента, — законное
 * значение (`fill('')` — обычный способ очистить поле), поэтому здесь она
 * не отвергается: методы, для которых пустая строка бессмысленна, проверяют
 * это сами через `requireNonEmptyArg`.
 */
function requireArg(req: ActionRequest): string {
  const arg = req.arguments[0];
  if (arg === undefined) {
    throw new HarvestError(
      'invalid_request',
      `Метод ${req.method} требует аргумент, но он не передан для элемента ${req.elementId}`,
    );
  }
  return arg;
}

/**
 * Как `requireArg`, но для методов, где пустая строка ничего не значит:
 * `press('')` — нет такой клавиши, `selectOptionFromDropdown('')` — нет
 * опции с пустой подписью. Модель, приславшая пустой аргумент сюда, ошиблась
 * так же, как если бы не прислала его вовсе.
 */
function requireNonEmptyArg(req: ActionRequest): string {
  const arg = requireArg(req);
  if (arg === '') {
    throw new HarvestError(
      'invalid_request',
      `Метод ${req.method} требует непустой аргумент для элемента ${req.elementId}`,
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
        await el.press(requireNonEmptyArg(req));
        return;

      case 'selectOptionFromDropdown':
        // Работает только с нативным <select>. Кастомные дропдауны модель
        // обязана раскрывать кликом (двухшаговый сценарий) — см. промпт act.
        await el.selectOption({ label: requireNonEmptyArg(req) });
        return;

      case 'scrollTo': {
        // Модель отдаёт долю страницы в процентах: «пролистай до половины».
        // Здесь нужен именно requireNonEmptyArg, а не requireArg: `Number('')`
        // равен 0, а не NaN, так что пустой аргумент, пропущенный дальше,
        // незаметно проскочил бы как «0%» вместо явной ошибки.
        const raw = requireNonEmptyArg(req).replace('%', '').trim();
        const percent = Number(raw);
        if (!Number.isFinite(percent)) {
          throw new HarvestError('invalid_request', `scrollTo ожидает проценты, получено «${raw}»`);
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
    // Всё остальное — не проблема сети: перехваченный клик, отвалившийся от
    // документа узел, несуществующая опция дропдауна и т. п. — это модель
    // попросила страницу о том, чего та сделать не может. `network` здесь
    // сбивал бы с толку: агент решил бы, что дело в соединении, и повторил
    // тот же вызов вместо того, чтобы перечитать снапшот или поправить
    // аргумент.
    throw new HarvestError(
      'invalid_request',
      `Действие ${req.method} над ${req.elementId} не удалось: ${msg}`,
    );
  } finally {
    await el.dispose().catch(() => {});
  }
}
