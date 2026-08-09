import { chromium, type Browser, type BrowserContext } from 'playwright';
import { HarvestError } from './errors.js';

export interface RenderResult {
  html: string;
  finalUrl: string;
  status: number;
}

export interface BrowserPool {
  render(url: string, opts?: { timeoutMs?: number }): Promise<RenderResult>;
  shutdown(): Promise<void>;
  isRunning(): boolean;
}

export interface BrowserPoolOptions {
  idleTimeoutMs?: number;
  maxConcurrent?: number;
  headless?: boolean;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ru'] });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3].map((i) => ({ name: 'Chrome PDF Plugin ' + i })),
  });
  window.chrome = window.chrome || { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(p);
`;

export function createBrowserPool(opts: BrowserPoolOptions = {}): BrowserPool {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const maxConcurrent = opts.maxConcurrent ?? 3;
  const headless = opts.headless ?? true;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let active = 0;
  // Each in-flight render holds a "generation" token for the browser/context
  // instance it acquired, so a shutdown racing a render never lets that
  // render tear down (or touch the idle timer of) a *newer* instance.
  let generation = 0;
  const waiting: (() => void)[] = [];

  // Serializes concurrent launches so two overlapping renders that both see
  // context === null don't each start their own `chromium.launch()`.
  let launching: Promise<{ ctx: BrowserContext; gen: number }> | null = null;

  async function ensure(): Promise<{ ctx: BrowserContext; gen: number }> {
    if (context) return { ctx: context, gen: generation };
    if (launching) return launching;
    launching = (async () => {
      const b = await chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
      });
      const c = await b.newContext({
        userAgent: UA,
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        timezoneId: 'Europe/Nicosia',
        deviceScaleFactor: 2,
        extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9,ru;q=0.8' },
      });
      await c.addInitScript(STEALTH_INIT);
      // Many real-world (and test) servers serve HTML without a charset in
      // Content-Type. Browsers then fall back to a legacy locale-dependent
      // encoding (often Latin-1-ish) and mangle non-ASCII text. Since this
      // pool is a scraper, not a browser for humans, default such responses
      // to UTF-8 rather than reproduce that legacy guess.
      await c.route('**/*', async (route) => {
        const request = route.request();
        if (request.resourceType() !== 'document') {
          await route.continue();
          return;
        }
        let response;
        try {
          response = await route.fetch();
        } catch {
          await route.abort().catch(() => {});
          return;
        }
        const headers = response.headers();
        const ct = headers['content-type'];
        if (ct && /text\/html/i.test(ct) && !/charset=/i.test(ct)) {
          headers['content-type'] = `${ct}; charset=utf-8`;
          await route.fulfill({ response, headers });
        } else {
          await route.fulfill({ response });
        }
      });
      browser = b;
      context = c;
      generation += 1;
      return { ctx: c, gen: generation };
    })();
    try {
      return await launching;
    } finally {
      launching = null;
    }
  }

  function touchIdle(gen: number): void {
    // Stale generation (a shutdown/relaunch happened while we were
    // rendering): don't resurrect a timer for an instance that is gone,
    // and don't cancel the timer belonging to a newer instance.
    if (gen !== generation) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void shutdown();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  async function shutdown(): Promise<void> {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    // If a launch is in progress, wait for it before deciding what to
    // close. Otherwise a shutdown that races ahead of `ensure()` would
    // return while context/browser are still null, and the browser that
    // finishes launching a moment later would never get closed - it
    // would just sit there, invisible to isRunning(), leaking the
    // process shutdown() promised to end.
    if (launching) {
      await launching.catch(() => {});
    }
    const c = context;
    const b = browser;
    context = null;
    browser = null;
    await c?.close().catch(() => {});
    await b?.close().catch(() => {});
  }

  async function doRender(url: string, timeout: number): Promise<RenderResult> {
    let gen: number;
    let page: Awaited<ReturnType<BrowserContext['newPage']>>;
    try {
      const acquired = await ensure();
      gen = acquired.gen;
      page = await acquired.ctx.newPage();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HarvestError('network', `Не удалось запустить браузер: ${msg}`);
    }
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 8000) }).catch(() => {});
      await page.waitForTimeout(300);
      const html = await page.content();
      return { html, finalUrl: page.url(), status: response?.status() ?? 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Timeout|timeout/i.test(msg)) {
        throw new HarvestError('timeout', `Браузер не дождался ${url} за ${timeout} мс`);
      }
      throw new HarvestError('network', `Браузер не смог открыть ${url}: ${msg}`);
    } finally {
      await page.close().catch(() => {});
      touchIdle(gen);
    }
  }

  async function render(url: string, o: { timeoutMs?: number } = {}): Promise<RenderResult> {
    const timeout = o.timeoutMs ?? 30_000;

    while (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      active--;
      // Wake exactly one waiter; it re-checks the cap itself.
      waiting.shift()?.();
    };

    try {
      // page.goto()'s own `timeout` option only bounds navigation. It does
      // not bound ensure()/newPage(), and it cannot save us if the context
      // is closed out from under an in-flight operation by a concurrent
      // shutdown() - Playwright then leaves that operation's promise
      // permanently unresolved instead of rejecting it. A hard deadline
      // around the whole pipeline is the only way to guarantee render()
      // always settles within timeoutMs, whatever the browser does
      // internally. The loser keeps running in the background (its own
      // finally still closes the page and touches the idle timer); we
      // just stop waiting on it.
      let deadline: NodeJS.Timeout | undefined;
      const deadlinePromise = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          reject(new HarvestError('timeout', `Браузер не дождался ${url} за ${timeout} мс`));
        }, timeout);
        deadline.unref?.();
      });
      try {
        return await Promise.race([doRender(url, timeout), deadlinePromise]);
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      release();
    }
  }

  return { render, shutdown, isRunning: () => context !== null };
}
