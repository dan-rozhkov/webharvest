import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { HarvestError } from './errors.js';
import type { BrowserPool, RenderResult } from './browser.js';
import { trackNetwork, waitForNetworkQuiet, LOAD_QUIET_CAP_MS, LOAD_QUIET_MS } from './settle.js';

/**
 * Пул рендера на Lightpanda (headless-браузер без отрисовки, CDP-сервер).
 *
 * Отличия от Chromium-пула (browser.ts), найденные бенчмарком
 * (docs/bench-lightpanda.md):
 * - Lightpanda держит одну страницу на CDP-подключение: вторая newPage() в
 *   том же подключении падает с `TargetAlreadyLoaded`. Поэтому каждый рендер
 *   открывает своё подключение к общему процессу `lightpanda serve`.
 * - Stealth-скрипт рассчитан на отпечаток Chrome и здесь не применяется, а
 *   ожидания Cloudflare нет: челлендж, как и любой отказ, fetcher повторяет
 *   на запасном Chromium-пуле.
 */
export interface LightpandaPoolOptions {
  /** Путь к бинарю lightpanda (или имя в PATH). */
  bin: string;
  idleTimeoutMs?: number;
  maxConcurrent?: number;
  maxBytes?: number;
}

const CLOSED_MESSAGE = 'Пул Lightpanda остановлен, рендер отклонён';
const START_TIMEOUT_MS = 10_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export function createLightpandaPool(opts: LightpandaPoolOptions): BrowserPool {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const maxConcurrent = opts.maxConcurrent ?? 3;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;

  let proc: ChildProcess | null = null;
  let endpoint: string | null = null;
  let launching: Promise<string> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let active = 0;
  let closed = false;
  const waiting: (() => void)[] = [];

  function stopProcess(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    proc?.kill('SIGTERM');
    proc = null;
    endpoint = null;
  }

  async function launch(): Promise<string> {
    const port = await freePort();
    const child = spawn(opts.bin, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    let spawnError: Error | null = null;
    child.once('error', (e) => (spawnError = e));
    child.once('exit', () => {
      // Процесс умер сам (крэш) — следующий рендер поднимет новый.
      if (proc === child) {
        proc = null;
        endpoint = null;
      }
    });

    const url = `http://127.0.0.1:${port}`;
    const until = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < until) {
      if (spawnError || child.exitCode !== null) break;
      try {
        const r = await fetch(`${url}/json/version`);
        if (r.ok) {
          proc = child;
          endpoint = url;
          return url;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill('SIGKILL');
    const reason = spawnError ? (spawnError as Error).message : stderr.trim() || 'CDP-порт не открылся';
    throw new HarvestError('network', `Не удалось запустить Lightpanda (${opts.bin}): ${reason}`);
  }

  async function ensure(): Promise<string> {
    if (endpoint) return endpoint;
    if (!launching) {
      launching = launch().finally(() => {
        launching = null;
      });
    }
    return launching;
  }

  function touchIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (active === 0) stopProcess();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  async function doRender(url: string, timeout: number, onBrowser: (b: Browser) => void): Promise<RenderResult> {
    let browser: Browser;
    let page: Page;
    try {
      browser = await chromium.connectOverCDP(await ensure());
      onBrowser(browser);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      page = await context.newPage();
    } catch (e) {
      if (HarvestError.is(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new HarvestError('network', `Не удалось подключиться к Lightpanda: ${msg}`);
    }
    try {
      const network = trackNetwork(page);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await waitForNetworkQuiet(page, network, {
        sinceGen: 0,
        quietMs: LOAD_QUIET_MS,
        capMs: Math.min(LOAD_QUIET_CAP_MS, timeout),
      });
      const html = await page.content();
      if (Buffer.byteLength(html, 'utf8') > maxBytes) {
        throw new HarvestError('too_large', `Отрендеренная страница превысила ${maxBytes} байт: ${url}`);
      }
      return { html, finalUrl: page.url(), status: response?.status() ?? 0 };
    } catch (e) {
      if (HarvestError.is(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/Timeout|timeout/i.test(msg)) {
        throw new HarvestError('timeout', `Lightpanda не дождался ${url} за ${timeout} мс`);
      }
      throw new HarvestError('network', `Lightpanda не смог открыть ${url}: ${msg}`);
    } finally {
      // Закрытие подключения закрывает и его единственную страницу; процесс
      // lightpanda serve продолжает жить для следующих рендеров.
      await browser.close().catch(() => {});
    }
  }

  async function render(url: string, o: { timeoutMs?: number } = {}): Promise<RenderResult> {
    const timeout = o.timeoutMs ?? 30_000;
    for (;;) {
      if (closed) throw new HarvestError('network', CLOSED_MESSAGE);
      if (active < maxConcurrent) break;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    // Слот освобождается, когда завершилась сама работа, а не гонка с
    // дедлайном — та же причина, что в browser.ts.
    let connected: Browser | null = null;
    const work = doRender(url, timeout, (b) => {
      connected = b;
    });
    work.then(release, release);
    function release(): void {
      active--;
      waiting.shift()?.();
      if (!closed && endpoint) touchIdle();
    }

    let deadline: NodeJS.Timeout | undefined;
    const deadlinePromise = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        void connected?.close().catch(() => {});
        reject(new HarvestError('timeout', `Lightpanda не дождался ${url} за ${timeout} мс`));
      }, timeout + 1500);
      deadline.unref?.();
    });
    try {
      return await Promise.race([work, deadlinePromise]);
    } finally {
      clearTimeout(deadline);
    }
  }

  async function shutdown(): Promise<void> {
    closed = true;
    while (waiting.length) waiting.shift()!();
    if (launching) await launching.catch(() => {});
    stopProcess();
  }

  return { render, shutdown, isRunning: () => proc !== null };
}
