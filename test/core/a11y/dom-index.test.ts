import { describe, it, expect } from 'vitest';
import {
  shouldExpandNode,
  enrichedTagName,
  getDomTreeWithFallback,
  buildDomMaps,
  type CdpSender,
  type DomNode,
} from '../../../src/core/a11y/dom-index.js';

/** Поддельная CDP-сессия: отвечает по заранее заданному сценарию и пишет лог. */
function fakeSession(handler: (method: string, params: Record<string, unknown>) => unknown): CdpSender & { calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      const result = handler(method, params);
      if (result instanceof Error) throw result;
      return result as T;
    },
  };
}

describe('a11y/dom-index: shouldExpandNode', () => {
  it('видит обрезку по расхождению счётчика и массива детей', () => {
    expect(shouldExpandNode({ nodeName: 'DIV', childNodeCount: 3, children: [] })).toBe(true);
  });

  it('не считает обрезкой полностью выданных детей', () => {
    const kid: DomNode = { nodeName: 'SPAN' };
    expect(shouldExpandNode({ nodeName: 'DIV', childNodeCount: 1, children: [kid] })).toBe(false);
  });
});

describe('a11y/dom-index: enrichedTagName', () => {
  it('дополняет input его типом', () => {
    expect(enrichedTagName({ nodeName: 'INPUT', attributes: ['type', 'password'] })).toBe('input, password');
  });

  it('оставляет обычный тег в нижнем регистре', () => {
    expect(enrichedTagName({ nodeName: 'DIV' })).toBe('div');
  });

  it('оставляет input без type просто input', () => {
    expect(enrichedTagName({ nodeName: 'INPUT' })).toBe('input');
  });
});

describe('a11y/dom-index: getDomTreeWithFallback', () => {
  it('уменьшает глубину, пока CDP не перестанет ругаться на стек CBOR', async () => {
    const session = fakeSession((method, params) => {
      if (method !== 'DOM.getDocument') throw new Error(`неожиданный вызов ${method}`);
      if (params.depth === -1 || params.depth === 256) return new Error('CBOR: stack limit exceeded');
      return { root: { nodeName: '#document', backendNodeId: 1, childNodeCount: 0 } };
    });
    const root = await getDomTreeWithFallback(session);
    expect(root.nodeName).toBe('#document');
    expect(session.calls.map((c) => c.params.depth)).toEqual([-1, 256, 128]);
  });

  it('пробрасывает не-CBOR ошибку сразу, без ретраев', async () => {
    const session = fakeSession(() => new Error('Session closed'));
    await expect(getDomTreeWithFallback(session)).rejects.toThrow('Session closed');
    expect(session.calls).toHaveLength(1);
  });

  it('догидратирует обрезанные ветки через describeNode', async () => {
    const session = fakeSession((method, params) => {
      if (method === 'DOM.getDocument') {
        if (params.depth === -1) return new Error('CBOR: stack limit exceeded');
        return {
          root: { nodeName: '#document', backendNodeId: 1, nodeId: 1, childNodeCount: 1, children: [] },
        };
      }
      if (method === 'DOM.describeNode') {
        return { node: { nodeName: '#document', backendNodeId: 1, nodeId: 1, childNodeCount: 1, children: [{ nodeName: 'HTML', backendNodeId: 2, nodeId: 2 }] } };
      }
      throw new Error(`неожиданный вызов ${method}`);
    });
    const root = await getDomTreeWithFallback(session);
    expect(root.children?.[0]?.nodeName).toBe('HTML');
  });

  it('не путает пространства nodeId и backendNodeId при дедупликации узлов', async () => {
    // У SPAN нет nodeId, зато backendNodeId=5. У DIV — другой, несвязанный
    // узел с nodeId=5. Число 5 одно и то же, но пространства разные: если
    // дедупликация схлопывает их в один ключ, обрезанная ветка SPAN
    // молча останется недогидратированной.
    const session = fakeSession((method, params) => {
      if (method === 'DOM.getDocument') {
        if (params.depth === -1) return new Error('CBOR: stack limit exceeded');
        return {
          root: {
            nodeName: '#document',
            nodeId: 1,
            backendNodeId: 1,
            childNodeCount: 2,
            children: [
              { nodeName: 'SPAN', backendNodeId: 5, childNodeCount: 1, children: [] },
              { nodeName: 'DIV', nodeId: 5, backendNodeId: 50, childNodeCount: 0, children: [] },
            ],
          },
        };
      }
      if (method === 'DOM.describeNode') {
        if (params.backendNodeId === 5) {
          return {
            node: {
              nodeName: 'SPAN',
              backendNodeId: 5,
              childNodeCount: 1,
              children: [{ nodeName: 'A', backendNodeId: 6 }],
            },
          };
        }
        throw new Error(`неожиданный describeNode для ${JSON.stringify(params)}`);
      }
      throw new Error(`неожиданный вызов ${method}`);
    });

    const root = await getDomTreeWithFallback(session);
    const span = root.children?.find((c) => c.nodeName === 'SPAN');
    expect(span?.children?.[0]?.nodeName).toBe('A');
  });

  it('не схлопывает нескольких детей с nodeId:0 после describeNode в один ключ дедупликации', async () => {
    // DOM.describeNode не пушит дочерние узлы во фронтенд, поэтому все три
    // ребёнка приходят с nodeId: 0 — различаются только backendNodeId. Раньше
    // ключ дедупликации брал `nodeId !== undefined`, и все трое схлопывались
    // в один и тот же ключ "n:0": обрабатывался только первый, остальные два
    // молча пропускались вместе со всем их поддеревом.
    const session = fakeSession((method, params) => {
      if (method === 'DOM.getDocument') {
        if (params.depth === -1) return new Error('CBOR: stack limit exceeded');
        return {
          root: { nodeName: '#document', nodeId: 1, backendNodeId: 1, childNodeCount: 1, children: [] },
        };
      }
      if (method === 'DOM.describeNode') {
        if (params.nodeId === 1) {
          return {
            node: {
              nodeName: '#document',
              nodeId: 1,
              backendNodeId: 1,
              childNodeCount: 3,
              children: [
                { nodeName: 'A', nodeId: 0, backendNodeId: 10, childNodeCount: 1, children: [] },
                { nodeName: 'A', nodeId: 0, backendNodeId: 11, childNodeCount: 1, children: [] },
                { nodeName: 'A', nodeId: 0, backendNodeId: 12, childNodeCount: 1, children: [] },
              ],
            },
          };
        }
        if (params.backendNodeId === 10) {
          return { node: { nodeName: 'A', nodeId: 0, backendNodeId: 10, childNodeCount: 1, children: [{ nodeName: 'SPAN', backendNodeId: 100 }] } };
        }
        if (params.backendNodeId === 11) {
          return { node: { nodeName: 'A', nodeId: 0, backendNodeId: 11, childNodeCount: 1, children: [{ nodeName: 'SPAN', backendNodeId: 101 }] } };
        }
        if (params.backendNodeId === 12) {
          return { node: { nodeName: 'A', nodeId: 0, backendNodeId: 12, childNodeCount: 1, children: [{ nodeName: 'SPAN', backendNodeId: 102 }] } };
        }
        throw new Error(`неожиданный describeNode для ${JSON.stringify(params)}`);
      }
      throw new Error(`неожиданный вызов ${method}`);
    });

    const root = await getDomTreeWithFallback(session);
    const kids = root.children ?? [];
    expect(kids).toHaveLength(3);
    // Все три ветки должны быть дособраны, а не только первая попавшаяся.
    expect(kids.map((k) => k.children?.[0]?.nodeName)).toEqual(['SPAN', 'SPAN', 'SPAN']);
  });
});

describe('a11y/dom-index: buildDomMaps', () => {
  it('строит теги, xpath и скроллируемость по обходу дерева', async () => {
    const doc: DomNode = {
      nodeName: '#document',
      backendNodeId: 1,
      children: [
        {
          nodeName: 'BODY',
          backendNodeId: 2,
          isScrollable: true,
          children: [
            { nodeName: 'INPUT', backendNodeId: 3, attributes: ['type', 'email'] },
            { nodeName: 'INPUT', backendNodeId: 4, attributes: ['type', 'password'] },
          ],
        },
      ],
    };
    const session = fakeSession((method) =>
      method === 'DOM.getDocument' ? { root: doc } : undefined,
    );

    const maps = await buildDomMaps(session, 0);
    expect(maps.tagNameMap['0-3']).toBe('input, email');
    expect(maps.tagNameMap['0-4']).toBe('input, password');
    expect(maps.scrollableMap['0-2']).toBe(true);
    expect(maps.scrollableMap['0-3']).toBeUndefined();
    // Одноимённые соседи нумеруются с единицы, как того требует XPath.
    expect(maps.xpathMap['0-3']).toBe('/body[1]/input[1]');
    expect(maps.xpathMap['0-4']).toBe('/body[1]/input[2]');
  });

  it('обозначает границу shadow root двойным слэшем', async () => {
    const doc: DomNode = {
      nodeName: '#document',
      backendNodeId: 1,
      children: [
        {
          nodeName: 'MY-WIDGET',
          backendNodeId: 2,
          shadowRoots: [
            { nodeName: '#document-fragment', backendNodeId: 3, children: [{ nodeName: 'BUTTON', backendNodeId: 4 }] },
          ],
        },
      ],
    };
    const session = fakeSession((method) =>
      method === 'DOM.getDocument' ? { root: doc } : undefined,
    );
    const maps = await buildDomMaps(session, 0);
    expect(maps.xpathMap['0-4']).toBe('/my-widget[1]//button[1]');
  });
});
