/**
 * Захват гибридного снапшота: accessibility-дерево из CDP, сшитое с картами
 * тегов и путей из DOM.
 *
 * v1 работает одной CDP-сессией на страницу (живёт вместе со страницей, см. withPageCdp). `Accessibility.getFullAXTree` и
 * `DOM.getDocument({pierce: true})` сами спускаются в same-process iframes,
 * поэтому обычные вложенные фреймы попадают в дерево без дополнительной сшивки.
 * Кросс-доменные (OOPIF) живут в отдельных таргетах и в v1 не поддержаны —
 * ординал фрейма в адресе всегда 0 и зарезервирован под будущую мультисессию.
 */
import type { Page } from 'playwright';
import type { A11ySnapshot } from './types.js';
import { HarvestError } from '../errors.js';
import { encodeNodeId, formatTreeLine } from './format.js';
import { buildHierarchicalTree, decorateRoles, extractUrlFromAxNode, type RawAxNode } from './tree.js';
import { buildDomMaps, type CdpSender } from './dom-index.js';

const MAIN_FRAME_ORDINAL = 0;

interface PageCdp {
  sender: CdpSender;
  /** Ошибка Accessibility.enable, если была: называем её, если дерево пустое. */
  accessibilityEnableError: unknown;
}

/**
 * Одна CDP-сессия на страницу на всё её время жизни: новая сессия плюс
 * DOM.enable/Accessibility.enable на каждый снапшот стоили заметную долю
 * захвата. Сессия умирает вместе со страницей; если она отвалилась раньше
 * (крах таргета), withPageCdp пересоздаёт её один раз.
 */
const pageSessions = new WeakMap<Page, Promise<PageCdp>>();

async function openPageCdp(page: Page): Promise<PageCdp> {
  const cdp = await page.context().newCDPSession(page);
  const sender: CdpSender = {
    send: <T>(method: string, params?: Record<string, unknown>) =>
      cdp.send(method as Parameters<typeof cdp.send>[0], params as never) as Promise<T>,
  };
  // Домены включаем до любых запросов: getFullAXTree на выключенном домене
  // отдаёт пустое дерево, а не ошибку, и это молча ломает весь снапшот. Ошибку
  // самого enable не глушим — запоминаем и, если следом дерево окажется
  // пустым, называем её как вероятную причину.
  const out: PageCdp = { sender, accessibilityEnableError: undefined };
  await sender.send('Accessibility.enable').catch((e) => {
    out.accessibilityEnableError = e;
  });
  return out;
}

const DEAD_SESSION = /detached|closed|No session|Session with given id not found/i;

export async function withPageCdp<T>(page: Page, fn: (cdp: PageCdp) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let pending = pageSessions.get(page);
    if (!pending) {
      pending = openPageCdp(page);
      pageSessions.set(page, pending);
      pending.catch(() => pageSessions.delete(page));
    }
    try {
      return await fn(await pending);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt > 0 || !DEAD_SESSION.test(msg) || page.isClosed()) throw e;
      pageSessions.delete(page);
    }
  }
}

export async function captureSnapshot(page: Page): Promise<A11ySnapshot> {
  return withPageCdp(page, async ({ sender: session, accessibilityEnableError }) => {
    // DOM-домен — только на время захвата: включённый, он после
    // getDocument(depth:-1) шлёт событие на каждую мутацию любого узла, и
    // живая страница заваливала бы сессию трафиком между снапшотами.
    await session.send('DOM.enable').catch(() => {});
    let domMaps: Awaited<ReturnType<typeof buildDomMaps>>;
    let nodes: RawAxNode[];
    try {
      domMaps = await buildDomMaps(session, MAIN_FRAME_ORDINAL);
      ({ nodes } = await session.send<{ nodes: RawAxNode[] }>('Accessibility.getFullAXTree'));
    } finally {
      await session.send('DOM.disable').catch(() => {});
    }
    const { tagNameMap, xpathMap, scrollableMap } = domMaps;

    // Пустое дерево — не валидный снапшот: страница без единого accessibility-узла
    // не бывает (даже пустой <body> отдаёт хотя бы RootWebArea). Молча вернуть
    // пустой outline значит спрятать именно ту silent failure, от которой должен
    // был защищать enable выше.
    if (nodes.length === 0) {
      const reason =
        accessibilityEnableError instanceof Error
          ? accessibilityEnableError.message
          : accessibilityEnableError !== undefined
            ? String(accessibilityEnableError)
            : 'причина неизвестна — Accessibility.enable прошёл успешно';
      throw new HarvestError(
        'internal',
        `Accessibility.getFullAXTree вернул пустое дерево: ${reason}`,
      );
    }

    const encode = (backendNodeId: number) => encodeNodeId(MAIN_FRAME_ORDINAL, backendNodeId);

    const urlMap: Record<string, string> = {};
    for (const raw of nodes) {
      if (typeof raw.backendDOMNodeId !== 'number') continue;
      const url = extractUrlFromAxNode(raw);
      if (url) urlMap[encode(raw.backendDOMNodeId)] = url;
    }

    const ctx = { tagNameMap, scrollableMap };
    const tree = buildHierarchicalTree(decorateRoles(nodes, encode, ctx), ctx);
    const outline = tree.map((n) => formatTreeLine(n, 0, tagNameMap)).join('\n').trimEnd();

    return { outline, urlMap, xpathMap, tagNameMap };
  });
}
