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
