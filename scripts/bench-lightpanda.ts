/**
 * Сравнение движков рендера для scrape: bundled Chromium (как в демоне, со
 * stealth) против Lightpanda (CDP через connectOverCDP). Каждую страницу из
 * списка открываем обоими движками, извлекаем текст тем же extract(), что и
 * демон, и меряем время, полноту текста и RSS процессов браузера.
 *
 * Запуск (после `npm run build` — бенч импортирует dist):
 *   LIGHTPANDA_BIN=/path/to/lightpanda npx tsx scripts/bench-lightpanda.ts \
 *     [--urls scripts/bench-lightpanda-urls.txt] [--concurrency 1] [--json out.json]
 *
 * Страница у Lightpanda считается «прошедшей», если нет ошибки, статус < 400 и
 * извлечённый текст не короче 70% от текста Chromium (или ≥ 500 символов,
 * если у Chromium тоже мало — например, оба получили стену антибота).
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { extract } from '../dist/core/extractor.js';
import { applyStealth, STEALTH_ARGS, STEALTH_UA } from '../dist/core/stealth.js';

const argv = process.argv.slice(2);
const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const URLS_FILE = arg('--urls') ?? join(import.meta.dirname, 'bench-lightpanda-urls.txt');
const CONCURRENCY = Number(arg('--concurrency') ?? 1) || 1;
const JSON_OUT = arg('--json');
const TIMEOUT_MS = 30_000;
const SETTLE_MS = 500;
const LP_BIN = process.env.LIGHTPANDA_BIN ?? 'lightpanda';
const LP_PORT = 9333;

type Engine = 'chromium' | 'lightpanda';

interface PageResult {
  url: string;
  ok: boolean;
  ms: number;
  status: number;
  textLength: number;
  htmlBytes: number;
  error?: string;
}

interface EngineRun {
  engine: Engine;
  wallMs: number;
  startupMs: number;
  peakRssMb: number;
  pages: PageResult[];
}

const urls = readFileSync(URLS_FILE, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

/** Суммарный RSS (МБ) всех потомков этого процесса — и Chromium, и Lightpanda запускаются отсюда. */
function descendantsRssMb(): number {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  const rows = out
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const [pid, ppid, kb] of rows) {
    rss.set(pid, kb);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  let total = 0;
  const stack = [...(children.get(process.pid) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total / 1024;
}

function startRssSampler() {
  let peak = 0;
  const tick = () => {
    try {
      peak = Math.max(peak, descendantsRssMb());
    } catch {}
  };
  tick();
  const timer = setInterval(tick, 200);
  return () => {
    clearInterval(timer);
    tick();
    return peak;
  };
}

async function waitForPort(port: number, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Lightpanda не поднял CDP на :${port} за ${deadlineMs} мс`);
}

/**
 * Возвращает по контексту на каждого воркера. Chromium — один браузер и общий
 * контекст, как пул рендера демона. Lightpanda держит одну страницу на
 * CDP-подключение (вторая даёт `Target.createTarget: TargetAlreadyLoaded`),
 * поэтому для параллельности открываем отдельное подключение на воркера.
 */
async function launch(engine: Engine, workers: number): Promise<{ contexts: BrowserContext[]; close: () => Promise<void> }> {
  if (engine === 'chromium') {
    const browser = await chromium.launch({ headless: true, args: STEALTH_ARGS });
    const context = await browser.newContext({ userAgent: STEALTH_UA, viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    await applyStealth(context);
    return { contexts: Array(workers).fill(context), close: () => browser.close() };
  }
  const proc = spawn(LP_BIN, ['serve', '--host', '127.0.0.1', '--port', String(LP_PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  try {
    await waitForPort(LP_PORT, 10_000);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(`${(e as Error).message}\n${stderr}`);
  }
  const browsers: Browser[] = [];
  for (let i = 0; i < workers; i++) browsers.push(await chromium.connectOverCDP(`http://127.0.0.1:${LP_PORT}`));
  // stealth-скрипт рассчитан на отпечаток Chrome и здесь не применяется —
  // меряем Lightpanda «как есть».
  const contexts = await Promise.all(browsers.map(async (b) => b.contexts()[0] ?? (await b.newContext())));
  return {
    contexts,
    close: async () => {
      await Promise.all(browsers.map((b) => b.close().catch(() => {})));
      proc.kill('SIGTERM');
    },
  };
}

async function renderOne(context: BrowserContext, url: string): Promise<PageResult> {
  const t0 = performance.now();
  let page: Page | undefined;
  try {
    page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'load', timeout: TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    const html = await page.content();
    const ex = extract(html, page.url());
    const status = response?.status() ?? 0;
    return {
      url,
      ok: status > 0 && status < 400,
      ms: Math.round(performance.now() - t0),
      status,
      textLength: ex.textLength,
      htmlBytes: Buffer.byteLength(html, 'utf8'),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { url, ok: false, ms: Math.round(performance.now() - t0), status: 0, textLength: 0, htmlBytes: 0, error: msg.slice(0, 200) };
  } finally {
    await page?.close().catch(() => {});
  }
}

async function runEngine(engine: Engine): Promise<EngineRun> {
  const stopSampler = startRssSampler();
  const tStart = performance.now();
  const { contexts, close } = await launch(engine, CONCURRENCY);
  const startupMs = Math.round(performance.now() - tStart);
  const pages: PageResult[] = new Array(urls.length);
  let next = 0;
  const worker = async (context: BrowserContext) => {
    while (next < urls.length) {
      const i = next++;
      pages[i] = await renderOne(context, urls[i]);
      const p = pages[i];
      console.log(`  [${engine}] ${p.ok ? 'ok ' : 'ERR'} ${String(p.ms).padStart(6)}ms ${String(p.textLength).padStart(7)}ch  ${p.url}${p.error ? `  — ${p.error}` : ''}`);
    }
  };
  await Promise.all(contexts.map(worker));
  const wallMs = Math.round(performance.now() - tStart);
  await close().catch(() => {});
  const peakRssMb = Math.round(stopSampler());
  return { engine, wallMs, startupMs, peakRssMb, pages };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function lpPasses(lp: PageResult, cr: PageResult): boolean {
  if (!lp.ok) return false;
  if (cr.textLength < 500) return lp.textLength >= Math.min(500, cr.textLength);
  return lp.textLength >= 0.7 * cr.textLength;
}

async function main() {
  console.log(`URL: ${urls.length}, concurrency: ${CONCURRENCY}, lightpanda: ${LP_BIN}`);
  // Lightpanda первым: если сайт кэширует ответы на своей стороне, выгоду от
  // прогрева получит Chromium — то есть замер, если и смещён, то не в пользу Lightpanda.
  const lp = await runEngine('lightpanda');
  const cr = await runEngine('chromium');

  const rows = urls.map((url, i) => ({ url, cr: cr.pages[i], lp: lp.pages[i], pass: lpPasses(lp.pages[i], cr.pages[i]) }));
  const crOk = rows.filter((r) => r.cr.ok);
  const both = rows.filter((r) => r.cr.ok && r.pass);
  const passOfCrOk = crOk.filter((r) => r.pass).length;

  console.log('\n=== Сводка ===');
  for (const run of [cr, lp]) {
    const ok = run.pages.filter((p) => p.ok);
    console.log(
      `${run.engine.padEnd(10)} wall ${(run.wallMs / 1000).toFixed(1)}s  startup ${run.startupMs}ms  ` +
        `peak RSS ${run.peakRssMb} MB  ok ${ok.length}/${urls.length}  median page ${median(ok.map((p) => p.ms))}ms`,
    );
  }
  console.log(`\nLightpanda прошёл ${passOfCrOk}/${crOk.length} страниц, которые открыл Chromium (${Math.round((100 * passOfCrOk) / Math.max(1, crOk.length))}%).`);
  if (both.length) {
    const crMs = median(both.map((r) => r.cr.ms));
    const lpMs = median(both.map((r) => r.lp.ms));
    console.log(`На общих страницах (${both.length}): median Chromium ${crMs}ms vs Lightpanda ${lpMs}ms (x${(crMs / Math.max(1, lpMs)).toFixed(1)}).`);
  }
  const fails = rows.filter((r) => r.cr.ok && !r.pass);
  if (fails.length) {
    console.log('\nПровалы Lightpanda (Chromium справился):');
    for (const r of fails) {
      console.log(`  ${r.url}\n    cr ${r.cr.textLength}ch / lp ${r.lp.textLength}ch status ${r.lp.status}${r.lp.error ? ` — ${r.lp.error}` : ''}`);
    }
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ urls: urls.length, concurrency: CONCURRENCY, runs: [cr, lp], rows }, null, 2));
    console.log(`\nJSON: ${JSON_OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
