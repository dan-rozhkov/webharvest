import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createDaemonClient } from '../../src/mcp/client.js';

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function serve(status: number, body: unknown): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe('createDaemonClient', () => {
  it('возвращает тело успешного ответа', async () => {
    const base = await serve(200, { url: 'https://a/', title: 'T', markdown: 'M', via: 'http', cached: false });
    const c = createDaemonClient(base);
    expect(await c.scrape({ url: 'https://a/' })).toMatchObject({ title: 'T' });
  });

  it('превращает ошибку демона в HarvestError с тем же кодом', async () => {
    const base = await serve(422, { error: { code: 'blocked', message: 'закрыто cloudflare', detail: { by: 'cloudflare' } } });
    const c = createDaemonClient(base);
    await expect(c.scrape({ url: 'https://a/' })).rejects.toMatchObject({ code: 'blocked' });
  });

  it('бросает daemon_down, когда демон не отвечает', async () => {
    const c = createDaemonClient('http://127.0.0.1:1');
    const err = await c.scrape({ url: 'https://a/' }).catch((e) => e);
    expect(err.code).toBe('daemon_down');
    expect(err.message).toContain('webharvest start');
  });
});
