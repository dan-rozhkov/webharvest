import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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
  /** Mirrors httpGet's own byte cap (fetcher.ts) — a heavy SPA rendered by a
   *  real browser is otherwise unbounded, unlike the HTTP path, and can send
   *  tens of MB through jsdom/Readability/Defuddle and into SQLite. */
  maxBytes?: number;
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

const CLOSED_MESSAGE = 'Пул браузеров остановлен, рендер отклонён';

/**
 * Retry logic for page.content() which can race with page navigation.
 * Exported for testing; call the provided fn up to maxRetries times,
 * retrying only on "page is navigating and changing the content" error.
 */
export async function retryPageContent(
  fn: () => Promise<string>,
  options: { maxRetries?: number; waitMs?: number } = {},
): Promise<string> {
  const maxRetries = options.maxRetries ?? 3;
  const waitMs = options.waitMs ?? 50;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (/page is navigating and changing the content/i.test(lastError.message)) {
        // Navigation race: retry after brief wait if not on last attempt
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }
      // Not a navigation error or exhausted retries: re-throw
      throw lastError;
    }
  }

  throw lastError ?? new Error('Failed to get page content');
}

export function createBrowserPool(opts: BrowserPoolOptions = {}): BrowserPool {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const maxConcurrent = opts.maxConcurrent ?? 3;
  const headless = opts.headless ?? true;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let active = 0;
  // Each in-flight render holds a "generation" token for the browser/context
  // instance it acquired, so a shutdown racing a render never lets that
  // render tear down (or touch the idle timer of) a *newer* instance.
  let generation = 0;
  const waiting: (() => void)[] = [];
  // Terminal flag set by the public shutdown(). Distinct from the idle
  // auto-close, which must still allow a later render() to relaunch.
  let closed = false;

  // Serializes concurrent launches so two overlapping renders that both see
  // context === null don't each start their own `chromium.launch()`.
  let launching: Promise<{ ctx: BrowserContext; gen: number }> | null = null;

  async function ensure(): Promise<{ ctx: BrowserContext; gen: number }> {
    if (context) return { ctx: context, gen: generation };
    if (launching) return launching;
    launching = (async () => {
      const b = await chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
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
      // A render may have acquired a slot (and cleared this very timer)
      // in between it being scheduled and firing, if this callback was
      // already queued on the event loop. Guard against closing a browser
      // that a render is actively using.
      if (active > 0) return;
      void idleClose();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  async function teardown(): Promise<void> {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    // If a launch is in progress, wait for it before deciding what to
    // close. Otherwise a teardown that races ahead of `ensure()` would
    // return while context/browser are still null, and the browser that
    // finishes launching a moment later would never get closed - it
    // would just sit there, invisible to isRunning(), leaking the
    // process this was supposed to end.
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

  /** Idle-triggered close: non-terminal, a later render() may relaunch. */
  async function idleClose(): Promise<void> {
    await teardown();
  }

  /** Public, terminal shutdown: no render() may relaunch after this. */
  async function shutdown(): Promise<void> {
    closed = true;
    await teardown();
  }

  async function doRender(url: string, timeout: number, onPage: (p: Page) => void): Promise<RenderResult> {
    let gen: number;
    let page: Page;
    try {
      const acquired = await ensure();
      gen = acquired.gen;
      page = await acquired.ctx.newPage();
      onPage(page);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HarvestError('network', `Не удалось запустить браузер: ${msg}`);
    }
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      // A short best-effort wait for network activity to settle. Capped
      // well below `timeout` regardless of the caller's budget, so it
      // can't itself eat into the headroom the outer deadline relies on.
      await page.waitForLoadState('networkidle', { timeout: Math.min(1000, timeout) }).catch(() => {});
      await page.waitForTimeout(300);

      // Retry page.content() if it fails with navigation race condition.
      const html = await retryPageContent(() => page.content());
      if (Buffer.byteLength(html, 'utf8') > maxBytes) {
        throw new HarvestError('too_large', `Отрендеренная страница превысила ${maxBytes} байт: ${url}`);
      }
      return { html, finalUrl: page.url(), status: response?.status() ?? 0 };
    } catch (e) {
      // A too_large thrown just above is already the right HarvestError —
      // rethrow it as-is instead of falling into the message-sniffing below,
      // which would otherwise misclassify it as 'network' (its message
      // matches neither the timeout nor any special case) and hide the real
      // reason from the caller.
      if (HarvestError.is(e)) throw e;
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

    // Checked at the top of every loop iteration: once before ever
    // waiting (a render arriving after shutdown must not start), and
    // again every time a waiter is woken (a render that was queued
    // behind the maxConcurrent gate when shutdown() landed must not
    // proceed to ensure() and relaunch a browser the pool is trying to
    // retire).
    for (;;) {
      if (closed) throw new HarvestError('network', CLOSED_MESSAGE);
      if (active < maxConcurrent) break;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    // This render now owns a slot and is about to touch the browser -
    // cancel any pending idle shutdown so it can't close the browser out
    // from under this navigation.
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      active--;
      // Wake exactly one waiter; it re-checks the cap (and `closed`) itself.
      waiting.shift()?.();
    };

    // The concurrency slot is released only when the real work (`workPromise`)
    // settles, not when the caller's promise settles below. Otherwise a
    // render that times out via the deadline race would free its slot
    // immediately while its browser page keeps running in the background,
    // and maxConcurrent would no longer bound the number of live pages.
    let capturedPage: Page | null = null;
    const workPromise = doRender(url, timeout, (p) => {
      capturedPage = p;
    });
    workPromise.then(release, release);

    // page.goto()'s own `timeout` option only bounds navigation. It does
    // not bound ensure()/newPage(), and it cannot save us if the context
    // is closed out from under an in-flight operation by a concurrent
    // shutdown() - Playwright can then leave that operation's promise
    // permanently unresolved instead of rejecting it. A hard deadline
    // around the whole pipeline is the only way to guarantee render()
    // always settles within roughly timeoutMs, whatever the browser does
    // internally. Some headroom over the inner budget (goto's own timeout,
    // plus the capped networkidle wait and settle delay) avoids discarding
    // a page that was about to succeed just inside that inner budget.
    let deadline: NodeJS.Timeout | undefined;
    const deadlinePromise = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        // Try to force the stuck operation to unwind quickly (and its
        // page to close) rather than leaving it running unbounded in the
        // background - this is the case the deadline exists for.
        void capturedPage?.close().catch(() => {});
        reject(new HarvestError('timeout', `Браузер не дождался ${url} за ${timeout} мс`));
      }, timeout + 1500);
      deadline.unref?.();
    });

    try {
      return await Promise.race([workPromise, deadlinePromise]);
    } finally {
      clearTimeout(deadline);
    }
  }

  return { render, shutdown, isRunning: () => context !== null };
}
