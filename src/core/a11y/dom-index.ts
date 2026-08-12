/**
 * Сбор из DOM того, чего нет в accessibility-дереве: имя тега, XPath и наличие
 * собственной прокрутки. Отдельный проход нужен потому, что AX-дерево не знает
 * ни про теги, ни про геометрию.
 *
 * Портировано из browserbase/stagehand (MIT),
 * packages/extension/understudy/a11y/snapshot/domTree.ts
 * Copyright (c) Browserbase, Inc. См. NOTICE в корне репозитория.
 */
import { encodeNodeId } from './format.js';

/** Всё, что нам нужно от CDP-сессии. Позволяет тестировать без браузера. */
export interface CdpSender {
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** Узел из `DOM.getDocument` / `DOM.describeNode`. */
export interface DomNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeName: string;
  /** Плоский массив [имя1, значение1, имя2, значение2, ...]. */
  attributes?: string[];
  childNodeCount?: number;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  isScrollable?: boolean;
}

// От бесконечной глубины вниз по степеням двойки. CDP сериализует ответ в CBOR
// и на глубоких деревьях выносит стек энкодера; единственное лекарство —
// попросить мельче и потом дособрать недостающее.
const DOM_DEPTH_ATTEMPTS = [-1, 256, 128, 64, 32, 16, 8, 4, 2, 1];
const DESCRIBE_DEPTH_ATTEMPTS = [-1, 64, 32, 16, 8, 4, 2, 1];

function isCborStackError(message: string): boolean {
  return message.includes('CBOR: stack limit exceeded');
}

/**
 * `childNodeCount` остаётся правдивым, даже когда сам массив `children` обрезан
 * — по расхождению и определяется, что ветку надо дособрать.
 */
export function shouldExpandNode(node: DomNode): boolean {
  return (node.childNodeCount ?? 0) > (node.children?.length ?? 0);
}

function attr(attributes: string[] | undefined, name: string): string | undefined {
  if (!attributes) return undefined;
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === name) return attributes[i + 1];
  }
  return undefined;
}

/** У инпутов тип — часть смысла: `input, password` и `input, file` ведут себя по-разному. */
export function enrichedTagName(node: DomNode): string {
  const tag = String(node.nodeName).toLowerCase();
  if (tag === 'input') {
    const type = attr(node.attributes, 'type');
    if (type) return `input, ${type}`;
  }
  return tag;
}

function mergeDomNodes(target: DomNode, source: DomNode): void {
  target.childNodeCount = source.childNodeCount ?? target.childNodeCount;
  target.children = source.children ?? target.children;
  target.shadowRoots = source.shadowRoots ?? target.shadowRoots;
  target.contentDocument = source.contentDocument ?? target.contentDocument;
}

function traversalTargets(node: DomNode): DomNode[] {
  const out: DomNode[] = [];
  if (node.children) out.push(...node.children);
  if (node.shadowRoots) out.push(...node.shadowRoots);
  if (node.contentDocument) out.push(node.contentDocument);
  return out;
}

/** Дособирает обрезанные ветки, спускаясь по той же лестнице глубин. */
async function hydrate(session: CdpSender, root: DomNode): Promise<void> {
  const stack: DomNode[] = [root];
  const seen = new Set<number>();

  while (stack.length) {
    const node = stack.pop()!;
    const key = node.nodeId ?? node.backendNodeId;
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }

    if (shouldExpandNode(node) && key !== undefined) {
      const base = node.nodeId ? { nodeId: node.nodeId } : { backendNodeId: node.backendNodeId! };
      let expanded = false;
      let lastError: unknown;
      for (const depth of DESCRIBE_DEPTH_ATTEMPTS) {
        try {
          const { node: described } = await session.send<{ node: DomNode }>('DOM.describeNode', {
            ...base,
            depth,
            pierce: true,
          });
          mergeDomNodes(node, described);
          expanded = true;
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!isCborStackError(msg)) throw e;
          lastError = e;
        }
      }
      if (!expanded) throw lastError ?? new Error('Не удалось дособрать ветку DOM');
    }

    for (const child of traversalTargets(node)) stack.push(child);
  }
}

/**
 * `DOM.getDocument` с уменьшающейся глубиной, пока CDP не перестанет падать на
 * CBOR. Любая другая ошибка пробрасывается сразу — ретраить её бессмысленно.
 */
export async function getDomTreeWithFallback(session: CdpSender): Promise<DomNode> {
  let lastError: unknown;
  for (const depth of DOM_DEPTH_ATTEMPTS) {
    try {
      const { root } = await session.send<{ root: DomNode }>('DOM.getDocument', {
        depth,
        pierce: true,
      });
      if (depth !== -1) await hydrate(session, root);
      return root;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!isCborStackError(msg)) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new Error('DOM.getDocument не отдал документ ни на одной глубине');
}

/** Индексы одноимённых соседей: XPath нумерует с единицы и внутри своего типа. */
function childSteps(children: DomNode[]): string[] {
  const counters = new Map<string, number>();
  return children.map((child) => {
    const tag = String(child.nodeName).toLowerCase();
    const index = (counters.get(tag) ?? 0) + 1;
    counters.set(tag, index);
    return `${tag}[${index}]`;
  });
}

function joinXPath(base: string, step: string): string {
  if (step === '//') return base.endsWith('/') ? `${base}/` : `${base}//`;
  return base.endsWith('/') ? `${base}${step}` : `${base}/${step}`;
}

/**
 * Обход дерева в глубину со сбором трёх карт. Граница shadow root обозначается
 * сегментом `//` — это наш диалект XPath, обычный движок такого не резолвит,
 * поэтому резолв shadow-путей делает наш собственный код.
 */
export async function buildDomMaps(
  session: CdpSender,
  frameOrdinal: number,
): Promise<{
  tagNameMap: Record<string, string>;
  xpathMap: Record<string, string>;
  scrollableMap: Record<string, boolean>;
}> {
  const root = await getDomTreeWithFallback(session);

  const tagNameMap: Record<string, string> = {};
  const xpathMap: Record<string, string> = {};
  const scrollableMap: Record<string, boolean> = {};

  const stack: Array<{ node: DomNode; xpath: string }> = [{ node: root, xpath: '' }];
  while (stack.length) {
    const { node, xpath } = stack.pop()!;

    if (typeof node.backendNodeId === 'number') {
      const id = encodeNodeId(frameOrdinal, node.backendNodeId);
      tagNameMap[id] = enrichedTagName(node);
      xpathMap[id] = xpath || '/';
      if (node.isScrollable === true) scrollableMap[id] = true;
    }

    const kids = node.children ?? [];
    const steps = childSteps(kids);
    // Обратный порядок — чтобы из стека дети выходили слева направо.
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ node: kids[i]!, xpath: joinXPath(xpath, steps[i]!) });
    }
    for (const shadow of node.shadowRoots ?? []) {
      stack.push({ node: shadow, xpath: joinXPath(xpath, '//') });
    }
    if (node.contentDocument) {
      // Содержимое same-process iframe продолжает тот же путь: собственного
      // сегмента у документа нет.
      stack.push({ node: node.contentDocument, xpath });
    }
  }

  return { tagNameMap, xpathMap, scrollableMap };
}
