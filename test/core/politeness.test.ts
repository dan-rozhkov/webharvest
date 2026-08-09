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

  it('соблюдает maxConcurrent с nonzero интервалом (Finding 1)', async () => {
    const q = new DomainQueue({ maxConcurrent: 2, minIntervalMs: 100 });
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++; peak = Math.max(peak, running);
      await sleep(200);
      running--;
    };
    await Promise.all(Array.from({ length: 6 }, () => q.run('a.com', task)));
    expect(peak).toBe(2);
  });

  it('не теряет очередь при удалении состояния (Finding 2)', async () => {
    const q = new DomainQueue({ maxConcurrent: 1, minIntervalMs: 100 });
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++; peak = Math.max(peak, running);
      await sleep(20);
      running--;
    };
    const p1 = q.run('a.com', task);
    await sleep(10);
    const p2 = q.run('a.com', task);
    const p3 = q.run('a.com', task);
    await Promise.all([p1, p2, p3]);
    expect(peak).toBe(1);
  });

  it('минимальный интервал соблюдается с несколькими задачами', async () => {
    const q = new DomainQueue({ maxConcurrent: 2, minIntervalMs: 50 });
    const starts: number[] = [];
    const task = async () => { starts.push(Date.now()); await sleep(10); };
    await Promise.all(Array.from({ length: 5 }, () => q.run('a.com', task)));
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(45);
    }
  });
});
