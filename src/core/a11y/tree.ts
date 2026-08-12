/**
 * Сворачивание сырого accessibility-дерева в компактное представление для
 * модели. Пять правил: определить структурные узлы, отбросить пустые, схлопнуть
 * обёртки-одиночки, убрать текст, дублирующий имя родителя, переписать
 * бессмысленные роли в имена тегов.
 *
 * Портировано из browserbase/stagehand (MIT),
 * packages/extension/understudy/a11y/snapshot/a11yTree.ts
 * Copyright (c) Browserbase, Inc. См. NOTICE в корне репозитория.
 */
import type { A11yNode } from './types.js';
import { normaliseSpaces } from './format.js';

/** Сырой узел из `Accessibility.getFullAXTree`. Значения приходят обёрнутыми. */
export interface RawAxNode {
  nodeId: string;
  role?: { value?: unknown };
  name?: { value?: unknown };
  description?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  backendDOMNodeId?: number;
  parentId?: string;
  childIds?: string[];
}

/** Данные из DOM, которых нет в AX-дереве, но которые нужны для переписывания ролей. */
export interface RoleContext {
  /** encodedId → имя тега; у input дополнено типом (`input, password`). */
  tagNameMap: Record<string, string>;
  /** encodedId → у элемента есть собственная прокрутка. */
  scrollableMap: Record<string, boolean>;
}

/**
 * Роли, которые ничего не значат для модели: обёртки вёрстки и внутренние
 * текстовые боксы. Именно они схлопываются.
 */
export function isStructural(role: string): boolean {
  const r = role?.toLowerCase();
  return r === 'generic' || r === 'none' || r === 'inlinetextbox';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** CDP отдаёт булевы свойства то булевым, то числом, то строкой. */
function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return undefined;
}

function booleanProperty(node: RawAxNode, name: string): boolean | undefined {
  return toBoolean(node.properties?.find((p) => p.name === name)?.value?.value);
}

/** Ссылка узла живёт в свойствах, а не в имени. */
export function extractUrlFromAxNode(node: RawAxNode): string | undefined {
  const raw = asString(node.properties?.find((p) => p.name === 'url')?.value?.value);
  return raw && raw.trim() ? raw.trim() : undefined;
}

/**
 * Первый проход: сырой узел → наш `A11yNode`, с проставленным адресом и
 * подмешанной из DOM информацией о прокрутке. Прокрутку модель иначе не видит
 * никак — а без неё она не знает, куда вообще можно скроллить.
 */
export function decorateRoles(
  nodes: RawAxNode[],
  encode: (backendNodeId: number) => string,
  ctx: RoleContext,
): A11yNode[] {
  return nodes.map((raw) => {
    const encodedId =
      typeof raw.backendDOMNodeId === 'number' ? encode(raw.backendDOMNodeId) : undefined;

    let role = asString(raw.role?.value) ?? '';
    const tag = encodedId ? ctx.tagNameMap[encodedId] : undefined;
    const scrollable = encodedId ? ctx.scrollableMap[encodedId] === true : false;

    if (scrollable && tag !== '#document') {
      const label = tag && tag.startsWith('#') ? tag.slice(1) : tag;
      role = label ? `scrollable, ${label}` : `scrollable${role ? `, ${role}` : ''}`;
    }
    // Chrome отдаёт файловому инпуту роль button; без правки модель считает его
    // обычной кнопкой и пытается кликнуть вместо загрузки файла.
    if (tag === 'input, file') role = tag;

    return {
      role,
      name: asString(raw.name?.value),
      description: asString(raw.description?.value),
      value: asString(raw.value?.value),
      selected: booleanProperty(raw, 'selected'),
      checked: booleanProperty(raw, 'checked'),
      nodeId: raw.nodeId,
      backendDOMNodeId: raw.backendDOMNodeId,
      parentId: raw.parentId,
      childIds: raw.childIds,
      encodedId,
    };
  });
}

/**
 * Если конкатенация текстовых детей равна имени родителя — дети избыточны.
 * Без этого правила дерево удваивается: `button "Отправить"` со StaticText
 * «Отправить» внутри встречается практически на каждой кнопке.
 */
export function removeRedundantStaticTextChildren(
  parent: A11yNode,
  children: A11yNode[],
): A11yNode[] {
  if (!parent.name) return children;
  const parentNorm = normaliseSpaces(parent.name).trim();
  let combined = '';
  for (const c of children) {
    if (c.role === 'StaticText' && c.name) combined += normaliseSpaces(c.name);
  }
  return combined.trim() === parentNorm ? children.filter((c) => c.role !== 'StaticText') : children;
}

/**
 * Второй проход: плоский список → дерево, попутно прунинг.
 * Порядок важен — сначала рекурсивно чистим детей, потом решаем судьбу
 * родителя, иначе обёртка, ставшая одиночной после чистки, не схлопнется.
 */
export function buildHierarchicalTree(nodes: A11yNode[], ctx: RoleContext): A11yNode[] {
  const nodeMap = new Map<string, A11yNode>();

  for (const n of nodes) {
    const keep = !!(n.name && n.name.trim()) || !!n.childIds?.length || !isStructural(n.role);
    if (keep) nodeMap.set(n.nodeId, { ...n, children: undefined });
  }

  for (const n of nodes) {
    if (!n.parentId) continue;
    const parent = nodeMap.get(n.parentId);
    const cur = nodeMap.get(n.nodeId);
    if (parent && cur) (parent.children ??= []).push(cur);
  }

  const roots = nodes
    .filter((n) => !n.parentId && nodeMap.has(n.nodeId))
    .map((n) => nodeMap.get(n.nodeId)!);

  return roots.map((r) => prune(r, ctx)).filter((n): n is A11yNode => n !== null);
}

function prune(node: A11yNode, ctx: RoleContext): A11yNode | null {
  // Отрицательный nodeId — служебные узлы CDP, реального элемента за ними нет.
  if (Number(node.nodeId) < 0) return null;

  const children = node.children ?? [];
  if (!children.length) return isStructural(node.role) ? null : node;

  const cleaned = children
    .map((c) => prune(c, ctx))
    .filter((c): c is A11yNode => c !== null);
  const kids = removeRedundantStaticTextChildren(node, cleaned);

  if (isStructural(node.role)) {
    if (kids.length === 1) return kids[0]!;
    if (kids.length === 0) return null;
  }

  let role = node.role;
  if ((role === 'generic' || role === 'none') && node.encodedId) {
    const tag = ctx.tagNameMap[node.encodedId];
    if (tag) role = tag;
  }
  // Нативный дропдаун и кастомный обрабатываются разными действиями, поэтому
  // модель обязана их различать — а AX-дерево обоим даёт роль combobox.
  if (role === 'combobox' && node.encodedId && ctx.tagNameMap[node.encodedId] === 'select') {
    role = 'select';
  }

  return { ...node, role, children: kids };
}
