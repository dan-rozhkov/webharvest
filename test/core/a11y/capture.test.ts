import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright';
import { captureSnapshot } from '../../../src/core/a11y/capture.js';
import { HarvestError } from '../../../src/core/errors.js';

/**
 * `captureSnapshot` принимает Playwright `Page` и сам открывает CDP-сессию
 * через `page.context().newCDPSession(page)`. Подделываем именно эту цепочку:
 * дальше код общается только с объектом, который умеет `send`/`detach`, как и
 * настоящая CDP-сессия.
 */
function fakePage(handler: (method: string, params?: Record<string, unknown>) => unknown): { page: Page } {
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      const result = handler(method, params);
      if (result instanceof Error) throw result;
      return result;
    },
    detach: async () => {},
  };
  const page = {
    context: () => ({
      newCDPSession: async () => cdp,
    }),
  } as unknown as Page;
  return { page };
}

describe('a11y/capture: captureSnapshot', () => {
  it('бросает HarvestError, если Accessibility.getFullAXTree вернул пустое дерево', async () => {
    const { page } = fakePage((method) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return new Error('домен недоступен');
      if (method === 'DOM.getDocument') {
        return { root: { nodeName: '#document', backendNodeId: 1, childNodeCount: 0 } };
      }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      throw new Error(`неожиданный вызов ${method}`);
    });

    await expect(captureSnapshot(page)).rejects.toMatchObject({
      code: 'internal',
    });
    await expect(captureSnapshot(page)).rejects.toBeInstanceOf(HarvestError);
  });

  it('называет ошибку enable в сообщении, а не проглатывает её молча', async () => {
    const { page } = fakePage((method) => {
      if (method === 'DOM.enable') return {};
      if (method === 'Accessibility.enable') return new Error('домен недоступен');
      if (method === 'DOM.getDocument') {
        return { root: { nodeName: '#document', backendNodeId: 1, childNodeCount: 0 } };
      }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      throw new Error(`неожиданный вызов ${method}`);
    });

    await expect(captureSnapshot(page)).rejects.toThrow(/домен недоступен/);
  });

  it('всегда детачит CDP-сессию, даже когда дерево пустое', async () => {
    let detached = 0;
    const cdp = {
      send: async (method: string) => {
        if (method === 'DOM.enable' || method === 'Accessibility.enable') return {};
        if (method === 'DOM.getDocument') {
          return { root: { nodeName: '#document', backendNodeId: 1, childNodeCount: 0 } };
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        throw new Error(`неожиданный вызов ${method}`);
      },
      detach: async () => {
        detached++;
      },
    };
    const page = {
      context: () => ({
        newCDPSession: async () => cdp,
      }),
    } as unknown as Page;

    await expect(captureSnapshot(page)).rejects.toBeInstanceOf(HarvestError);
    expect(detached).toBe(1);
  });
});
