import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttp, request, type Server } from 'node:http';
import { createServer as createTcp, connect, type AddressInfo, type Server as TcpServer } from 'node:net';
import { startEgressProxy, BLOCKED_HEADER, PROXY_ERROR_HEADER, proxyArgs, type EgressProxy } from '../../src/core/egress-proxy.js';
import { createRequestGuard } from '../../src/core/request-guard.js';

let web: Server;
let echo: TcpServer;
let webPort: number;
let echoPort: number;
let proxy: EgressProxy;
let proxyPort: number;
const resolved: string[] = [];
let echoConns = 0;
let deadPort = 0;

beforeAll(async () => {
  const dead = createTcp();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  deadPort = (dead.address() as AddressInfo).port;
  await new Promise((r) => dead.close(r));
  web = createHttp((req, res) => {
    if (req.url === '/truncate') {
      // Content-Length 100, отдано 7 байт, затем сброс соединения.
      res.writeHead(200, { 'content-length': '100', 'content-type': 'text/plain' });
      res.write('partial');
      setTimeout(() => req.socket.destroy(), 30);
      return;
    }
    if (req.url === '/never') return; // источник не отвечает вовсе
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/' });
      return void res.end();
    }
    if (req.url === '/marker') {
      // Источник пытается выдать свой ответ за отказ прокси.
      res.writeHead(200, { [BLOCKED_HEADER]: '1', [PROXY_ERROR_HEADER]: '1' });
      return void res.end('origin');
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-seen-host': String(req.headers.host) });
    res.end('hello');
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  webPort = (web.address() as AddressInfo).port;
  echo = createTcp((s) => {
    echoConns++;
    s.on('data', (d) => s.write(`echo:${d}`));
    s.on('error', () => {});
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  echoPort = (echo.address() as AddressInfo).port;

  // Фикстуры (loopback) разрешены точечно; 'pinned.test' «резолвится» в
  // loopback только через подменённый резолвер — настоящего DNS-имени нет.
  const guard = createRequestGuard({
    allowHosts: [
      `127.0.0.1:${webPort}`,
      `127.0.0.1:${echoPort}`,
      `pinned.test:${webPort}`,
      `twoaddr.test:${webPort}`,
      `slow.test:${echoPort}`,
      `slowabort.test:${echoPort}`,
      `twoaddr.test:${echoPort}`,
      `127.0.0.1:${deadPort}`,
    ],
    resolve: async (host) => {
      resolved.push(host);
      if (host === 'pinned.test') return ['127.0.0.1'];
      // Первый адрес недостижим (на ::1 никто не слушает) — нужен второй.
      if (host === 'twoaddr.test') return ['::1', '127.0.0.1'];
      if (host === 'slow.test' || host === 'slowabort.test') {
        await new Promise((r) => setTimeout(r, 300));
        return ['127.0.0.1'];
      }
      throw new Error('ENOTFOUND');
    },
  });
  proxy = await startEgressProxy(guard);
  proxyPort = Number(new URL(proxy.url).port);
});

afterAll(async () => {
  await proxy.close();
  web.close();
  echo.close();
});

function viaProxy(target: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path: target, headers: { host: new URL(target).host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectVia(authority: string): Promise<{ status: number; socket: import('node:net').Socket; rest: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(proxyPort, '127.0.0.1');
    s.once('error', reject);
    s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    s.once('data', (d) => {
      const text = d.toString();
      resolve({ status: Number(text.split(' ')[1]), socket: s, rest: text });
    });
  });
}

describe('egress proxy', () => {
  it('аргументы Chromium снимают неявный обход прокси для loopback', () => {
    expect(proxyArgs('http://127.0.0.1:1')).toEqual(['--proxy-server=http://127.0.0.1:1', '--proxy-bypass-list=<-loopback>']);
  });

  it('http: пересылает разрешённый запрос и сохраняет Host', async () => {
    const r = await viaProxy(`http://127.0.0.1:${webPort}/page`);
    expect(r.status).toBe(200);
    expect(r.body).toBe('hello');
    expect(r.headers['x-seen-host']).toBe(`127.0.0.1:${webPort}`);
  });

  it('http: чужой loopback-порт и метаданные облака — 403 с маркером', async () => {
    for (const target of ["http://127.0.0.1:1/", 'http://169.254.169.254/latest/meta-data', 'http://[::1]:9/']) {
      const r = await viaProxy(target);
      expect(r.status, target).toBe(403);
      expect(r.headers[BLOCKED_HEADER], target).toBe('1');
    }
  });

  it('http: редирект не следуется — отдаётся браузеру как есть', async () => {
    const r = await viaProxy(`http://127.0.0.1:${webPort}/redirect`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('http://127.0.0.1:1/');
  });

  it('pinning: соединяется с адресом из резолвера гарда, имя повторно не резолвится', async () => {
    resolved.length = 0;
    const r = await viaProxy(`http://pinned.test:${webPort}/`);
    expect(r.status).toBe(200);
    expect(resolved).toEqual(['pinned.test']);
  });

  it('CONNECT: разрешённый хост туннелируется, байты идут в обе стороны', async () => {
    const { status, socket } = await connectVia(`127.0.0.1:${echoPort}`);
    expect(status).toBe(200);
    const answer = await new Promise<string>((resolve) => {
      socket.once('data', (d) => resolve(d.toString()));
      socket.write('ping');
    });
    expect(answer).toBe('echo:ping');
    socket.destroy();
  });

  it('CONNECT: запрещённый адрес и мусор — 403', async () => {
    for (const a of ["127.0.0.1:1", '169.254.169.254:80', '[::1]:443', 'garbage']) {
      const { status, socket } = await connectVia(a);
      expect(status, a).toBe(403);
      socket.destroy();
    }
  });

  it('http: не absolute-form (прямое обращение к прокси) — 400, не проксируется', async () => {
    const r = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxyPort, path: '/' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(r).toBe(400);
  });

  it('http: заголовок-маркер источника вычищается, ответ не выглядит отказом прокси', async () => {
    const r = await viaProxy(`http://127.0.0.1:${webPort}/marker`);
    expect(r.status).toBe(200);
    expect(r.headers[BLOCKED_HEADER]).toBeUndefined();
    expect(r.headers[PROXY_ERROR_HEADER]).toBeUndefined();
    expect(proxy.wasDenied([`127.0.0.1:${webPort}`], 0)).toBe(false);
  });

  it('http: соединяется по всем проверенным адресам, первый недостижим', async () => {
    const r = await viaProxy(`http://twoaddr.test:${webPort}/`);
    expect(r.status).toBe(200);
    expect(r.body).toBe('hello');
  });

  it('CONNECT: тоже перебирает адреса', async () => {
    // twoaddr.test → ['::1', '127.0.0.1']: на ::1 никто не слушает.
    const { status, socket } = await connectVia(`twoaddr.test:${echoPort}`);
    expect(status).toBe(200);
    const answer = await new Promise<string>((resolve) => {
      socket.once('data', (d) => resolve(d.toString()));
      socket.write('hi');
    });
    expect(answer).toBe('echo:hi');
    socket.destroy();
  });

  it('IPv6 канонизируется до проверки: loopback в любой записи — отказ и запись в журнале', async () => {
    const t0 = Date.now();
    for (const a of ['[0:0:0:0:0:0:0:1]:9', '[::0001]:9', '[::ffff:7f00:1]:9', '[::7f00:1]:9', '[64:ff9b::7f00:1]:9', '[2002:7f00:1::]:9', '[ff02::1]:9']) {
      const { status, socket } = await connectVia(a);
      expect(status, a).toBe(403);
      socket.destroy();
    }
    const r = await viaProxy('http://[0:0:0:0:0:0:0:1]:9/');
    expect(r.status).toBe(403);
    expect(proxy.wasDenied(['::1:9'], t0)).toBe(true);
  });

  it('сбой DNS: 502 без маркера и без записи в журнале отказов, и для http, и для CONNECT', async () => {
    const t0 = Date.now();
    const r = await viaProxy('http://nodns.test:80/');
    expect(r.status).toBe(502);
    expect(r.headers[BLOCKED_HEADER]).toBeUndefined();
    expect(r.headers[PROXY_ERROR_HEADER]).toBe('1');
    const { status, socket, rest } = await connectVia('nodns.test:443');
    expect(status).toBe(502);
    expect(rest).not.toContain(BLOCKED_HEADER);
    expect(rest).toContain(PROXY_ERROR_HEADER);
    socket.destroy();
    expect(proxy.wasDenied(['nodns.test:80', 'nodns.test:443'], t0)).toBe(false);
  });

  it('журнал отказов: учитывает только записи не старше since', async () => {
    await viaProxy('http://127.0.0.1:2/');
    const later = Date.now() + 1;
    expect(proxy.wasDenied(['127.0.0.1:2'], 0)).toBe(true);
    expect(proxy.wasDenied(['127.0.0.1:2'], later)).toBe(false);
    expect(proxy.wasDenied(['127.0.0.1:3'], 0)).toBe(false);
  });

  it('CONNECT: клиент ушёл во время медленного lookup — upstream-сокет не открывается', async () => {
    const before = echoConns;
    const s = connect(proxyPort, '127.0.0.1');
    await new Promise<void>((r) => s.once('connect', () => r()));
    s.write(`CONNECT slowabort.test:${echoPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 50));
    s.destroy();
    await new Promise((r) => setTimeout(r, 600)); // lookup (300 мс) завершился
    expect(echoConns).toBe(before);
  });

  it('http: мёртвый порт — 502 с маркером ошибки прокси, без маркера отказа и без записи', async () => {
    const t0 = Date.now();
    const r = await viaProxy(`http://127.0.0.1:${deadPort}/`);
    expect(r.status).toBe(502);
    expect(r.headers[PROXY_ERROR_HEADER]).toBe('1');
    expect(r.headers[BLOCKED_HEADER]).toBeUndefined();
    expect(proxy.wasDenied([`127.0.0.1:${deadPort}`], t0)).toBe(false);
  });

  it('обрыв источника посреди тела рвёт ответ клиенту сразу (Content-Length 100, 7 байт, сброс)', async () => {
    const outcome = await new Promise<{ received: number; broken: boolean }>((resolve) => {
      const started = Date.now();
      const req = request({ host: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${webPort}/truncate`, headers: { host: `127.0.0.1:${webPort}` } }, (res) => {
        let received = 0;
        res.on('data', (d) => (received += d.length));
        const done = (broken: boolean): void => resolve({ received, broken: broken && Date.now() - started < 1500 });
        res.on('aborted', () => done(true));
        res.on('error', () => done(true));
        res.on('close', () => done(!res.complete));
      });
      req.on('error', () => resolve({ received: 0, broken: true }));
      req.end();
    });
    expect(outcome.broken).toBe(true);
    expect(outcome.received).toBeLessThan(100);
  });

  it('keep-alive: 15 запросов по одному соединению не плодят слушателей (нет MaxListenersExceededWarning)', async () => {
    const warnings: string[] = [];
    const onWarn = (w: Error): void => void warnings.push(w.name);
    process.on('warning', onWarn);
    const { Agent } = await import('node:http');
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let i = 0; i < 15; i++) {
        await new Promise<void>((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${webPort}/k${i}`, headers: { host: `127.0.0.1:${webPort}` }, agent }, (res) => {
            res.resume();
            res.on('end', resolve);
          });
          req.on('error', reject);
          req.end();
        });
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(warnings).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarn);
      agent.destroy();
    }
  });

  it('установленный туннель НЕ режется таймаутом установки', async () => {
    const guard = createRequestGuard({ allowHosts: [`127.0.0.1:${echoPort}`] });
    const short = await startEgressProxy(guard, { setupTimeoutMs: 150 });
    try {
      const s = connect(Number(new URL(short.url).port), '127.0.0.1');
      await new Promise<void>((r) => s.once('connect', () => r()));
      s.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
      await new Promise((r) => s.once('data', r));
      await new Promise((r) => setTimeout(r, 500)); // втрое дольше таймаута установки
      expect(s.destroyed).toBe(false);
      const answer = await new Promise<string>((resolve) => {
        s.once('data', (d) => resolve(d.toString()));
        s.write('still-alive');
      });
      expect(answer).toBe('echo:still-alive');
      s.destroy();
    } finally {
      await short.close();
    }
  });

  it('зависшая установка: CONNECT во время медленного lookup и http без ответа источника получают 504 с маркером', async () => {
    const guard = createRequestGuard({
      allowHosts: [`127.0.0.1:${webPort}`, `slowsetup.test:${echoPort}`],
      resolve: async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return ['127.0.0.1'];
      },
    });
    const short = await startEgressProxy(guard, { setupTimeoutMs: 150 });
    const port = Number(new URL(short.url).port);
    try {
      const c = connect(port, '127.0.0.1');
      await new Promise<void>((r) => c.once('connect', () => r()));
      c.write(`CONNECT slowsetup.test:${echoPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
      const text = await new Promise<string>((resolve) => c.once('data', (d) => resolve(d.toString())));
      expect(text).toContain(' 504 ');
      expect(text).toContain(PROXY_ERROR_HEADER);
      c.destroy();
      const r = await new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: `http://127.0.0.1:${webPort}/never`, headers: { host: `127.0.0.1:${webPort}` } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, headers: res.headers });
        });
        req.on('error', reject);
        req.end();
      });
      expect(r.status).toBe(504);
      expect(r.headers[PROXY_ERROR_HEADER]).toBe('1');
    } finally {
      await short.close();
    }
  });

  it('журнал отказов: потолок вытесняет самые старые, повторный отказ освежает запись, окно времени отсекает давние', async () => {
    let t = 1_000;
    const guard = createRequestGuard({});
    const small = await startEgressProxy(guard, { deniedMax: 3, deniedWindowMs: 10_000, now: () => t });
    const port = Number(new URL(small.url).port);
    const deny = async (host: string): Promise<void> => {
      const { socket } = await new Promise<{ socket: import('node:net').Socket }>((resolve, reject) => {
        const s = connect(port, '127.0.0.1');
        s.once('error', reject);
        s.write(`CONNECT ${host}:9 HTTP/1.1\r\nHost: x\r\n\r\n`);
        s.once('data', () => resolve({ socket: s }));
      });
      socket.destroy();
      t += 10;
    };
    try {
      for (const h of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) await deny(h);
      await deny('10.0.0.1'); // освежили самую старую
      await deny('10.0.0.4'); // переполнение: уходит самая старая из оставшихся — 10.0.0.2
      expect(small.wasDenied(['10.0.0.2:9'], 0)).toBe(false);
      expect(small.wasDenied(['10.0.0.1:9', '10.0.0.3:9', '10.0.0.4:9'], 0)).toBe(true);
      expect(small.wasDenied(['10.0.0.3:9'], 0)).toBe(true);
      t += 20_000; // всё устарело, следующий отказ вычищает давние
      await deny('10.0.0.5');
      expect(small.wasDenied(['10.0.0.1:9', '10.0.0.3:9', '10.0.0.4:9'], 0)).toBe(false);
      expect(small.wasDenied(['10.0.0.5:9'], 0)).toBe(true);
    } finally {
      await small.close();
    }
  });
});
