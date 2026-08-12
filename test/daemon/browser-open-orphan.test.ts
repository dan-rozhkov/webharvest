import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarvestError } from '../../src/core/errors.js';

// Мокаем DNS-резолв, чтобы детерминированно смоделировать транзиентный сбой
// резолвера (код 'network' из assertPublicHost) на пост-навигационной
// проверке — тот же приём, что в test/daemon/browser-url-safety.test.ts.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    throw new Error('ENOTFOUND: имя не резолвится (смоделированный сбой резолвера)');
  }),
}));

// createSessionPool подменяется целиком, чтобы не поднимать настоящий
// Chromium: нас интересует только оркестрация в browserOpen() — что сессия
// закрывается при ЛЮБОМ исключении между sessions.open() и возвратом
// sessionId вызывающему, а не только на invalid_url (это уже покрыто
// assertSessionUrlSafePure отдельно). Фейковая сессия "редиректит" на
// хост, требующий DNS-резолва, — именно на этом шаге сработает мок выше.
const closeSpy = vi.fn(async (_id: string) => {});
const openSpy = vi.fn(async (_url: string) => ({
  id: 's_orphan_test',
  page: { url: () => 'http://redirected-host.example/' },
  lastUsedAt: Date.now(),
}));

vi.mock('../../src/core/session-pool.js', () => ({
  createSessionPool: () => ({
    open: openSpy,
    get: vi.fn(),
    close: closeSpy,
    shutdown: vi.fn(async () => {}),
    count: () => 0,
  }),
}));

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'webharvest-home-'));
  process.env.HOME = fakeHome;
  closeSpy.mockClear();
  openSpy.mockClear();
});

describe('Service.browserOpen: сессия не должна остаться без владельца', () => {
  it('закрывает сессию, даже когда пост-навигационная проверка падает с network (не invalid_url)', async () => {
    // Импортируем после vi.mock (hoisted), но динамически — чтобы moкi точно
    // применились до создания сервиса.
    const { createService } = await import('../../src/daemon/service.js');
    const { loadConfig } = await import('../../src/daemon/config.js');

    const svc = createService(
      loadConfig({ cachePath: ':memory:', searxngUrl: null, braveApiKey: null, allowPrivate: false }),
    );

    // Публичный IP-литерал на входе: проходит первичную проверку без
    // обращения к DNS (assertPublicHost для IP-литерала не резолвит).
    const err = await svc.browserOpen!({ url: 'http://93.184.216.34/' }).catch((e) => e);

    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe('network');

    // Раньше эта ошибка улетала наверх, а сессия оставалась висеть — id так
    // и не был отдан вызывающему, закрыть её было некому.
    expect(closeSpy).toHaveBeenCalledWith('s_orphan_test');

    await svc.shutdown();
  });
});
