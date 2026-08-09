import { describe, it, expect } from 'vitest';
import { HarvestError } from '../../src/core/errors.js';

describe('HarvestError', () => {
  it('несёт код, сообщение и детали', () => {
    const e = new HarvestError('blocked', 'Заблокировано Cloudflare', { by: 'cloudflare' });
    expect(e.code).toBe('blocked');
    expect(e.message).toBe('Заблокировано Cloudflare');
    expect(e.detail).toEqual({ by: 'cloudflare' });
    expect(e instanceof Error).toBe(true);
  });

  it('сериализуется в плоский объект для HTTP-ответа', () => {
    const e = new HarvestError('timeout', 'Таймаут 10000 мс');
    expect(e.toJSON()).toEqual({ code: 'timeout', message: 'Таймаут 10000 мс', detail: undefined });
  });

  it('распознаётся type guard-ом', () => {
    expect(HarvestError.is(new HarvestError('network', 'x'))).toBe(true);
    expect(HarvestError.is(new Error('x'))).toBe(false);
  });
});
