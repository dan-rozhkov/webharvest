import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HarvestError } from './errors.js';

const TRACKING_PARAMS = /^(utm_|ga_|mc_|_hs|yclid$|gclid$|fbclid$|msclkid$|igshid$|ref_src$|si$)/i;
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

export function normalizeUrl(input: string): string {
  const u = new URL(input);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
    u.port = '';
  }
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // не разобрали — считаем небезопасным
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a, b] = [parts[0] ?? 0, parts[1] ?? 0];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;          // link-local и метаданные облаков
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                          // multicast и зарезервированное
  return false;
}

/** Каноническая форма хоста для сравнений и проверок: без скобок IPv6, в нижнем
 *  регистре, без завершающей точки; IPv6 приведён парсером URL к сжатому виду
 *  (0:0:0:0:0:0:0:1 → ::1, ::ffff:127.0.0.1 → ::ffff:7f00:1), числовые формы
 *  IPv4 (0x7f.1) — к точечной. Имя, которое не разбирается, возвращается как есть. */
export function canonicalHost(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return h;
  try {
    return new URL(`http://${h.includes(':') ? `[${h}]` : h}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return h;
  }
}

// Статические недоступные диапазоны IPv6 (адрес уже канонический).
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['::', 96],              // ::/96: unspecified, loopback, IPv4-compatible (::7f00:1)
  ['::ffff:0:0:0', 96],    // SIIT ::ffff:0:0:0/96
  ['64:ff9b:1::', 48],     // NAT64 local-use
  ['100::', 64],           // discard-only
  ['2001::', 32],          // Teredo (внутри обфусцированный v4)
  ['fc00::', 7],           // unique local
  ['fe80::', 10],          // link-local
  ['fec0::', 10],          // site-local (устарел, но маршрутизируется во внутренних сетях)
  ['ff00::', 8],           // multicast
] as const) BLOCKED_V6.addSubnet(net, prefix, 'ipv6');

function v4FromGroups(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateV6(ip: string): boolean {
  if (ip.includes('%')) return true; // zone id бывает только у link-local
  const c = canonicalHost(ip);
  if (isIP(c) !== 6) return true;
  const g = expandV6Groups(c);
  if (!g) return true;
  const n = g.map((x) => parseInt(x, 16));
  if (n.some((x) => Number.isNaN(x))) return true;
  // IPv4-mapped ::ffff:0:0/96 — решает встроенный v4.
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return isPrivateV4(v4FromGroups(n[6]!, n[7]!));
  // NAT64 64:ff9b::/96 — встроенный v4.
  if (n[0] === 0x64 && n[1] === 0xff9b && n.slice(2, 6).every((x) => x === 0)) return isPrivateV4(v4FromGroups(n[6]!, n[7]!));
  // 6to4 2002::/16 — v4 в группах 1 и 2.
  if (n[0] === 0x2002) return isPrivateV4(v4FromGroups(n[1]!, n[2]!));
  return BLOCKED_V6.check(c, 'ipv6');
}

// Раскрывает "::"-сокращение канонического адреса до 8 hex-групп.
function expandV6Groups(s: string): string[] | null {
  if ((s.match(/::/g) ?? []).length > 1) return null;
  if (!s.includes('::')) {
    const parts = s.split(':');
    return parts.length === 8 ? parts : null;
  }
  const [head, tail] = s.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 1) return null;
  return [...headParts, ...Array<string>(missing).fill('0'), ...tailParts];
}

/** Имя, которое запрещено без DNS: localhost и локальные суффиксы. Chromium
 *  сам резолвит *.localhost в loopback, не спрашивая DNS, поэтому такие имена
 *  нельзя пускать даже при «публичном» ответе резолвера. Ждёт уже
 *  нормализованный хост (нижний регистр, без скобок IPv6 и завершающей точки). */
export function isBlockedHostname(host: string): boolean {
  return host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

export function assertAllowedUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new HarvestError('invalid_url', `Не похоже на URL: ${input}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HarvestError('invalid_url', `Поддерживаются только http и https, получено ${u.protocol}`);
  }
  const host = canonicalHost(u.hostname);
  if (isBlockedHostname(host)) {
    throw new HarvestError('invalid_url', `Локальные адреса запрещены: ${u.hostname}`);
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new HarvestError('invalid_url', `Приватный адрес запрещён: ${u.hostname}`);
  }
  return u;
}

// NOTE (honest limitation, partly closed): this is check-then-use for the
// plain HTTP path (undici), which resolves the name again on its own and can
// lose a fast DNS-rebinding race. The BROWSER paths are different: Chromium
// and Lightpanda run behind the local egress proxy (egress-proxy.ts), which
// resolves, checks and connects to the same verified address (pinning), so
// rebinding does not apply to page loads, redirects or in-page requests.
// This function is the early, cheap check on navigation URLs and redirect hops.
/**
 * Короткий кэш ПОЛОЖИТЕЛЬНЫХ вердиктов: browser use проверяет url страницы
 * на входе и после каждого действия, scrape — на каждом редиректе, и всё это
 * обычно один и тот же хост. Окно гонки с DNS rebinding (см. выше) кэш не
 * расширяет по существу — оно и так открыто между этой проверкой и резолвом
 * внутри undici/Playwright; отрицательные вердикты не кэшируются вовсе.
 */
const PUBLIC_HOST_TTL_MS = 30_000;
const PUBLIC_HOST_MAX = 512;
const publicHosts = new Map<string, number>();

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = canonicalHost(hostname);
  const cachedUntil = publicHosts.get(host);
  if (cachedUntil !== undefined && cachedUntil > Date.now()) return;
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new HarvestError('invalid_url', `Приватный адрес запрещён: ${hostname}`);
    }
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new HarvestError('network', `Не удалось разрешить имя ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new HarvestError('invalid_url', `${hostname} резолвится в приватный адрес ${address}`);
    }
  }
  if (publicHosts.size >= PUBLIC_HOST_MAX) publicHosts.clear();
  publicHosts.set(host, Date.now() + PUBLIC_HOST_TTL_MS);
}
