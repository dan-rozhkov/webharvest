/**
 * Бенчмарк browser use и scrape: поднимает локальный сервер с фикстурами и
 * гоняет сервис демона в этом же процессе (без HTTP-слоя — он не вносит
 * заметной задержки). Запуск (после `npm run build` — бенч импортирует dist: tsx вставляет
 * `__name` в функции, уходящие в page.evaluate): `npx tsx scripts/bench.ts [--runs 5] [--live]
 * [--json out.json]`.
 *
 * Кроме времени проверяет корректность там, где ускорение ожиданий может
 * сломать смысл: диф после клика с отложенным fetch обязан содержать
 * результат, снапшот SPA после open — отрисованный контент.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createService } from '../dist/daemon/service.js';
import { loadConfig } from '../dist/daemon/config.js';

const argv = process.argv.slice(2);
const RUNS = Number(argv[argv.indexOf('--runs') + 1] || 0) || 5;
const LIVE = argv.includes('--live');
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures');
// Внешние ресурсы фикстур (CDN, аналитика) отрезаем CSP — иначе замер шумит
// от сети, а не от нашего кода.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:">`;

const FORM_PAGE = `<!doctype html><html><head><title>Form</title></head><body>
<h1>Checkout</h1>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent='Submitted ' + document.getElementById('name').value">
  <label>Name <input id="name"></label>
  <label>Country <select id="country"><option>Cyprus</option><option>Georgia</option></select></label>
  <button type="submit">Submit</button>
</form>
<button id="local" onclick="document.getElementById('out').textContent='Local change'">Local</button>
<button id="fetch" onclick="fetch('/api/slow').then(r=>r.text()).then(t=>document.getElementById('out').textContent=t)">Load data</button>
<p id="out">Nothing yet</p>
<a href="/form?page=2">Next page</a>
${Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i} filler text for scrolling.</p>`).join('')}
</body></html>`;

// Вечный long-poll + маячки аналитики: networkidle тут не наступает никогда.
const BUSY_PAGE = `<!doctype html><html><head><title>Busy</title></head><body>
<h1>Busy page</h1>
<button onclick="document.getElementById('out').textContent='Clicked busy'">Do it</button>
<p id="out">idle</p>
<script>
  fetch('/api/hang');
  setInterval(() => fetch('/api/ping?' + Math.random()), 250);
</script>
</body></html>`;

// Контент дорисовывается после fetch — как у типичного SPA.
const SPA_PAGE = `<!doctype html><html><head><title>SPA</title></head><body>
<div id="root"></div>
<script>
  fetch('/api/slow').then(r => r.text()).then(() => {
    document.getElementById('root').innerHTML = '<h1>Dashboard ready</h1><button>Refresh</button>';
  });
</script>
</body></html>`;

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (body: string, type = 'text/html; charset=utf-8') => {
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  };
  switch (url.pathname) {
    case '/form':
      return send(FORM_PAGE.replace('<h1>Checkout</h1>', url.searchParams.get('page') ? '<h1>Page two</h1>' : '<h1>Checkout</h1>'));
    case '/busy':
      return send(BUSY_PAGE);
    case '/spa':
      return send(SPA_PAGE);
    case '/api/slow':
      setTimeout(() => send('Loaded data', 'text/plain'), 300);
      return;
    case '/api/hang':
      return; // никогда не отвечаем
    case '/api/ping':
      return send('ok', 'text/plain');
    default: {
      const m = /^\/fx\/([\w-]+)$/.exec(url.pathname);
      if (m) {
        try {
          const html = readFileSync(join(FIXTURES, `${m[1]}.html`), 'utf8');
          return send(html.replace(/<head[^>]*>/i, (h) => h + CSP));
        } catch {
          /* 404 ниже */
        }
      }
      res.writeHead(404);
      res.end('nope');
    }
  }
}

type Sample = { name: string; ms: number[]; bytes?: number[]; ok?: boolean[] };
const samples = new Map<string, Sample>();

function record(name: string, ms: number, extra: { bytes?: number; ok?: boolean } = {}): void {
  let s = samples.get(name);
  if (!s) samples.set(name, (s = { name, ms: [] }));
  s.ms.push(ms);
  if (extra.bytes !== undefined) (s.bytes ??= []).push(extra.bytes);
  if (extra.ok !== undefined) (s.ok ??= []).push(extra.ok);
}

async function timed<T>(name: string, fn: () => Promise<T>, extra?: (r: T) => { bytes?: number; ok?: boolean }): Promise<T> {
  const t = performance.now();
  const r = await fn();
  record(name, performance.now() - t, extra?.(r));
  return r;
}

/** Адрес первой строки outline, в которой встречается text. */
function idOf(outline: string, text: RegExp): string {
  for (const line of outline.split('\n')) {
    if (text.test(line)) {
      const m = /\[(\d+-\d+)\]/.exec(line);
      if (m) return m[1]!;
    }
  }
  throw new Error(`не нашёл ${text} в outline:\n${outline.slice(0, 2000)}`);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
};

async function main(): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const dir = mkdtempSync(join(tmpdir(), 'wh-bench-'));
  const service = createService(
    loadConfig({ allowPrivate: true, cachePath: join(dir, 'cache.db'), searxngUrl: null, browserProfileDir: null }),
  );
  const S = service as Required<typeof service>;

  try {
    // Прогрев: запуск Chromium обоих пулов в замер не входит.
    const warm = await S.browserOpen({ url: `${base}/form` });
    await S.browserClose({ sessionId: warm.sessionId });
    await S.scrape({ url: `${base.replace('127.0.0.1', 'localhost')}/spa`, refresh: true }).catch(() => {});

    for (let run = 0; run < RUNS; run++) {
      // --- форма: основные действия ---
      const open = await timed('open form', () => S.browserOpen({ url: `${base}/form` }), (r) => ({ bytes: r.outline.length }));
      const sid = open.sessionId;
      let outline = open.outline;
      await timed('snapshot form', () => S.browserSnapshot({ sessionId: sid }), (r) => ({ bytes: r.outline.length }));
      await timed('fill', () => S.browserFill({ sessionId: sid, elementId: idOf(outline, /textbox: Name/), text: 'Ann' }));
      outline = (await S.browserSnapshot({ sessionId: sid })).outline;
      await timed('select', () => S.browserSelect({ sessionId: sid, elementId: idOf(outline, /select/), value: 'Georgia' }));
      outline = (await S.browserSnapshot({ sessionId: sid })).outline;
      await timed('click (local DOM change)', () => S.browserClick({ sessionId: sid, elementId: idOf(outline, /button: Local/) }), (r) => ({ ok: /Local change/.test(r.changed) }));
      outline = (await S.browserSnapshot({ sessionId: sid })).outline;
      await timed('click (fetch 300ms → DOM)', () => S.browserClick({ sessionId: sid, elementId: idOf(outline, /button: Load data/) }), (r) => ({ ok: /Loaded data/.test(r.changed) }));
      outline = (await S.browserSnapshot({ sessionId: sid })).outline;
      await timed('press Enter (submit)', () => S.browserPress({ sessionId: sid, elementId: idOf(outline, /textbox: Name/), key: 'Enter' }), (r) => ({ ok: /Submitted Ann/.test(r.changed) }));
      outline = (await S.browserSnapshot({ sessionId: sid })).outline;
      await timed('scroll', () => S.browserScroll({ sessionId: sid, elementId: idOf(outline, /RootWebArea|WebArea|html/), percent: '50%' }).catch(() => ({ changed: '' })));
      outline = (await S.browserSnapshot({ sessionId: sid })).outline;
      await timed('click link (navigation)', () => S.browserClick({ sessionId: sid, elementId: idOf(outline, /link: Next page/) }), (r) => ({ ok: /Page two/.test(r.changed) }));
      await S.browserClose({ sessionId: sid });

      // --- та же форма пачкой: fill + select + submit одним вызовом ---
      if (S.browserAct) {
        const o2 = await S.browserOpen({ url: `${base}/form` });
        await timed('act: fill+select+submit (1 call)', () => S.browserAct({
          sessionId: o2.sessionId,
          actions: [
            { action: 'fill', elementId: idOf(o2.outline, /textbox: Name/), text: 'Bob' },
            { action: 'select', elementId: idOf(o2.outline, /select/), value: 'Georgia' },
            { action: 'press', elementId: idOf(o2.outline, /textbox: Name/), key: 'Enter' },
          ],
        }), (r) => ({ ok: /Submitted Bob/.test(r.changed) }));
        await S.browserClose({ sessionId: o2.sessionId });
      }

      // --- страница, где networkidle не наступает ---
      const busy = await timed('open busy', () => S.browserOpen({ url: `${base}/busy` }));
      await timed('click (busy page)', () => S.browserClick({ sessionId: busy.sessionId, elementId: idOf(busy.outline, /button: Do it/) }), (r) => ({ ok: /Clicked busy/.test(r.changed) }));
      await S.browserClose({ sessionId: busy.sessionId });

      // --- SPA: снапшот после open должен видеть отрисованное ---
      const spa = await timed('open spa', () => S.browserOpen({ url: `${base}/spa` }), (r) => ({ ok: /Dashboard ready/.test(r.outline) }));
      await S.browserClose({ sessionId: spa.sessionId });

      // --- тяжёлые реальные страницы ---
      for (const fx of ['wikipedia-web', 'github-repo']) {
        const o = await timed(`open ${fx}`, () => S.browserOpen({ url: `${base}/fx/${fx}` }), (r) => ({ bytes: r.outline.length }));
        await timed(`snapshot ${fx}`, () => S.browserSnapshot({ sessionId: o.sessionId }));
        await S.browserClose({ sessionId: o.sessionId });
      }

      // --- scrape ---
      for (const fx of ['wikipedia-web', 'mdn-fetch', 'hn-front', 'github-repo']) {
        await timed(`scrape ${fx}`, () => S.scrape({ url: `${base}/fx/${fx}`, refresh: true }), (r) => ({ bytes: r.markdown.length }));
      }
      // localhost, а не 127.0.0.1: DomainHints запомнит эскалацию по хосту, и
      // фикстуры выше пошли бы через браузер в следующих прогонах.
      await timed('scrape spa (browser escalation)', () => S.scrape({ url: `${base.replace('127.0.0.1', 'localhost')}/spa`, refresh: true }), (r) => ({ ok: r.via === 'browser' && /Dashboard ready/.test(r.markdown) }));

      // Три страницы разом — как search с fetchContent (concurrency 3).
      await timed('scrape ×3 concurrent (wiki+github+nodejs)', () =>
        Promise.all(['wikipedia-web', 'github-repo', 'nodejs-blog'].map((fx) => S.scrape({ url: `${base}/fx/${fx}`, refresh: true }))),
      );
      // Клик в браузере, пока демон разбирает тяжёлую страницу: не должен ждать разбор.
      {
        const o = await S.browserOpen({ url: `${base}/form` });
        const bg = S.scrape({ url: `${base}/fx/wikipedia-web`, refresh: true });
        await new Promise((r) => setTimeout(r, 150));
        await timed('click during heavy scrape', () => S.browserClick({ sessionId: o.sessionId, elementId: idOf(o.outline, /button: Local/) }));
        await bg;
        await S.browserClose({ sessionId: o.sessionId });
      }

      if (LIVE) {
        for (const url of ['https://en.wikipedia.org/wiki/Web_scraping', 'https://news.ycombinator.com/']) {
          const o = await timed(`live open ${new URL(url).host}`, () => S.browserOpen({ url }), (r) => ({ bytes: r.outline.length }));
          await S.browserClose({ sessionId: o.sessionId });
          await timed(`live scrape ${new URL(url).host}`, () => S.scrape({ url, refresh: true }));
        }
      }
      process.stderr.write(`run ${run + 1}/${RUNS} done\n`);
    }
  } finally {
    await service.shutdown();
    server.close();
  }

  const rows = [...samples.values()].map((s) => ({
    name: s.name,
    p50: Math.round(median(s.ms)),
    p95: Math.round(p95(s.ms)),
    kb: s.bytes ? +(median(s.bytes) / 1024).toFixed(1) : undefined,
    ok: s.ok ? `${s.ok.filter(Boolean).length}/${s.ok.length}` : undefined,
  }));
  console.log('| step | p50 ms | p95 ms | size KB | correct |\n|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.name} | ${r.p50} | ${r.p95} | ${r.kb ?? ''} | ${r.ok ?? ''} |`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
  process.exit(0);
}

await main();
