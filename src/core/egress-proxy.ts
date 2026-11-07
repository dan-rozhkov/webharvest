import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import { pipeline } from 'node:stream';
import type { Page, Response } from 'playwright';
import { canonicalHost } from './url.js';
import type { RequestGuard } from './request-guard.js';

/**
 * Локальный фильтрующий прокси для браузера (127.0.0.1, случайный порт) —
 * ЕДИНСТВЕННАЯ точка принуждения SSRF-политики (request-guard.ts).
 *
 * Весь трафик браузера идёт через него: навигация, подресурсы, каждый хоп
 * редиректа, WebSocket (через CONNECT), service worker. Прокси резолвит имя
 * сам и соединяется только с проверенным IP (pinning) — повторного резолва
 * нет, DNS rebinding закрыт. Страница ничего не замечает: JS-окружение
 * браузера не меняется (никаких подмен WebSocket/ServiceWorker).
 *
 * - HTTPS/WSS: CONNECT-туннель БЕЗ вскрытия TLS — отпечаток TLS родной.
 * - HTTP: пересылка на проверенные адреса; редиректы прокси не следует.
 * - Запрет: 403 (+ маркер x-webharvest-blocked на HTTP) и запись host:port
 *   в журнал отказов; по нему пулы отличают блок от обычного сбоя.
 * - Сбой DNS/соединения — НЕ блокировка: 502/504 с маркером
 *   x-webharvest-proxy-error и без записи в журнал; навигационный хелпер
 *   (guarded-goto.ts) превращает его в ошибку 'network', а не «страницу».
 * - Таймаут простоя действует только на установку (lookup/connect/ожидание
 *   ответа источника). Установленный туннель и идущий ответ не режутся:
 *   WebSocket, SSE и long-poll живут сколько нужно, конец трафика закрывают
 *   сами стороны.
 *
 * Браузер обязан запускаться с proxyArgs: без `<-loopback>` Chromium вообще
 * не отправляет запросы к loopback/link-local через прокси.
 */
export const BLOCKED_HEADER = 'x-webharvest-blocked';
/** Маркер собственных отказов прокси НЕ из-за политики (DNS, недостижим, таймаут
 *  установки): без него «502-страницу» прокси не отличить от ответа сайта.
 *  Из ответов источника вычищается, как и BLOCKED_HEADER. */
export const PROXY_ERROR_HEADER = 'x-webharvest-proxy-error';

export interface EgressProxy {
  /** `http://127.0.0.1:<port>` для --proxy-server. */
  url: string;
  /** Отказывал ли прокси в соединении с одним из host:port не раньше `since`. */
  wasDenied(authorities: Iterable<string>, since: number): boolean;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  /** Потолок установки туннеля / ожидания ответа источника, мс. По умолчанию 60 с. */
  setupTimeoutMs?: number;
  /** Сколько записей держит журнал отказов (по умолчанию 4096) и как долго, мс (5 мин). */
  deniedMax?: number;
  deniedWindowMs?: number;
  now?: () => number;
}

export const proxyArgs = (proxyUrl: string): string[] => [
  `--proxy-server=${proxyUrl}`,
  // Убирает неявный обход прокси для localhost/127.0.0.0/8/::1/169.254.0.0/16.
  '--proxy-bypass-list=<-loopback>',
];

/** Канонический "host:port" для журнала отказов (как его пишет прокси). */
export function authorityOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const port = u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : u.protocol === 'http:' || u.protocol === 'ws:' ? '80' : '');
    return port ? `${canonicalHost(u.hostname)}:${port}` : null;
  } catch {
    return null;
  }
}

/**
 * Блокировала ли прокси ЭТУ навигацию. Маркерному заголовку верим только на
 * http:, где прокси сам вычищает его из ответов источника; на https прокси
 * не видит заголовков, там заголовок может прислать любой сайт — поэтому
 * для всех схем решает журнал отказов по host:port (цепочка редиректов
 * этой навигации + её итоговый ответ), а не глобальный счётчик.
 */
export function navigationWasBlocked(
  proxy: EgressProxy | null,
  chain: Iterable<string>,
  since: number,
  response?: Response | null,
): boolean {
  if (!proxy) return false;
  const authorities = new Set(chain);
  if (response) {
    const url = response.url();
    if (url.startsWith('http:') && response.headers()[BLOCKED_HEADER]) return true;
    const a = authorityOf(url);
    if (a) authorities.add(a);
  }
  return proxy.wasDenied(authorities, since);
}

/** Собирает host:port всех основных навигационных запросов страницы, в том
 *  числе хопов редиректа (каждый хоп — отдельное событие 'request'). */
export function trackNavigationChain(page: Page, firstUrl: string): { chain: Set<string>; dispose(): void } {
  const chain = new Set<string>();
  const first = authorityOf(firstUrl);
  if (first) chain.add(first);
  const onRequest = (r: import('playwright').Request): void => {
    try {
      if (!r.isNavigationRequest() || r.frame() !== page.mainFrame()) return;
      const a = authorityOf(r.url());
      if (a) chain.add(a);
    } catch {
      // запрос без фрейма (worker) — не навигация
    }
  };
  page.on('request', onRequest);
  return { chain, dispose: () => page.off('request', onRequest) };
}

const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'];
const CONNECT_TIMEOUT_MS = 10_000;
const DENIED_MAX = 4096;
const DENIED_WINDOW_MS = 5 * 60_000;
const SETUP_TIMEOUT_MS = 60_000;

const FORBIDDEN = `HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
const bad = (line: string): string =>
  `HTTP/1.1 ${line}\r\n${PROXY_ERROR_HEADER}: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
const BAD_GATEWAY = bad('502 Bad Gateway');
const GATEWAY_TIMEOUT = bad('504 Gateway Timeout');

/** Соединение с первым достижимым из проверенных адресов; `gone()` — клиент
 *  уже ушёл, дальше пробовать нечего. */
function connectAny(addresses: string[], port: number, gone: () => boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = (): void => {
      const address = addresses[i++];
      if (address === undefined || gone()) return reject(new Error('нет достижимого адреса'));
      const s = connect({ host: address, port, timeout: CONNECT_TIMEOUT_MS });
      s.once('connect', () => {
        s.setTimeout(0);
        s.removeAllListeners('error');
        s.removeAllListeners('timeout');
        resolve(s);
      });
      s.once('timeout', () => s.destroy(new Error('timeout')));
      s.once('error', () => {
        s.destroy();
        next();
      });
    };
    next();
  });
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = authority.match(/:(\d+)$/);
  if (!m) return null;
  const port = Number(m[1]);
  if (!(port > 0 && port < 65536)) return null;
  const hostPart = authority.slice(0, -m[0].length);
  if (!hostPart) return null;
  try {
    // URL нормализует числовые формы IPv4 и IPv6; хост со скобками для v6.
    const host = canonicalHost(new URL(`http://${hostPart}`).hostname);
    return host ? { host, port } : null;
  } catch {
    return null;
  }
}

export async function startEgressProxy(guard: RequestGuard, opts: EgressProxyOptions = {}): Promise<EgressProxy> {
  const setupTimeout = opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
  const deniedMax = opts.deniedMax ?? DENIED_MAX;
  const deniedWindow = opts.deniedWindowMs ?? DENIED_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const sockets = new Set<Socket>();
  // Порядок вставки Map = порядок времени (повторный отказ переставляется в
  // конец). Переполнение журнала может только потерять старую запись, т.е.
  // пометить блок как 'network'; пропустить трафик оно не может.
  const denied = new Map<string, number>();
  const server: Server = createServer();

  function recordDenied(host: string, port: number): void {
    const key = `${host}:${port}`;
    const t = now();
    denied.delete(key);
    denied.set(key, t);
    for (const [k, at] of denied) {
      if (denied.size <= deniedMax && t - at <= deniedWindow) break;
      denied.delete(k);
    }
  }

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
  });

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    // Слушатели — ДО первого await: клиент мог уйти, пока шёл lookup.
    let gone = false;
    client.on('close', () => (gone = true));
    // allowHalfOpen: у http.Server FIN клиента даёт только 'end', не 'close'.
    client.on('end', () => (gone = true));
    client.on('error', () => {
      gone = true;
      client.destroy();
    });
    // Только установка: после 200 таймер снят, туннель живёт до конца трафика.
    const setupTimer = setTimeout(() => {
      gone = true;
      client.end(GATEWAY_TIMEOUT);
    }, setupTimeout);
    setupTimer.unref?.();

    void (async () => {
      try {
        const target = parseAuthority(req.url ?? '');
        if (!target) return void client.end(FORBIDDEN);
        const verdict = await guard.decideHost(target.host, target.port).catch(() => null);
        if (gone) return;
        if (!verdict) return void client.end(BAD_GATEWAY);
        if (!verdict.allow) {
          if (verdict.kind === 'denied') {
            recordDenied(target.host, target.port);
            return void client.end(FORBIDDEN);
          }
          return void client.end(BAD_GATEWAY);
        }
        let upstream: Socket;
        try {
          upstream = await connectAny(verdict.addresses, target.port, () => gone);
        } catch {
          if (!gone) client.end(BAD_GATEWAY);
          return;
        }
        if (gone) {
          upstream.destroy();
          return;
        }
        sockets.add(upstream);
        upstream.on('close', () => {
          sockets.delete(upstream);
          client.destroy();
        });
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        client.on('error', () => upstream.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      } finally {
        clearTimeout(setupTimer);
      }
    })();
  });

  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, marker?: string): void => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { ...(marker ? { [marker]: '1' } : {}), connection: 'close', 'content-length': '0' });
      res.end();
    };
    let u: URL;
    try {
      u = new URL(req.url ?? '');
    } catch {
      return reply(400); // не absolute-form: это не прокси-запрос
    }
    if (u.protocol !== 'http:') return reply(400);
    const host = canonicalHost(u.hostname);
    const port = Number(u.port || 80);
    let up: ReturnType<typeof httpRequest> | undefined;
    // Только ожидание ответа источника; пока идёт тело, таймера нет.
    const setupTimer = setTimeout(() => {
      up?.destroy();
      reply(504, PROXY_ERROR_HEADER);
    }, setupTimeout);
    setupTimer.unref?.();
    res.on('close', () => {
      clearTimeout(setupTimer);
      up?.destroy();
    });
    const verdict = await guard.decideHost(host, port).catch(() => null);
    if (res.destroyed || res.writableEnded) return;
    if (!verdict) return reply(502, PROXY_ERROR_HEADER);
    if (!verdict.allow) {
      if (verdict.kind === 'denied') {
        recordDenied(host, port);
        return reply(403, BLOCKED_HEADER);
      }
      return reply(502, PROXY_ERROR_HEADER); // DNS не ответил — сбой сети, не блокировка
    }
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    const addresses = verdict.addresses;
    const reqOpts: RequestOptions & { autoSelectFamily: boolean } = {
      host,
      port,
      method: req.method,
      path: `${u.pathname}${u.search}`,
      headers,
      setHost: false,
      agent: false,
      // Имя повторно не резолвится: net получает только проверенные адреса и
      // пробует их все по очереди (как connectAny для CONNECT).
      autoSelectFamily: true,
      lookup: (_h, o, cb) => {
        const list = addresses.map((address) => ({ address, family: isIP(address) }));
        const first = list[0]!;
        if ((o as { all?: boolean }).all) (cb as (e: null, a: typeof list) => void)(null, list);
        else (cb as (e: null, a: string, f: number) => void)(null, first.address, first.family);
      },
    };
    const upstream = httpRequest(reqOpts);
    up = upstream;
    upstream.on('response', (r) => {
      clearTimeout(setupTimer);
      const out = { ...r.headers };
      delete out.connection;
      // Маркеры — свидетельство самого прокси; из ответа источника убираем.
      delete out[BLOCKED_HEADER];
      delete out[PROXY_ERROR_HEADER];
      res.writeHead(r.statusCode ?? 502, r.statusMessage, out);
      // pipeline: обрыв источника посреди тела сразу рвёт ответ клиенту
      // (а не оставляет его висеть с недокачанным Content-Length).
      pipeline(r, res, () => {});
    });
    upstream.on('error', () => reply(502, PROXY_ERROR_HEADER));
    req.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    wasDenied(authorities, since) {
      for (const a of authorities) {
        const at = denied.get(a);
        if (at !== undefined && at >= since) return true;
      }
      return false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }),
  };
}
