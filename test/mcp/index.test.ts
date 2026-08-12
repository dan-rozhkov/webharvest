import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/index.js';
import type { DaemonClient } from '../../src/mcp/client.js';

// Everything in test/mcp/tools.test.ts calls handleScrape/handleSearch
// directly against a stub — real coverage of src/mcp/index.ts (the actual
// binary Claude Code launches: tool-name dispatch via
// `req.params.name === 'scrape'`, the unknown-tool fallback, tools/list)
// never ran. These tests drive the real Server through a real MCP Client
// over an in-memory transport pair, so a typo in the dispatch string would
// actually fail a test instead of 300 green tests hiding it.

function stubClient(overrides: Partial<DaemonClient> = {}): DaemonClient {
  return {
    scrape: async () => ({ url: 'https://a/', title: 'T', markdown: 'a'.repeat(500), via: 'http', cached: false, status: 200 }),
    search: async () => [{ url: 'https://a/', title: 'A', snippet: 's', engine: 'brave' }],
    ...overrides,
  } as DaemonClient;
}

async function connect(client: DaemonClient): Promise<Client> {
  const server = createMcpServer(client);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
}

function textOf(res: Awaited<ReturnType<Client['callTool']>>): string {
  const content = res.content as { type: string; text: string }[];
  return content[0]?.text ?? '';
}

describe('MCP server (real Server + real Client, in-memory transport)', () => {
  it('tools/list отдаёт scrape, search и инструменты browser use с непустыми схемами', async () => {
    const mcpClient = await connect(stubClient());
    const { tools } = await mcpClient.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'browser_act', 'browser_close', 'browser_extract', 'browser_observe', 'browser_open', 'scrape', 'search',
    ]);
    for (const t of tools) {
      expect((t.inputSchema as { required?: string[] }).required?.length).toBeGreaterThan(0);
    }
  });

  it('tools/call scrape реально доходит через диспетчер до daemon-клиента и форматтера', async () => {
    const scrape = vi.fn(async () => ({
      url: 'https://a/', title: 'Заголовок', markdown: 'текст статьи', via: 'http' as const, cached: false, status: 200,
    }));
    const mcpClient = await connect(stubClient({ scrape }));
    const res = await mcpClient.callTool({ name: 'scrape', arguments: { url: 'https://a/' } });
    // Proves the request actually crossed the protocol boundary and hit our
    // client — not just that the SDK echoed something back.
    expect(scrape).toHaveBeenCalledWith({ url: 'https://a/', refresh: false, includeLinks: false });
    expect(textOf(res)).toContain('# Заголовок');
  });

  it('tools/call search реально доходит через диспетчер до daemon-клиента и форматтера', async () => {
    const search = vi.fn(async () => [{ url: 'https://x/', title: 'X-результат', snippet: 's', engine: 'brave' }]);
    const mcpClient = await connect(stubClient({ search }));
    const res = await mcpClient.callTool({ name: 'search', arguments: { query: 'q' } });
    expect(search).toHaveBeenCalledWith({ query: 'q', limit: 5, fetchContent: false });
    expect(textOf(res)).toContain('X-результат');
  });

  it('неизвестное имя инструмента отвечает читаемым текстом через протокол, а не падает и не молчит', async () => {
    const mcpClient = await connect(stubClient());
    const res = await mcpClient.callTool({ name: 'not-a-real-tool', arguments: {} });
    const text = textOf(res);
    expect(text).toContain('Неизвестный инструмент');
    expect(text).toContain('not-a-real-tool');
  });

  it('ошибка daemon-клиента при вызове через протокол приходит агенту как читаемый текст, а не как protocol error', async () => {
    const { HarvestError } = await import('../../src/core/errors.js');
    const mcpClient = await connect(
      stubClient({ scrape: async () => { throw new HarvestError('blocked', 'закрыто cloudflare', { by: 'cloudflare' }); } }),
    );
    const res = await mcpClient.callTool({ name: 'scrape', arguments: { url: 'https://a/' } });
    expect(textOf(res)).toContain('cloudflare');
  });
});
