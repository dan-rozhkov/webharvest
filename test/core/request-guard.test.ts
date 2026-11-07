import { describe, it, expect, vi } from 'vitest';
import { createRequestGuard } from '../../src/core/request-guard.js';

const PUBLIC = '93.184.216.34';

function guardWith(map: Record<string, string[] | Error>, extra: Parameters<typeof createRequestGuard>[0] = {}) {
  const resolve = vi.fn(async (host: string) => {
    const r = map[host];
    if (!r) throw new Error('ENOTFOUND');
    if (r instanceof Error) throw r;
    return r;
  });
  return { resolve, guard: createRequestGuard({ resolve, ...extra }) };
}

// Решение по URL: прокси получает уже host:port, поэтому тесты разбирают URL так же.
const decide = (g: ReturnType<typeof createRequestGuard>, url: string) => {
  const u = new URL(url);
  return g.decideHost(u.hostname, Number(u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80)));
};

describe('request guard: decide', () => {
  it.each([
    'http://127.0.0.1:8080/x',
    'http://169.254.169.254/latest/meta-data',
    'http://10.1.2.3/',
    'http://192.168.0.1/',
    'http://172.16.0.1/',
    'http://0.0.0.0/',
    'http://[::1]:3000/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    // нормализуются парсером URL в 127.0.0.1
    'http://2130706433/',
    'http://0x7f.1/',
    'ws://127.0.0.1:9222/devtools',
    'wss://[::1]/',
  ])('блокирует IP-литерал %s', async (url) => {
    const { guard, resolve } = guardWith({});
    expect((await decide(guard, url)).allow).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('пропускает публичные IP-литералы без DNS', async () => {
    const { guard, resolve } = guardWith({});
    expect((await decide(guard, `https://${PUBLIC}/`)).allow).toBe(true);
    expect((await decide(guard, 'http://[2606:4700:4700::1111]/')).allow).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('блокирует localhost и локальные суффиксы без DNS, даже если резолвер ответил публично', async () => {
    const { guard, resolve } = guardWith({ 'a.localhost': [PUBLIC], 'localhost': [PUBLIC], 'nas.local': [PUBLIC], 'x.internal': [PUBLIC] });
    for (const u of ['http://localhost/', 'http://localhost./', 'http://a.localhost/', 'http://nas.local/', 'http://x.internal/']) {
      expect((await decide(guard, u)).allow, u).toBe(false);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('хост, резолвящийся в приватный адрес, блокируется; публичный — нет', async () => {
    const { guard } = guardWith({ 'evil.test': ['127.0.0.1'], 'good.test': [PUBLIC] });
    const bad = await decide(guard, 'https://evil.test/x');
    expect(bad).toEqual({ allow: false, kind: 'denied', reason: expect.stringContaining('127.0.0.1') });
    expect((await decide(guard, 'https://good.test/x')).allow).toBe(true);
  });

  it('достаточно одного приватного адреса из нескольких', async () => {
    const { guard } = guardWith({ 'mixed.test': [PUBLIC, '10.0.0.5'] });
    expect((await decide(guard, 'http://mixed.test/')).allow).toBe(false);
  });

  it('сбой DNS и пустой ответ — закрытый отказ', async () => {
    const { guard } = guardWith({ 'broken.test': new Error('SERVFAIL'), 'empty.test': [] });
    expect((await decide(guard, 'http://broken.test/')).allow).toBe(false);
    expect((await decide(guard, 'http://empty.test/')).allow).toBe(false);
    expect((await decide(guard, 'http://unknown.test/')).allow).toBe(false);
  });

  it('кэш: повторный запрос того же хоста не резолвит заново, после TTL — резолвит', async () => {
    let t = 1_000;
    const { guard, resolve } = guardWith({ 'good.test': [PUBLIC] }, { now: () => t });
    await decide(guard, 'https://good.test/a');
    await decide(guard, 'https://good.test/b');
    expect(resolve).toHaveBeenCalledTimes(1);
    t += 29_000;
    await decide(guard, 'https://good.test/c');
    expect(resolve).toHaveBeenCalledTimes(1);
    t += 2_000;
    await decide(guard, 'https://good.test/d');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('кэш: параллельные запросы одного хоста делят один lookup', async () => {
    const { guard, resolve } = guardWith({ 'good.test': [PUBLIC] });
    await Promise.all(Array.from({ length: 10 }, (_, i) => decide(guard, `https://good.test/${i}`)));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('кэш: отказ живёт короче (5 с), чем разрешение, и тоже истекает', async () => {
    let t = 0;
    const answers = [['10.0.0.1'], [PUBLIC]];
    const resolve = vi.fn(async () => answers.shift()!);
    const guard = createRequestGuard({ resolve, now: () => t });
    expect((await decide(guard, 'http://flip.test/')).allow).toBe(false);
    t += 4_000;
    expect((await decide(guard, 'http://flip.test/')).allow).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    t += 2_000;
    expect((await decide(guard, 'http://flip.test/')).allow).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('allowPrivate (только тесты) пропускает loopback', async () => {
    const { guard } = guardWith({}, { allowPrivate: true });
    expect((await decide(guard, 'http://127.0.0.1:1/')).allow).toBe(true);
  });

  it('allowHosts пропускает только свой host:port, соседний порт и метаданные закрыты', async () => {
    const { guard } = guardWith({}, { allowHosts: ['127.0.0.1:4321'] });
    expect((await decide(guard, 'http://127.0.0.1:4321/page')).allow).toBe(true);
    expect((await decide(guard, 'http://127.0.0.1:4322/page')).allow).toBe(false);
    expect((await decide(guard, 'http://169.254.169.254/')).allow).toBe(false);
  });
});

describe('request guard: decideHost (для прокси)', () => {
  it('отдаёт проверенные адреса для pinning', async () => {
    const { guard } = guardWith({ 'good.test': [PUBLIC, '2606:4700:4700::1111'] });
    expect(await guard.decideHost('good.test', 443)).toEqual({ allow: true, addresses: [PUBLIC, '2606:4700:4700::1111'] });
    expect(await guard.decideHost('10.0.0.1', 80)).toEqual({ allow: false, kind: 'denied', reason: expect.any(String) });
    expect(await guard.decideHost('93.184.216.34', 80)).toEqual({ allow: true, addresses: ['93.184.216.34'] });
  });

  it('канонизирует хост до проверки: неканонический loopback и mapped-формы запрещены', async () => {
    const { guard, resolve } = guardWith({});
    for (const h of ['0:0:0:0:0:0:0:1', '::0001', '[::1]', '::ffff:7f00:1', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '0x7f.1', 'LOCALHOST.']) {
      const v = await guard.decideHost(h, 80);
      expect(v.allow, h).toBe(false);
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('request guard: сбой DNS — не блокировка', () => {
  it('lookup упал или пуст → unresolvable, а не denied', async () => {
    const { guard } = guardWith({ 'broken.test': new Error('SERVFAIL'), 'empty.test': [] });
    expect(await guard.decideHost('broken.test', 80)).toEqual({ allow: false, kind: 'unresolvable', reason: expect.any(String) });
    expect(await guard.decideHost('empty.test', 80)).toEqual({ allow: false, kind: 'unresolvable', reason: expect.any(String) });
    expect(await guard.decideHost('10.0.0.1', 80)).toMatchObject({ kind: 'denied' });
  });

  it('таймаут lookup → unresolvable', async () => {
    const guard = createRequestGuard({ resolve: () => new Promise(() => {}), resolveTimeoutMs: 20 });
    expect(await guard.decideHost('slow.test', 80)).toMatchObject({ allow: false, kind: 'unresolvable' });
  });

  it('сбой DNS кэшируется не дольше 1 с', async () => {
    let t = 0;
    const answers: (string[] | Error)[] = [new Error('SERVFAIL'), ['93.184.216.34']];
    const resolve = vi.fn(async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    });
    const guard = createRequestGuard({ resolve, now: () => t });
    expect((await guard.decideHost('flaky.test', 80)).allow).toBe(false);
    t += 500;
    expect((await guard.decideHost('flaky.test', 80)).allow).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    t += 600;
    expect((await guard.decideHost('flaky.test', 80)).allow).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
