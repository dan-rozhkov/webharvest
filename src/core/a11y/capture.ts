/**
 * Захват гибридного снапшота: accessibility-дерево из CDP, сшитое с картами
 * тегов и путей из DOM.
 *
 * v1 работает одной CDP-сессией на страницу. `Accessibility.getFullAXTree` и
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

export async function captureSnapshot(page: Page): Promise<A11ySnapshot> {
  const cdp = await page.context().newCDPSession(page);
  const session: CdpSender = {
    send: <T>(method: string, params?: Record<string, unknown>) =>
      cdp.send(method as Parameters<typeof cdp.send>[0], params as never) as Promise<T>,
  };

  try {
    // Домены включаем до любых запросов: getFullAXTree на выключенном домене
    // отдаёт пустое дерево, а не ошибку, и это молча ломает весь снапшот. Ошибку
    // самого enable не глушим — запоминаем и, если следом дерево окажется
    // пустым, называем её как вероятную причину.
    let accessibilityEnableError: unknown;
    await session.send('DOM.enable').catch(() => {});
    await session.send('Accessibility.enable').catch((e) => {
      accessibilityEnableError = e;
    });

    const { tagNameMap, xpathMap, scrollableMap } = await buildDomMaps(session, MAIN_FRAME_ORDINAL);
    const { nodes } = await session.send<{ nodes: RawAxNode[] }>('Accessibility.getFullAXTree');

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
  } finally {
    // Сессию закрываем всегда: она держит ссылку на страницу и не даёт
    // Playwright освободить таргет.
    await cdp.detach().catch(() => {});
  }
}
