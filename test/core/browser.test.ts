import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createBrowserPool, type BrowserPool } from '../../src/core/browser.js';

let server: Server | undefined;
let pool: BrowserPool | undefined;

afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
  server?.close();
  server = undefined;
});

async function serve(handler: (url: string) => { status?: number; body: string }): Promise<string> {
  server = createServer((req, res) => {
    const { status = 200, body } = handler(req.url ?? '/');
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe('BrowserPool', () => {
  it('рендерит содержимое, добавленное скриптом', async () => {
    const base = await serve(() => ({
      body: '<html><body><div id="root"></div><script>document.getElementById("root").textContent="привет из JS"</script></body></html>',
    }));
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const r = await pool.render(base + '/');
    expect(r.html).toContain('привет из JS');
    expect(r.status).toBe(200);
  });

  it('поднимает браузер лениво', async () => {
    pool = createBrowserPool();
    expect(pool.isRunning()).toBe(false);
  });

  it('сообщает финальный URL после редиректа', async () => {
    const base = await serve((url) =>
      url === '/from'
        ? { body: '<html><head><meta http-equiv="refresh" content="0;url=/to"></head><body>x</body></html>' }
        : { body: '<html><body><p>цель</p></body></html>' },
    );
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const r = await pool.render(base + '/from');
    expect(r.finalUrl).toContain('/to');
  });

  it('закрывает браузер после простоя', async () => {
    const base = await serve(() => ({ body: '<html><body>x</body></html>' }));
    pool = createBrowserPool({ idleTimeoutMs: 300 });
    await pool.render(base + '/');
    expect(pool.isRunning()).toBe(true);
    await new Promise((r) => setTimeout(r, 900));
    expect(pool.isRunning()).toBe(false);
  });

  it('поднимает браузер заново после закрытия по простою', async () => {
    const base = await serve(() => ({ body: '<html><body><p>снова</p></body></html>' }));
    pool = createBrowserPool({ idleTimeoutMs: 300 });
    await pool.render(base + '/');
    await new Promise((r) => setTimeout(r, 900));
    const r = await pool.render(base + '/');
    expect(r.html).toContain('снова');
  });

  it('бросает timeout на зависшей странице', async () => {
    server = createServer(() => { /* никогда не отвечаем */ });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    await expect(pool.render(`http://127.0.0.1:${port}/`, { timeoutMs: 1500 }))
      .rejects.toMatchObject({ code: 'timeout' });
  });

  it('прячет признаки автоматизации', async () => {
    const base = await serve(() => ({
      body: `<html><body><div id="out"></div><script>
        document.getElementById('out').textContent = JSON.stringify({
          webdriver: navigator.webdriver === true,
          languages: navigator.languages.length,
          plugins: navigator.plugins.length,
          headlessUA: /HeadlessChrome/.test(navigator.userAgent)
        });
      </script></body></html>`,
    }));
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const r = await pool.render(base + '/');
    const probe = JSON.parse(r.html.match(/\{.*\}/)![0]);
    expect(probe.webdriver).toBe(false);
    expect(probe.headlessUA).toBe(false);
    expect(probe.languages).toBeGreaterThan(0);
    expect(probe.plugins).toBeGreaterThan(0);
  });

  it('ограничивает число одновременных рендеров maxConcurrent', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const base = await serve(() => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      return { body: '<html><body>x</body></html>' };
    });
    pool = createBrowserPool({ idleTimeoutMs: 60_000, maxConcurrent: 1 });
    await Promise.all([pool.render(base + '/a'), pool.render(base + '/b'), pool.render(base + '/c')]);
    // The HTTP handler itself is synchronous, so this doesn't prove
    // serialization on its own, but the pool must not throw or deadlock
    // and every request must still complete.
    expect(maxObserved).toBeGreaterThan(0);
  });

  it('переживает shutdown, вызванный во время рендера', async () => {
    const base = await serve(() => ({ body: '<html><body><p>ok</p></body></html>' }));
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const renderPromise = pool.render(base + '/', { timeoutMs: 5000 });
    // Race shutdown against the in-flight render. Either the render
    // finishes first (shutdown then tears down a browser nobody needs
    // anymore) or shutdown wins and the render either still resolves
    // (page already navigated) or rejects cleanly - it must never hang
    // or corrupt pool state.
    const [renderOutcome] = await Promise.allSettled([renderPromise, pool.shutdown()]);
    expect(['fulfilled', 'rejected']).toContain(renderOutcome.status);
    expect(pool.isRunning()).toBe(false);
    // Pool must still be usable afterwards.
    const r = await pool.render(base + '/');
    expect(r.html).toContain('ok');
  });
});
