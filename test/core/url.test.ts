import { describe, it, expect } from 'vitest';
import { normalizeUrl, assertAllowedUrl, isPrivateAddress, canonicalHost } from '../../src/core/url.js';
import { HarvestError } from '../../src/core/errors.js';

describe('normalizeUrl', () => {
  it('приводит хост к нижнему регистру и убирает фрагмент', () => {
    expect(normalizeUrl('https://Example.COM/a#section')).toBe('https://example.com/a');
  });

  it('убирает порт по умолчанию', () => {
    expect(normalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('убирает трекинговые параметры, сохраняя значимые', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x&id=7&fbclid=z'))
      .toBe('https://example.com/a?id=7');
  });

  it('сортирует параметры, чтобы порядок не плодил записи в кэше', () => {
    expect(normalizeUrl('https://example.com/a?b=2&a=1'))
      .toBe('https://example.com/a?a=1&b=2');
  });

  it('убирает завершающий слэш, кроме корня', () => {
    expect(normalizeUrl('https://example.com/a/')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });
});

describe('assertAllowedUrl', () => {
  it('пропускает обычные http и https', () => {
    expect(assertAllowedUrl('https://example.com/a').hostname).toBe('example.com');
  });

  for (const bad of [
    'file:///etc/passwd',
    'ftp://example.com',
    'javascript:alert(1)',
    'data:text/html,x',
    'http://localhost:3000',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://router.local/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://localhost./',
  ]) {
    it(`отклоняет ${bad}`, () => {
      expect(() => assertAllowedUrl(bad)).toThrow(HarvestError);
      try { assertAllowedUrl(bad); } catch (e) {
        expect((e as HarvestError).code).toBe('invalid_url');
      }
    });
  }
});

describe('isPrivateAddress', () => {
  it('распознаёт приватные диапазоны IPv4', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1', '169.254.1.1', '0.0.0.0'])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34'])
      expect(isPrivateAddress(ip)).toBe(false);
  });

  it('распознаёт приватные диапазоны IPv6', () => {
    for (const ip of ['::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])
      expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('распознаёт IPv4-mapped адреса в канонической hex-форме', () => {
    // new URL('http://[::ffff:127.0.0.1]/').hostname сериализуется как '::ffff:7f00:1'
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe'])
      expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('::ffff:5db8:d834')).toBe(false); // 93.184.216.52, публичный
  });

  it('распознаёт весь блок link-local fe80::/10, а не только буквальный префикс fe80::', () => {
    for (const ip of ['fe80::1', 'fe95::1', 'febf::1'])
      expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('fec0::1')).toBe(true); // site-local fec0::/10 закрыт отдельным диапазоном
  });
});

describe('isPrivateAddress: неканонические и встроенные формы IPv6', () => {
  it.each([
    ['0:0:0:0:0:0:0:1', 'loopback, полная запись'],
    ['::0001', 'loopback с ведущими нулями'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', 'loopback, без сжатия'],
    ['::', 'unspecified'],
    ['::7f00:1', 'IPv4-compatible ::/96 с 127.0.0.1'],
    ['::a00:1', 'IPv4-compatible с 10.0.0.1'],
    ['::ffff:127.0.0.1', 'mapped, точечная запись'],
    ['::ffff:7f00:1', 'mapped, hex'],
    ['0:0:0:0:0:ffff:7f00:1', 'mapped, полная запись'],
    ['0:0:0:0:0:ffff:127.0.0.1', 'mapped, полная запись с точками'],
    ['::ffff:a9fe:a9fe', 'mapped 169.254.169.254'],
    ['64:ff9b::7f00:1', 'NAT64 с 127.0.0.1'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 с метаданными'],
    ['64:ff9b::10.0.0.1', 'NAT64 с 10.0.0.1, точечная запись'],
    ['64:ff9b:1::1', 'NAT64 local-use'],
    ['::ffff:0:7f00:1', 'SIIT ::ffff:0:0:0/96'],
    ['2002:7f00:1::', '6to4 с 127.0.0.1'],
    ['2002:a9fe:a9fe::1', '6to4 с метаданными'],
    ['2002:c0a8:101::1', '6to4 с 192.168.1.1'],
    ['ff02::1', 'multicast'],
    ['ff00::', 'multicast ff00::/8'],
    ['fec0::1', 'site-local'],
    ['feff::1', 'site-local, верх fec0::/10'],
    ['fe80::1%eth0', 'link-local с zone id'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
  ])('%s — приватный (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '64:ff9b::5db8:d834',   // NAT64 с публичным 93.184.216.52
    '2002:5db8:d834::1',    // 6to4 с публичным
    '::ffff:5db8:d834',
    '::ffff:93.184.216.52',
    '2a00:1450:4001::1',
  ])('%s — публичный', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('canonicalHost приводит форму адреса к канонической', () => {
    expect(canonicalHost('[0:0:0:0:0:0:0:1]')).toBe('::1');
    expect(canonicalHost('::0001')).toBe('::1');
    expect(canonicalHost('::ffff:127.0.0.1')).toBe('::ffff:7f00:1');
    expect(canonicalHost('LocalHost.')).toBe('localhost');
    expect(canonicalHost('0x7f.1')).toBe('127.0.0.1');
  });
});
