#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDaemonClient } from './client.js';
import { TOOL_DEFINITIONS, handleScrape, handleSearch } from './tools.js';

const baseUrl = process.env.WEBHARVEST_URL ?? 'http://127.0.0.1:8787';
const client = createDaemonClient(baseUrl);

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

await server.connect(new StdioServerTransport());
