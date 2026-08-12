import { describe, it, expect } from 'vitest';
import {
  isStructural,
  removeRedundantStaticTextChildren,
  decorateRoles,
  buildHierarchicalTree,
  extractUrlFromAxNode,
  type RawAxNode,
  type RoleContext,
} from '../../../src/core/a11y/tree.js';
import { formatTreeLine } from '../../../src/core/a11y/format.js';
import type { A11yNode } from '../../../src/core/a11y/types.js';

const EMPTY_CTX: RoleContext = { tagNameMap: {}, scrollableMap: {} };

/** Сырой узел AX-дерева в том виде, в каком его отдаёт CDP. */
function ax(
  nodeId: string,
  role: string,
  extra: Partial<RawAxNode> & { name?: { value?: unknown } } = {},
): RawAxNode {
  return { nodeId, role: { value: role }, ...extra };
}

function n(partial: Partial<A11yNode> & { role: string; nodeId: string }): A11yNode {
  return partial as A11yNode;
}

describe('a11y/tree: isStructural', () => {
  it('считает структурными generic, none и InlineTextBox', () => {
    expect(isStructural('generic')).toBe(true);
    expect(isStructural('none')).toBe(true);
    expect(isStructural('InlineTextBox')).toBe(true);
  });

  it('не считает структурными осмысленные роли', () => {
    expect(isStructural('button')).toBe(false);
    expect(isStructural('StaticText')).toBe(false);
  });
});

describe('a11y/tree: removeRedundantStaticTextChildren', () => {
  it('выбрасывает текстовых детей, дублирующих имя родителя', () => {
    const parent = n({ nodeId: '1', role: 'button', name: 'Отправить' });
    const kids = [n({ nodeId: '2', role: 'StaticText', name: 'Отправить' })];
    expect(removeRedundantStaticTextChildren(parent, kids)).toEqual([]);
  });

  it('склеивает нескольких текстовых детей перед сравнением', () => {
    const parent = n({ nodeId: '1', role: 'link', name: 'Читать далее' });
    const kids = [
      n({ nodeId: '2', role: 'StaticText', name: 'Читать ' }),
      n({ nodeId: '3', role: 'StaticText', name: 'далее' }),
    ];
    expect(removeRedundantStaticTextChildren(parent, kids)).toEqual([]);
  });

  it('оставляет текст, который не совпал с именем родителя', () => {
    const parent = n({ nodeId: '1', role: 'button', name: 'Отправить' });
    const kids = [n({ nodeId: '2', role: 'StaticText', name: 'Отмена' })];
    expect(removeRedundantStaticTextChildren(parent, kids)).toHaveLength(1);
  });

  it('не трогает нетекстовых детей', () => {
    const parent = n({ nodeId: '1', role: 'button', name: 'Отправить' });
    const kids = [n({ nodeId: '2', role: 'image', name: 'Отправить' })];
    expect(removeRedundantStaticTextChildren(parent, kids)).toHaveLength(1);
  });
});

describe('a11y/tree: decorateRoles', () => {
  const encode = (be: number) => `0-${be}`;

  it('проставляет encodedId по backendDOMNodeId', () => {
    const [node] = decorateRoles([ax('1', 'button', { backendDOMNodeId: 25 })], encode, EMPTY_CTX);
    expect(node!.encodedId).toBe('0-25');
  });

  it('помечает скроллящийся элемент префиксом', () => {
    const ctx: RoleContext = { tagNameMap: { '0-40': 'div' }, scrollableMap: { '0-40': true } };
    const [node] = decorateRoles([ax('1', 'generic', { backendDOMNodeId: 40 })], encode, ctx);
    expect(node!.role).toBe('scrollable, div');
  });

  it('переносит булевы свойства checked и selected', () => {
    const raw = ax('1', 'checkbox', {
      backendDOMNodeId: 31,
      properties: [{ name: 'checked', value: { value: true } }],
    });
    const [node] = decorateRoles([raw], encode, EMPTY_CTX);
    expect(node!.checked).toBe(true);
    expect(node!.selected).toBeUndefined();
  });

  it('понимает строковое "true" в свойствах', () => {
    const raw = ax('1', 'option', {
      backendDOMNodeId: 5,
      properties: [{ name: 'selected', value: { value: 'true' } }],
    });
    expect(decorateRoles([raw], encode, EMPTY_CTX)[0]!.selected).toBe(true);
  });
});

describe('a11y/tree: buildHierarchicalTree', () => {
  const ctx: RoleContext = {
    tagNameMap: { '0-10': 'div', '0-20': 'select' },
    scrollableMap: {},
  };

  it('схлопывает структурную обёртку с единственным ребёнком', () => {
    const nodes = [
      n({ nodeId: '1', role: 'generic', childIds: ['2'], encodedId: '0-1' }),
      n({ nodeId: '2', role: 'button', name: 'Войти', parentId: '1', encodedId: '0-2' }),
    ];
    const tree = buildHierarchicalTree(nodes, ctx);
    expect(tree.map((t) => formatTreeLine(t))).toEqual(['[0-2] button: Войти']);
  });

  it('удаляет структурный узел без детей и без имени', () => {
    const nodes = [
      n({ nodeId: '1', role: 'form', childIds: ['2', '3'], encodedId: '0-1' }),
      n({ nodeId: '2', role: 'generic', parentId: '1', encodedId: '0-2' }),
      n({ nodeId: '3', role: 'button', name: 'Ок', parentId: '1', encodedId: '0-3' }),
    ];
    const tree = buildHierarchicalTree(nodes, ctx);
    expect(formatTreeLine(tree[0]!)).toBe('[0-1] form\n  [0-3] button: Ок');
  });

  it('заменяет роль generic на имя тега, когда детей больше одного', () => {
    const nodes = [
      n({ nodeId: '1', role: 'generic', childIds: ['2', '3'], encodedId: '0-10' }),
      n({ nodeId: '2', role: 'button', name: 'A', parentId: '1', encodedId: '0-11' }),
      n({ nodeId: '3', role: 'button', name: 'B', parentId: '1', encodedId: '0-12' }),
    ];
    expect(buildHierarchicalTree(nodes, ctx)[0]!.role).toBe('div');
  });

  it('превращает combobox в select, если это настоящий тег select', () => {
    const nodes = [
      n({ nodeId: '1', role: 'combobox', name: 'Страна', childIds: ['2'], encodedId: '0-20' }),
      n({ nodeId: '2', role: 'option', name: 'Кипр', parentId: '1', encodedId: '0-21' }),
    ];
    expect(buildHierarchicalTree(nodes, ctx)[0]!.role).toBe('select');
  });

  it('оставляет combobox комбобоксом, если тег не select', () => {
    const nodes = [
      n({ nodeId: '1', role: 'combobox', name: 'Страна', childIds: ['2'], encodedId: '0-10' }),
      n({ nodeId: '2', role: 'option', name: 'Кипр', parentId: '1', encodedId: '0-11' }),
    ];
    expect(buildHierarchicalTree(nodes, ctx)[0]!.role).toBe('combobox');
  });

  it('отбрасывает служебные узлы с отрицательным nodeId', () => {
    const nodes = [n({ nodeId: '-1', role: 'button', name: 'Призрак', encodedId: '0-1' })];
    expect(buildHierarchicalTree(nodes, ctx)).toEqual([]);
  });
});

describe('a11y/tree: extractUrlFromAxNode', () => {
  it('достаёт url из свойств узла', () => {
    const raw = ax('1', 'link', { properties: [{ name: 'url', value: { value: 'https://a.example/x' } }] });
    expect(extractUrlFromAxNode(raw)).toBe('https://a.example/x');
  });

  it('возвращает undefined, когда url пустой', () => {
    const raw = ax('1', 'link', { properties: [{ name: 'url', value: { value: '  ' } }] });
    expect(extractUrlFromAxNode(raw)).toBeUndefined();
  });
});
