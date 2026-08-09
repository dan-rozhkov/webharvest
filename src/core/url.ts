import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique local
  if (isLinkLocalV6(s)) return true; // fe80::/10
  const mappedDotted = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted?.[1]) return isPrivateV4(mappedDotted[1]);
  const mappedV4 = ipv4MappedToV4(s);
  if (mappedV4) return isPrivateV4(mappedV4);
  return false;
}

// Проверяет принадлежность блоку fe80::/10 (первые 10 бит: 1111111010),
// а не только буквальному префиксу "fe80" — второй hex-блок должен быть в
// диапазоне 0x80-0xbf.
function isLinkLocalV6(s: string): boolean {
  const match = s.match(/^fe([89ab][0-9a-f])(?::|$)/);
  if (!match?.[1]) return false;
  const secondByte = parseInt(match[1], 16);
  return secondByte >= 0x80 && secondByte <= 0xbf;
}

// Раскрывает "::"-сокращение до полного списка hex-групп и, если адрес —
// IPv4-mapped (::ffff:0:0/96, канонически сериализуется как ::ffff:xxxx:xxxx),
// возвращает эквивалентный IPv4-адрес в точечно-десятичной записи.
function ipv4MappedToV4(s: string): string | null {
  const groups = expandV6Groups(s);
  if (!groups) return null;
  if (groups.slice(0, 5).some((g) => g !== '0') || groups[5] !== 'ffff') return null;
  const high = parseInt(groups[6] ?? '0', 16);
  const low = parseInt(groups[7] ?? '0', 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function expandV6Groups(s: string): string[] | null {
  if ((s.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = s.split('::');
  const headParts = head ? head.split(':').filter((p) => p !== '') : [];
  const tailParts = tail ? tail.split(':').filter((p) => p !== '') : [];
  if (!s.includes('::')) {
    const parts = s.split(':');
    return parts.length === 8 ? parts : null;
  }
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  return [...headParts, ...Array(missing).fill('0'), ...tailParts];
}

// Убирает завершающую точку в FQDN ("localhost." -> "localhost"), иначе она
// обходит проверку строгого равенства и суффиксов.
function stripTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
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
  const host = stripTrailingDot(u.hostname.toLowerCase().replace(/^\[|\]$/g, ''));
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new HarvestError('invalid_url', `Локальные адреса запрещены: ${u.hostname}`);
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new HarvestError('invalid_url', `Приватный адрес запрещён: ${u.hostname}`);
  }
  return u;
}

// NOTE (honest limitation, not fixed here): this is check-then-use, not a
// closed gate. It resolves `hostname` and validates the addresses it gets
// back right now, but the actual request happens later and resolves again,
// independently, inside undici and inside Playwright's own network stack -
// neither of which is told to reuse this lookup or pin to these addresses.
// A short-TTL DNS record that answers with a public address here and a
// private one by the time undici/Playwright resolve it (classic DNS
// rebinding) walks straight past this guard. Properly closing that gap
// needs pinned-IP dispatch (resolve once, force undici's and Playwright's
// connections onto that exact address, and validate the connecting socket's
// remote address before any bytes are read) - real engineering, out of
// scope for a personal tool. Do not read the code below as if it closes
// this gap; it only shrinks the window and raises the bar from "always
// works" to "wins a very fast DNS race".
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = stripTrailingDot(hostname.toLowerCase().replace(/^\[|\]$/g, ''));
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
}
