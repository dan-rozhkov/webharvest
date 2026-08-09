#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDaemonClient, type DaemonClient } from './client.js';
import { TOOL_DEFINITIONS, handleScrape, handleSearch } from './tools.js';

/**
 * Builds the MCP server and wires up tool dispatch, but does not connect any
 * transport — separated out so tests can drive the real dispatch logic
 * (tool-name matching, the unknown-tool branch) over a real MCP Client/
 * transport pair, instead of only ever calling handleScrape/handleSearch
 * directly and never touching this file at all.
 */
export function createMcpServer(client: DaemonClient): Server {
  const server = new Server(
    { name: 'webharvest', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, never>;
    const text =
      req.params.name === 'scrape' ? await handleScrape(client, args as never)
      : req.params.name === 'search' ? await handleSearch(client, args as never)
      : `Неизвестный инструмент: ${req.params.name}`;
    return { content: [{ type: 'text', text }] };
  });

  return server;
}

async function main(): Promise<void> {
  const baseUrl = process.env.WEBHARVEST_URL ?? 'http://127.0.0.1:8787';
  const client = createDaemonClient(baseUrl);
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
}

// Only run the stdio server when this file is executed directly (as the
// binary Claude Code launches) — not when imported, e.g. by tests that want
// createMcpServer() without also connecting real stdin/stdout.
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await main();
}
