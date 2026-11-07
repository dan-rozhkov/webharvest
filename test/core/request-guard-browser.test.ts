import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { BLOCKED_HEADER } from '../../src/core/egress-proxy.js';
import type { AddressInfo } from 'node:net';
import { createBrowserPool, type BrowserPool } from '../../src/core/browser.js';
import { createSessionPool, type SessionPool } from '../../src/core/session-pool.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLightpandaPool } from '../../src/core/lightpanda.js';
import { HarvestError } from '../../src/core/errors.js';

// Настоящий Chromium. «Страница» живёт на одном loopback-порту (он явно
// разрешён через guard.allowHosts), «секрет» — на другом loopback-порту.
// Враждебная страница пытается всеми каналами прочитать секрет и записать
// его в DOM; гард обязан оборвать каждый запрос до сервера секрета.

const SECRET = 'TOP-SECRET-INTERNAL-VALUE';
let secretServer: Server;
let pageServer: Server;
let secretPort: number;
let pagePort: number;
const secretHits: string[] = [];

function listen(s: Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
}

beforeAll(async () => {
  secretServer = createServer((req, res) => {
    secretHits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end(SECRET);
  });
  secretServer.on('upgrade', (req, socket) => {
    secretHits.push(`upgrade ${req.url}`);
    socket.destroy();
  });
  secretPort = await listen(secretServer);

  pageServer = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${secretPort}/nav` });
      res.end();
      return;
    }
    if (url === '/redirect-https') {
      res.writeHead(302, { location: `https://127.0.0.1:${secretPort}/nav-https` });
      res.end();
      return;
    }
    if (url === '/hop') {
      // Публичный хост (здесь — разрешённый origin) редиректит подресурс на приватную цель.
      res.writeHead(302, { location: `http://127.0.0.1:${secretPort}/subredirect`, 'access-control-allow-origin': '*' });
      res.end();
      return;
    }
    if (url === '/marker' || url === '/marker403') {
      // Источник сам шлёт маркер прокси: на HTTP его вычищает прокси.
      res.writeHead(url === '/marker' ? 200 : 403, { 'content-type': 'text/html', [BLOCKED_HEADER]: '1' });
      res.end('<html><body>origin page</body></html>');
      return;
    }
    if (url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`self.addEventListener('fetch', () => {}); fetch('http://127.0.0.1:${secretPort}/sw').catch(() => {});`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><p id="own">own page text</p><div id="out"></div>
<script>
const out = document.getElementById('out');
const S = 'http://127.0.0.1:${secretPort}';
const log = (m) => { out.append(m + ' | '); };
fetch(S + '/fetch').then((r) => r.text()).then((t) => log('fetch:' + t), (e) => log('fetch-blocked'));
const x = new XMLHttpRequest();
x.open('GET', S + '/xhr');
x.onload = () => log('xhr:' + x.responseText);
x.onerror = () => log('xhr-blocked');
x.send();
fetch('http://169.254.169.254/latest/meta-data').then((r) => r.text()).then((t) => log('meta:' + t), () => log('meta-blocked'));
fetch('/hop').then((r) => r.text()).then((t) => log('hop:' + t), () => log('hop-blocked'));
const img = new Image(); img.src = S + '/img'; document.body.append(img);
const f = document.createElement('iframe'); f.src = S + '/iframe'; document.body.append(f);
const sc = document.createElement('script'); sc.src = S + '/script.js'; document.body.append(sc);
try { const ws = new WebSocket('ws://127.0.0.1:${secretPort}/ws'); ws.onmessage = (m) => log('ws:' + m.data); } catch (e) {}
if (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').then(() => log('sw-registered'), () => log('sw-blocked'));
</script></body></html>`);
  });
  pagePort = await listen(pageServer);
});

afterAll(async () => {
  secretServer.close();
  pageServer.close();
});

const guard = () => ({ allowHosts: [`127.0.0.1:${pagePort}`] });
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SSRF-гард подресурсов: настоящий Chromium', () => {
  let pool: BrowserPool | undefined;
  afterAll(async () => {
    await pool?.shutdown();
  });

  it('страница не может прочитать приватные адреса и записать ответ в DOM', async () => {
    secretHits.length = 0;
    pool = createBrowserPool({ idleTimeoutMs: 60_000, guard: guard() });
    const r = await pool.render(`http://127.0.0.1:${pagePort}/`, { timeoutMs: 20_000 });
    await settle(500); // запоздавшие запросы (iframe/ws/sw) не должны дойти до секрета
    expect(r.html).toContain('own page text'); // origin страницы разрешён
    expect(r.html).not.toContain(SECRET);
    expect(r.html).toContain('fetch-blocked');
    expect(r.html).toContain('xhr-blocked');
    expect(r.html).toContain('meta-blocked');
    expect(r.html).toContain('hop-blocked'); // редирект подресурса на приватный адрес
    expect(r.html).toContain('sw-registered'); // service worker НЕ заблокирован (иначе виден странице)
    expect(secretHits).toEqual([]); // ни один запрос не дошёл до сервера секрета
  });

  it('fetch из service worker к приватному адресу тоже режет прокси', async () => {
    secretHits.length = 0;
    const p = createBrowserPool({ idleTimeoutMs: 60_000, guard: guard() });
    try {
      const r = await p.render(`http://127.0.0.1:${pagePort}/`, { timeoutMs: 20_000 });
      await settle(1500); // SW установился и выполнил свой fetch на старте
      expect(r.html).toContain('sw-registered');
      expect(secretHits.filter((h) => h === '/sw')).toEqual([]);
    } finally {
      await p.shutdown();
    }
  });

  it('источник, приславший маркер-заголовок, не превращается в invalid_url', async () => {
    const p = createBrowserPool({ idleTimeoutMs: 60_000, guard: guard() });
    try {
      const ok = await p.render(`http://127.0.0.1:${pagePort}/marker`, { timeoutMs: 20_000 });
      expect(ok.status).toBe(200);
      expect(ok.html).toContain('origin page');
      const forbidden = await p.render(`http://127.0.0.1:${pagePort}/marker403`, { timeoutMs: 20_000 });
      expect(forbidden.status).toBe(403);
    } finally {
      await p.shutdown();
    }
  });

  it('plain http: нерезолвящееся имя и мёртвый порт — ошибка network, а не «успешный» рендер 502', async () => {
    const dead = createServer();
    const deadPort = await listen(dead);
    await new Promise((r) => dead.close(r));
    const p = createBrowserPool({
      idleTimeoutMs: 60_000,
      guard: {
        allowHosts: [`127.0.0.1:${deadPort}`],
        resolve: async () => {
          throw new Error('ENOTFOUND');
        },
      },
    });
    try {
      for (const target of ['http://nxdomain.test/', `http://127.0.0.1:${deadPort}/`]) {
        const err = await p.render(target, { timeoutMs: 20_000 }).catch((e) => e);
        expect(HarvestError.is(err), target).toBe(true);
        expect((err as HarvestError).code, target).toBe('network');
      }
    } finally {
      await p.shutdown();
    }
  });

  it('редирект на https-адрес приватной сети: invalid_url, цель не достигнута', async () => {
    secretHits.length = 0;
    const p = createBrowserPool({ idleTimeoutMs: 60_000, guard: guard() });
    try {
      const err = await p.render(`http://127.0.0.1:${pagePort}/redirect-https`, { timeoutMs: 20_000 }).catch((e) => e);
      expect((err as HarvestError).code).toBe('invalid_url');
      expect(secretHits).toEqual([]);
    } finally {
      await p.shutdown();
    }
  });

  it('параллельные страницы: блок одной навигации не делает чужой обычный сбой invalid_url', async () => {
    secretHits.length = 0;
    // «Мёртвый» разрешённый порт: https туда даёт сбой туннеля (502 прокси),
    // но это сетевая ошибка, а не отказ политики.
    const dead = createServer();
    const deadPort = await listen(dead);
    await new Promise((r) => dead.close(r));
    const p = createBrowserPool({
      idleTimeoutMs: 60_000,
      maxConcurrent: 3,
      guard: { allowHosts: [`127.0.0.1:${pagePort}`, `127.0.0.1:${deadPort}`] },
    });
    try {
      const results = await Promise.all([
        p.render(`http://127.0.0.1:${pagePort}/redirect`, { timeoutMs: 20_000 }).catch((e) => e),
        p.render(`https://127.0.0.1:${deadPort}/`, { timeoutMs: 20_000 }).catch((e) => e),
        p.render(`http://127.0.0.1:${pagePort}/redirect`, { timeoutMs: 20_000 }).catch((e) => e),
        p.render(`https://127.0.0.1:${deadPort}/`, { timeoutMs: 20_000 }).catch((e) => e),
      ]);
      expect(results.map((e) => (e as HarvestError).code)).toEqual(['invalid_url', 'network', 'invalid_url', 'network']);
      expect(secretHits).toEqual([]);
    } finally {
      await p.shutdown();
    }
  });

  it('навигация на приватный адрес (редирект с разрешённой страницы) даёт invalid_url', async () => {
    secretHits.length = 0;
    const p = createBrowserPool({ idleTimeoutMs: 60_000, guard: guard() });
    try {
      const err = await p.render(`http://127.0.0.1:${pagePort}/redirect`, { timeoutMs: 20_000 }).catch((e) => e);
      expect(HarvestError.is(err)).toBe(true);
      expect((err as HarvestError).code).toBe('invalid_url');
      expect(secretHits).toEqual([]);
    } finally {
      await p.shutdown();
    }
  });

  it('без allowHosts и allowPrivate сама loopback-страница закрыта (по умолчанию гард строгий)', async () => {
    const p = createBrowserPool({ idleTimeoutMs: 60_000 });
    try {
      const err = await p.render(`http://127.0.0.1:${pagePort}/`, { timeoutMs: 20_000 }).catch((e) => e);
      expect((err as HarvestError).code).toBe('invalid_url');
    } finally {
      await p.shutdown();
    }
  });

  it('пул сессий browser use защищён тем же гардом', async () => {
    secretHits.length = 0;
    const sp: SessionPool = createSessionPool({ guard: guard() });
    try {
      const s = await sp.open(`http://127.0.0.1:${pagePort}/`);
      await settle(500);
      const html = await s.page.content();
      expect(html).not.toContain(SECRET);
      expect(html).toContain('fetch-blocked');
      expect(secretHits).toEqual([]);
      sp.release(s.id);
    } finally {
      await sp.shutdown();
    }
  });
});

// Lightpanda: весь HTTP-трафик процесса идёт через egress-proxy (--http-proxy);
// context.route не используется. Бинарь опционален.
const LIGHTPANDA = process.env.WEBHARVEST_LIGHTPANDA_BIN ?? join(homedir(), '.local/bin/lightpanda');
describe.skipIf(!existsSync(LIGHTPANDA))('SSRF-гард подресурсов: Lightpanda', () => {
  it('не отдаёт страницу секрет ни прямым запросом, ни через редирект', async () => {
    secretHits.length = 0;
    const pool = createLightpandaPool({ bin: LIGHTPANDA, idleTimeoutMs: 60_000, guard: guard() });
    try {
      const r = await pool.render(`http://127.0.0.1:${pagePort}/`, { timeoutMs: 20_000 });
      await settle(500);
      expect(r.html).toContain('own page text');
      expect(r.html).not.toContain(SECRET);
      expect(secretHits).toEqual([]);
      const err = await pool.render(`http://127.0.0.1:${pagePort}/redirect`, { timeoutMs: 20_000 }).catch((e) => e);
      expect(HarvestError.is(err) && err.code).toBe('invalid_url');
      expect(secretHits).toEqual([]);
    } finally {
      await pool.shutdown();
    }
  });

  it('plain http: нерезолвящееся имя и мёртвый порт — network', async () => {
    const dead = createServer();
    const deadPort = await listen(dead);
    await new Promise((r) => dead.close(r));
    const pool = createLightpandaPool({
      bin: LIGHTPANDA,
      idleTimeoutMs: 60_000,
      guard: {
        allowHosts: [`127.0.0.1:${deadPort}`],
        resolve: async () => {
          throw new Error('ENOTFOUND');
        },
      },
    });
    try {
      for (const target of ['http://nxdomain.test/', `http://127.0.0.1:${deadPort}/`]) {
        const err = await pool.render(target, { timeoutMs: 20_000 }).catch((e) => e);
        expect(HarvestError.is(err), target).toBe(true);
        expect((err as HarvestError).code, target).toBe('network');
      }
    } finally {
      await pool.shutdown();
    }
  });

  it('редирект на https-адрес приватной сети: цель недостижима; известный mislabel — код network или invalid_url', async () => {
    // Хоп внутри процесса Lightpanda: события request о нём может не быть,
    // тогда отказ прокси нельзя приписать этой навигации без риска
    // перепутать с чужой (прокси один на процесс). Безопасность не страдает.
    secretHits.length = 0;
    const pool = createLightpandaPool({ bin: LIGHTPANDA, idleTimeoutMs: 60_000, guard: guard() });
    try {
      const err = await pool.render(`http://127.0.0.1:${pagePort}/redirect-https`, { timeoutMs: 20_000 }).catch((e) => e);
      expect(HarvestError.is(err)).toBe(true);
      expect(['network', 'invalid_url']).toContain((err as HarvestError).code);
      expect(secretHits).toEqual([]);
    } finally {
      await pool.shutdown();
    }
  });
});
