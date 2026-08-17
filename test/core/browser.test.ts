import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createBrowserPool, type BrowserPool, retryPageContent } from '../../src/core/browser.js';

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
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/** Encodes ASCII + Cyrillic (А-Я, а-я, Ё, ё) text as raw windows-1251 bytes. */
function encodeWindows1251(text: string): Buffer {
  const bytes = Array.from(text).map((ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) return cp;
    if (cp >= 0x0410 && cp <= 0x042f) return 0xc0 + (cp - 0x0410); // А-Я
    if (cp >= 0x0430 && cp <= 0x044f) return 0xe0 + (cp - 0x0430); // а-я
    if (cp === 0x0401) return 0xa8; // Ё
    if (cp === 0x0451) return 0xb8; // ё
    throw new Error(`no windows-1251 mapping for ${ch}`);
  });
  return Buffer.from(bytes);
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

  it('сообщает финальный URL после client-side редиректа', async () => {
    const base = await serve((url) =>
      url === '/from'
        ? { body: '<html><head><meta http-equiv="refresh" content="0;url=/to"></head><body>x</body></html>' }
        : { body: '<html><body><p>цель</p></body></html>' },
    );
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const r = await pool.render(base + '/from');
    expect(r.finalUrl).toContain('/to');
  });

  it('сообщает финальный URL после настоящего HTTP 302', async () => {
    server = createServer((req, res) => {
      if (req.url === '/from') {
        res.writeHead(302, { location: '/to' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><p>цель</p></body></html>');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const r = await pool.render(`http://127.0.0.1:${port}/from`);
    expect(r.finalUrl).toContain('/to');
  });

  it('бросает too_large, если отрендеренный HTML превысил лимит', async () => {
    const base = await serve(() => ({ body: '<html><body>' + 'x'.repeat(5000) + '</body></html>' }));
    pool = createBrowserPool({ idleTimeoutMs: 60_000, maxBytes: 1000 });
    const err = await pool.render(base + '/').catch((e) => e);
    expect(err).toMatchObject({ code: 'too_large' });
  });

  it('не бросает too_large, когда HTML укладывается в лимит', async () => {
    const base = await serve(() => ({ body: '<html><body><p>малeнький текст</p></body></html>' }));
    pool = createBrowserPool({ idleTimeoutMs: 60_000, maxBytes: 1000 });
    const r = await pool.render(base + '/');
    expect(r.html).toContain('малeнький');
  });

  it('уважает кодировку, объявленную через meta charset, а не навязывает UTF-8', async () => {
    const word = 'Привет';
    const body = Buffer.concat([
      Buffer.from('<html><head><meta charset="windows-1251"></head><body><p>', 'latin1'),
      encodeWindows1251(word),
      Buffer.from('</p></body></html>', 'latin1'),
    ]);
    server = createServer((req, res) => {
      // Deliberately no charset in the HTTP header - the page must be
      // decoded per its own <meta charset>, not forced to UTF-8.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const r = await pool.render(`http://127.0.0.1:${port}/`);
    expect(r.html).toContain(word);
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

  it('не закрывает браузер по простою, если рендер ещё выполняется', async () => {
    // A render that's still running when the idle timer would fire must
    // not have its context torn down out from under it. Uses a server
    // that responds slower than idleTimeoutMs.
    server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body><p>долго</p></body></html>');
      }, 600);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    pool = createBrowserPool({ idleTimeoutMs: 300 });
    const r = await pool.render(`http://127.0.0.1:${port}/`, { timeoutMs: 5000 });
    expect(r.html).toContain('долго');
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
          maxTouchPoints: navigator.maxTouchPoints,
          vendor: navigator.vendor,
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
    // maxTouchPoints форсится в 0 через STEALTH_INIT — headless-хром на
    // десктопе и так отдаёт 0, но явный getter защищает от изменения
    // дефолтов. vendor у headless chromium обычно уже 'Google Inc.', но
    // проверка держит его на виду, если движок когда-нибудь изменится.
    expect(probe.maxTouchPoints).toBe(0);
    expect(probe.vendor).toBe('Google Inc.');
  });

  it('ограничивает число одновременных рендеров maxConcurrent', async () => {
    let concurrent = 0;
    let maxObserved = 0;
    server = createServer((req, res) => {
      concurrent++;
      maxObserved = Math.max(maxObserved, concurrent);
      setTimeout(() => {
        concurrent--;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>x</body></html>');
      }, 400);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    pool = createBrowserPool({ idleTimeoutMs: 60_000, maxConcurrent: 2 });
    await Promise.all([pool.render(base + '/a'), pool.render(base + '/b'), pool.render(base + '/c')]);
    expect(maxObserved).toBe(2);
  });

  it('переживает shutdown, вызванный во время рендера, и не работает после остановки', async () => {
    const base = await serve(() => ({ body: '<html><body><p>ok</p></body></html>' }));
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const renderPromise = pool.render(base + '/', { timeoutMs: 5000 });
    // The exact fate of a render racing shutdown at this granularity
    // depends on Playwright-internal timing (whether the context closes
    // before or after the in-flight navigation lands), so we don't pin
    // that outcome - only that it settles.
    await Promise.allSettled([renderPromise, pool.shutdown()]);
    expect(pool.isRunning()).toBe(false);
    // shutdown() is terminal: no auto-relaunch, further renders reject.
    await expect(pool.render(base + '/')).rejects.toMatchObject({ code: 'network' });
  });

  it('отклоняет рендер, ожидавший слот в очереди, если shutdown случился раньше', async () => {
    let releaseFirst: (() => void) | undefined;
    server = createServer((req, res) => {
      // Hold the first request open until the test releases it, so the
      // second render() call is guaranteed to still be queued behind the
      // maxConcurrent(1) gate - never having touched the browser at all -
      // when shutdown() runs.
      releaseFirst = () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>x</body></html>');
      };
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    pool = createBrowserPool({ idleTimeoutMs: 60_000, maxConcurrent: 1 });

    const first = pool.render(base + '/', { timeoutMs: 5000 });
    const second = pool.render(base + '/', { timeoutMs: 5000 });
    // Attach handlers immediately: shutdown() below can cause either of
    // these to settle inside its own await (chained through closing the
    // context), before the real assertions further down get a chance to
    // attach - Node would otherwise report a transient unhandled rejection.
    first.catch(() => {});
    second.catch(() => {});

    // Wait until the first request actually reaches the server (proving
    // it holds the only slot), then shut the pool down while `second` is
    // still parked in the wait queue.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (releaseFirst) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    await pool.shutdown();
    await expect(second).rejects.toMatchObject({ code: 'network' });

    releaseFirst?.();
    await Promise.allSettled([first]);
  });

  it(
    'shutdown() дренирует всю очередь ожидающих слота, а не будит только одного',
    async () => {
      // Regression for a deadlock: with maxConcurrent:1, one render holds
      // the only slot and two more are parked in `waiting`. release() only
      // ever wakes one waiter, and a woken waiter that sees closed===true
      // throws without incrementing `active` or calling release() itself -
      // so the second queued render never got woken at all and its promise
      // stayed pending forever. Without draining the whole queue in
      // shutdown(), this test hangs past its own timeout instead of
      // rejecting quickly.
      let releaseFirst: (() => void) | undefined;
      server = createServer((req, res) => {
        if (!releaseFirst) {
          releaseFirst = () => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<html><body>x</body></html>');
          };
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>x</body></html>');
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      const { port } = server!.address() as { port: number };
      const base = `http://127.0.0.1:${port}`;
      pool = createBrowserPool({ idleTimeoutMs: 60_000, maxConcurrent: 1 });

      const first = pool.render(base + '/', { timeoutMs: 5000 });
      const second = pool.render(base + '/', { timeoutMs: 5000 });
      const third = pool.render(base + '/', { timeoutMs: 5000 });
      first.catch(() => {});
      second.catch(() => {});
      third.catch(() => {});

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (releaseFirst) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      });

      await pool.shutdown();
      // Both queued renders must reject promptly, not hang.
      await expect(second).rejects.toMatchObject({ code: 'network' });
      await expect(third).rejects.toMatchObject({ code: 'network' });

      releaseFirst?.();
      await Promise.allSettled([first]);
    },
    8000,
  );

  it('повторно пытается получить контент при race condition навигации (deterministic)', async () => {
    // Unit test: retryPageContent retries specifically on navigation race,
    // not on other errors. Uses stub that throws exactly twice, then succeeds.
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('Unable to retrieve content because the page is navigating and changing the content.');
      }
      return '<html>success</html>';
    };
    const result = await retryPageContent(fn, { maxRetries: 3, waitMs: 0 });
    expect(result).toBe('<html>success</html>');
    expect(callCount).toBe(3);
  });

  it('не повторяет попытку для других ошибок', async () => {
    // retryPageContent does NOT retry on non-navigation errors
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('Some other error');
    };
    await expect(retryPageContent(fn, { maxRetries: 3 })).rejects.toMatchObject({
      message: 'Some other error',
    });
    expect(callCount).toBe(1); // Tried once, then re-threw
  });

  it('отказывает после исчерпания попыток', async () => {
    // retryPageContent gives up after maxRetries attempts
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('Unable to retrieve content because the page is navigating and changing the content.');
    };
    await expect(retryPageContent(fn, { maxRetries: 2, waitMs: 0 })).rejects.toMatchObject({
      message: expect.stringContaining('page is navigating'),
    });
    expect(callCount).toBe(2); // Tried twice, then gave up
  });

  it('дожидается разрешения имитированного челленджа и возвращает контент', async () => {
    const base = await serve(() => ({
      body: `<html><body>
        <div id="challenge-stage" style="width:300px;height:65px"></div>
        <div id="root"></div>
        <script>
          setTimeout(() => {
            document.getElementById('challenge-stage').remove();
            document.getElementById('root').textContent = 'контент после челленджа';
          }, 2000);
        </script>
      </body></html>`,
    }));
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const r = await pool.render(base + '/', { timeoutMs: 15_000 });
    expect(r.html).toContain('контент после челленджа');
  });
});
