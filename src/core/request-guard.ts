import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { canonicalHost, isBlockedHostname, isPrivateAddress } from './url.js';

/**
 * Политика SSRF для запросов, которые делает САМА страница внутри браузера
 * (fetch/XHR, img/script/iframe, редиректы, WebSocket, service worker). Это
 * только решение «можно ли соединяться с host:port и с каким IP»; исполняет
 * его egress-proxy.ts — единственная точка принуждения: весь трафик браузера
 * (Chromium и Lightpanda) идёт через него. Ни context.route, ни
 * routeWebSocket, ни serviceWorkers:'block' не используются: Playwright
 * подменяет ради них JS-объекты страницы (WebSocket, ServiceWorkerContainer),
 * и это видно антиботам, а route не видит хопы редиректа.
 *
 * Прокси резолвит имя САМ и соединяется с проверенным IP (pinning), поэтому
 * DNS rebinding между проверкой и соединением закрыт: Chromium при
 * --proxy-server не резолвит имена целей вовсе.
 */

export interface RequestGuardOptions {
  /** ТОЛЬКО для тестов: разрешает приватные адреса. Из config.json не читается
   *  (см. FILE_IGNORED_KEYS в daemon/config.ts). */
  allowPrivate?: boolean;
  /** ТОЛЬКО для тестов: точечные исключения вида "127.0.0.1:4321" — origin
   *  фикстуры разрешён, а любой другой приватный адрес остаётся закрытым. */
  allowHosts?: string[];
  /** Подмена DNS-резолвера (тесты). По умолчанию dns.lookup(all). */
  resolve?: (host: string) => Promise<string[]>;
  now?: () => number;
  /** Потолок одного резолва, мс. Таймаут — «не разрешилось», а не «запрещено». */
  resolveTimeoutMs?: number;
}

/** denied — адрес запрещён политикой; unresolvable — DNS не ответил или
 *  ответ пуст: это сетевой сбой, а не блокировка (прокси отвечает 502, без
 *  маркера и без записи об отказе). `addresses` — проверенные IP для pinning. */
export type GuardVerdict =
  | { allow: true; addresses: string[] }
  | { allow: false; kind: 'denied' | 'unresolvable'; reason: string };

export interface RequestGuard {
  /** Решение для пары host:port (CONNECT и абсолютные http-запросы в прокси). */
  decideHost(host: string, port: number): Promise<GuardVerdict>;
}

/** Положительный вердикт живёт 30 с, запрет — 5 с, сбой DNS — только 1 с:
 *  подресурсы одного хоста идут пачкой, но временный сбой не должен залипать. */
const ALLOW_TTL_MS = 30_000;
const DENY_TTL_MS = 5_000;
const UNRESOLVABLE_TTL_MS = 1_000;
const RESOLVE_TIMEOUT_MS = 5_000;
const CACHE_MAX = 512;

const defaultResolve = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((a) => a.address);

type Resolved = { addresses: string[] } | { error: string };

export function createRequestGuard(opts: RequestGuardOptions = {}): RequestGuard {
  const now = opts.now ?? Date.now;
  const resolve = opts.resolve ?? defaultResolve;
  const resolveTimeoutMs = opts.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS;
  const allowHosts = new Set((opts.allowHosts ?? []).map((h) => h.toLowerCase()));
  const cache = new Map<string, { until: number; result: Promise<Resolved> }>();

  function resolveHost(host: string): Promise<Resolved> {
    const hit = cache.get(host);
    if (hit && hit.until > now()) return hit.result;
    const result = (async (): Promise<Resolved> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const addresses = await Promise.race([
          resolve(host),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), resolveTimeoutMs);
          }),
        ]);
        return addresses.length === 0 ? { error: `имя ${host} не резолвится` } : { addresses };
      } catch {
        return { error: `не удалось разрешить имя ${host}` };
      } finally {
        clearTimeout(timer);
      }
    })();
    if (cache.size >= CACHE_MAX) cache.clear();
    // TTL считаем от момента, когда ответ известен, а не когда запрошен:
    // медленный lookup не должен съедать собственный TTL.
    const entry = { until: now() + UNRESOLVABLE_TTL_MS, result };
    cache.set(host, entry);
    void result.then((r) => {
      const ttl =
        'error' in r ? UNRESOLVABLE_TTL_MS : r.addresses.some((a) => isPrivateAddress(a)) ? DENY_TTL_MS : ALLOW_TTL_MS;
      entry.until = now() + ttl;
    });
    return result;
  }

  async function checkHost(host: string, override: boolean): Promise<GuardVerdict> {
    if (!override && isBlockedHostname(host)) {
      return { allow: false, kind: 'denied', reason: `локальное имя ${host}` };
    }
    if (isIP(host)) {
      return override || !isPrivateAddress(host)
        ? { allow: true, addresses: [host] }
        : { allow: false, kind: 'denied', reason: `приватный адрес ${host}` };
    }
    const r = await resolveHost(host);
    if ('error' in r) return { allow: false, kind: 'unresolvable', reason: r.error };
    const bad = r.addresses.find((a) => isPrivateAddress(a));
    if (bad && !override) {
      return { allow: false, kind: 'denied', reason: `${host} резолвится в приватный адрес ${bad}` };
    }
    return { allow: true, addresses: r.addresses };
  }

  async function decideHost(rawHost: string, port: number): Promise<GuardVerdict> {
    const host = canonicalHost(rawHost);
    if (!host) return { allow: false, kind: 'denied', reason: 'пустой хост' };
    const override = opts.allowPrivate === true || allowHosts.has(`${host}:${port}`) || allowHosts.has(host);
    return checkHost(host, override);
  }

  return { decideHost };
}
