import { describe, it, expect, vi } from 'vitest';
import { DomainQueue } from '../../src/core/politeness.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DomainQueue', () => {
  it('возвращает результат функции', async () => {
    const q = new DomainQueue({ minIntervalMs: 0 });
    await expect(q.run('a.com', async () => 42)).resolves.toBe(42);
  });

  it('пробрасывает ошибку и не залипает после неё', async () => {
    const q = new DomainQueue({ maxConcurrent: 1, minIntervalMs: 0 });
    await expect(q.run('a.com', async () => { throw new Error('bang'); })).rejects.toThrow('bang');
    await expect(q.run('a.com', async () => 'ok')).resolves.toBe('ok');
  });

  it('не запускает больше maxConcurrent на домен одновременно', async () => {
    const q = new DomainQueue({ maxConcurrent: 2, minIntervalMs: 0 });
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++; peak = Math.max(peak, running);
      await sleep(20);
      running--;
    };
    await Promise.all(Array.from({ length: 6 }, () => q.run('a.com', task)));
    expect(peak).toBe(2);
  });

  it('считает домены независимо', async () => {
    const q = new DomainQueue({ maxConcurrent: 1, minIntervalMs: 0 });
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++; peak = Math.max(peak, running);
      await sleep(20);
      running--;
    };
    await Promise.all([q.run('a.com', task), q.run('b.com', task)]);
    expect(peak).toBe(2);
  });

  it('выдерживает минимальный интервал между запусками на домене', async () => {
    const q = new DomainQueue({ maxConcurrent: 1, minIntervalMs: 100 });
    const starts: number[] = [];
    const task = async () => { starts.push(Date.now()); };
    await Promise.all([q.run('a.com', task), q.run('a.com', task)]);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(90);
  });
});
