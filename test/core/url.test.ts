import { describe, it, expect } from 'vitest';
import { normalizeUrl, assertAllowedUrl, isPrivateAddress } from '../../src/core/url.js';
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
});
