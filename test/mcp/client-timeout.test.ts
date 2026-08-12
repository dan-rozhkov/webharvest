import { describe, it, expect, vi, beforeEach } from 'vitest';

// Мокаем undici.request, чтобы проверить фактические таймауты в опциях
// вызова, не поднимая настоящий HTTP-сервер и не дожидаясь реальных
// таймаутов (120с/600с в тесте никто ждать не будет).
const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...args: unknown[]) => requestMock(...args) }));

function jsonBody(payload: unknown) {
  return { json: async () => payload };
}

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ statusCode: 200, body: jsonBody({ sessionId: 's1', outline: '' }) });
});

describe('mcp/client: таймауты browser_* длиннее, чем у scrape/search', () => {
  it('scrape уходит с дефолтным (120с) таймаутом', async () => {
    const { createDaemonClient } = await import('../../src/mcp/client.js');
    const c = createDaemonClient('http://127.0.0.1:1');
    requestMock.mockResolvedValueOnce({ statusCode: 200, body: jsonBody({ url: 'https://a/', title: 'T', markdown: 'M', via: 'http', cached: false }) });
    await c.scrape({ url: 'https://a/' });
    const opts = requestMock.mock.calls[0]![1] as { headersTimeout: number; bodyTimeout: number };
    expect(opts.headersTimeout).toBe(120_000);
    expect(opts.bodyTimeout).toBe(120_000);
  });

  it('browser_open уходит с увеличенным (180с) таймаутом — дольше дефолтного', async () => {
    const { createDaemonClient } = await import('../../src/mcp/client.js');
    const c = createDaemonClient('http://127.0.0.1:1');
    await c.browserOpen({ url: 'https://a/' });
    const opts = requestMock.mock.calls[0]![1] as { headersTimeout: number; bodyTimeout: number };
    expect(opts.headersTimeout).toBe(180_000);
    expect(opts.bodyTimeout).toBe(180_000);
    expect(opts.headersTimeout).toBeGreaterThan(120_000);
  });

  it('browser_click тоже уходит с увеличенным таймаутом', async () => {
    const { createDaemonClient } = await import('../../src/mcp/client.js');
    const c = createDaemonClient('http://127.0.0.1:1');
    requestMock.mockResolvedValueOnce({ statusCode: 200, body: jsonBody({ changed: '' }) });
    await c.browserClick({ sessionId: 's1', elementId: '0-1' });
    const opts = requestMock.mock.calls[0]![1] as { headersTimeout: number; bodyTimeout: number };
    expect(opts.headersTimeout).toBe(180_000);
  });
});
