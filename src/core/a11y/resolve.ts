/**
 * Превращение адреса из снапшота в живой элемент.
 *
 * Сначала — точно по `backendNodeId` через CDP (`resolveByBackendId`): адрес
 * указывает ровно на тот узел, который агент видел, даже если соседи с тех
 * пор сдвинулись. Это и позволяет не снимать перед каждым действием свежий
 * снапшот «до» — берётся последний отданный агенту (см. service.ts).
 *
 * Запасной путь — позиционный XPath из снапшота (наш диалект, см.
 * `resolveByXPath` ниже): он переживает пересоздание узла фреймворком —
 * `/html[1]/body[1]/button[1]` остаётся верным адресом, даже когда сам
 * `<button>` уже другой DOM-объект, — и нужен для same-process iframe, куда
 * `page.$` не заглядывает.
 */
import type { ElementHandle, Page } from 'playwright';
import type { A11ySnapshot } from './types.js';
import { HarvestError } from '../errors.js';
import { withPageCdp } from './capture.js';

const REF_ATTR = 'data-wh-ref';
let refCounter = 0;

/**
 * Помечает узел по backendNodeId временным атрибутом и поднимает его через
 * `page.$` (CSS-движок Playwright проходит открытые shadow root). Текстовый
 * узел (StaticText в дереве) заменяется своим родителем — кликают по нему.
 * `null` — узла больше нет или он во фрейме, недоступном из главного
 * документа: тогда решает XPath.
 */
async function resolveByBackendId(page: Page, backendNodeId: number): Promise<ResolvedElement | null> {
  return withPageCdp(page, async ({ sender }) => {
    let objectId: string | undefined;
    try {
      ({ object: { objectId } } = await sender.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }));
    } catch {
      return null;
    }
    if (!objectId) return null;
    const token = `${process.pid}-${++refCounter}`;
    const mark = (fn: string, args: unknown[]) =>
      sender.send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })) });
    try {
      await mark(
        `function (a, t) { const el = this.nodeType === 1 ? this : this.parentElement; if (el) el.setAttribute(a, t); }`,
        [REF_ATTR, token],
      );
      const handle = await page.$(`[${REF_ATTR}="${token}"]`);
      return handle as ResolvedElement | null;
    } finally {
      await mark(
        `function (a) { const el = this.nodeType === 1 ? this : this.parentElement; if (el) el.removeAttribute(a); }`,
        [REF_ATTR],
      ).catch(() => {});
      await sender.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }).catch(() => null);
}

export type ResolvedElement = ElementHandle<HTMLElement | SVGElement>;

const ENCODED_ID = /^(\d+)-(\d+)$/;

export function parseEncodedId(encodedId: string): { frameOrdinal: number; backendNodeId: number } {
  const m = ENCODED_ID.exec(encodedId.trim());
  if (!m) {
    throw new HarvestError(
      'not_found',
      `Некорректный адрес элемента «${encodedId}» — ожидается вид 0-18372, ` +
        'с ординалом фрейма и дефисом',
    );
  }
  return { frameOrdinal: Number(m[1]), backendNodeId: Number(m[2]) };
}

/**
 * XPath из снапшота — наш диалект, а не стандартный: сегмент `//` означает
 * переход через границу shadow root, а same-process iframe вообще не оставляет
 * следа в пути — `buildDomMaps` в dom-index.ts продолжает один и тот же путь
 * через `contentDocument`, не добавляя шага на самом `<iframe>`.
 *
 * `document.evaluate` этого диалекта не понимает — и, что важнее, в Chromium
 * контекстным узлом для него в принципе не может быть ShadowRoot
 * (`NotSupportedError: ... is not a valid context node type`), так что путь
 * даже без диалекта не резолвится этим API через границу тени. Поэтому шаги
 * `tag[N]` проходим сами: считаем одноимённых соседей среди `childNodes` —
 * это ровно то, что делает `childSteps` в dom-index.ts при построении путей,
 * так что счёт совпадает по построению.
 *
 * Путь `/` (без единого шага) — сам корневой документ: `buildDomMaps` отдаёт
 * его именно так для узла, с которого начинается обход. Стартовый `node`
 * поэтому — не `null`, а `document.documentElement`: если шагов, требующих
 * спуска по `childNodes`, не находится вовсе (ровно случай `/`), он так и
 * останется результатом, а не пропадёт в `null`.
 *
 * Передаётся в `page.evaluateHandle` как настоящая функция, а не строка:
 * Playwright решает, вызывать ли переданное выражение с аргументом, по
 * `typeof pageFunction === 'function'` — со строкой это условие ложно,
 * `xpath` внутрь так и не попадает, и выражение вместо резолва узла отдаёт
 * исходный текст функции.
 */
function resolveByXPath(xpath: string): Element | null {
  const STEP = /^(.+)\[(\d+)]$/;

  function stepDown(root: Node, step: string): Node | null {
    const m = STEP.exec(step);
    if (!m) return null;
    const [, tagName, indexStr] = m;
    const index = Number(indexStr);
    let count = 0;
    for (const child of root.childNodes) {
      if (child.nodeName.toLowerCase() === tagName) {
        count += 1;
        if (count === index) return child;
      }
    }
    return null;
  }

  const segments = xpath.split('//');
  let root: Node = document;
  let node: Node | null = document.documentElement;
  for (let i = 0; i < segments.length; i++) {
    const part = segments[i]!;
    if (i > 0) {
      if (!node || !(node as Element).shadowRoot) return null;
      root = (node as Element).shadowRoot!;
    }
    if (part === '' || part === '/') continue;

    const steps = part.split('/').filter((s) => s !== '');
    let current: Node = root;
    for (let j = 0; j < steps.length; j++) {
      const found = stepDown(current, steps[j]!);
      if (!found) return null;
      current = found;
      // Same-process iframe: dom-index.ts продолжает путь через
      // `contentDocument`, не тратя на переход отдельный сегмент, — значит и
      // здесь следующий шаг ищем среди детей документа фрейма, а не самого
      // `<iframe>`. Но только если шаг не последний: если адрес указывает на
      // сам `<iframe>` (его backendNodeId и backendNodeId его contentDocument
      // делят один и тот же путь), нырять здесь нельзя — иначе вместо
      // элемента-хендла на iframe мы бы всегда возвращали его Document, а
      // `asElement()` на Document даёт `null`.
      const isTerminalStep = i === segments.length - 1 && j === steps.length - 1;
      if (!isTerminalStep) {
        const contentDocument = (current as HTMLIFrameElement).contentDocument;
        if (contentDocument) current = contentDocument;
      }
    }
    node = current;
  }
  return node as Element | null;
}

export async function resolveElement(
  page: Page,
  encodedId: string,
  snapshot: A11ySnapshot,
): Promise<ResolvedElement> {
  const { frameOrdinal, backendNodeId } = parseEncodedId(encodedId);
  if (frameOrdinal !== 0) {
    throw new HarvestError(
      'not_found',
      `Адрес ${encodedId} указывает на кросс-доменный фрейм — в этой версии они не поддержаны`,
    );
  }

  const exact = await resolveByBackendId(page, backendNodeId);
  if (exact) return exact;

  const xpath = snapshot.xpathMap[encodedId];
  if (!xpath) {
    throw new HarvestError(
      'not_found',
      `Элемент ${encodedId} не найден на странице и отсутствует в карте путей — ` +
        'снимите снапшот заново',
    );
  }

  const handle = await page.evaluateHandle(resolveByXPath, xpath);
  const element = handle.asElement() as ResolvedElement | null;
  if (!element) {
    await handle.dispose();
    throw new HarvestError(
      'not_found',
      `Элемент ${encodedId} исчез со страницы — снимите снапшот заново`,
    );
  }
  return element;
}
