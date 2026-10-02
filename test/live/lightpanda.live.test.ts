import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createLightpandaPool } from '../../src/core/lightpanda.js';
import type { BrowserPool } from '../../src/core/browser.js';

// Нужен настоящий бинарь: WEBHARVEST_LIVE=1 WEBHARVEST_LIGHTPANDA_BIN=/path/to/lightpanda.
const BIN = process.env.WEBHARVEST_LIGHTPANDA_BIN;
const live = process.env.WEBHARVEST_LIVE === '1' && BIN ? describe : describe.skip;

const SPA = `<!doctype html><html><head><title>SPA</title></head><body>
<div id="root"></div>
<script>
  fetch('/api/data').then(r => r.text()).then(t => {
    document.getElementById('root').innerHTML = '<h1>' + t + '</h1>';
  });
</script>
</body></html>`;

live('Lightpanda: пул рендера', () => {
  let server: Server;
  let base: string;
  let pool: BrowserPool;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/api/data') {
        setTimeout(() => res.end('Rendered by script'), 50);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SPA);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    pool = createLightpandaPool({ bin: BIN! });
  });

  afterAll(async () => {
    await pool.shutdown();
    server.close();
  });

  it('рендерит контент, который дорисовал скрипт', async () => {
    const r = await pool.render(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.html).toContain('Rendered by script');
    expect(pool.isRunning()).toBe(true);
  });

  it('держит несколько рендеров параллельно (подключение на рендер)', async () => {
    const results = await Promise.all([1, 2, 3, 4].map((i) => pool.render(`${base}/p${i}`)));
    for (const r of results) expect(r.html).toContain('Rendered by script');
  });

  it('после shutdown процесс остановлен и рендер отклонён', async () => {
    const p = createLightpandaPool({ bin: BIN! });
    await p.render(`${base}/`);
    await p.shutdown();
    expect(p.isRunning()).toBe(false);
    await expect(p.render(`${base}/`)).rejects.toMatchObject({ code: 'network' });
  });

  it('отсутствующий бинарь даёт HarvestError network, а не крэш', async () => {
    const p = createLightpandaPool({ bin: '/nonexistent/lightpanda' });
    await expect(p.render(`${base}/`)).rejects.toMatchObject({ code: 'network' });
    await p.shutdown();
  });
});
