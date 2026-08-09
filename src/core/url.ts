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
  if (s.startsWith('fe80')) return true;                      // link-local
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  return false;
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
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new HarvestError('invalid_url', `Локальные адреса запрещены: ${u.hostname}`);
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new HarvestError('invalid_url', `Приватный адрес запрещён: ${u.hostname}`);
  }
  return u;
}

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
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
