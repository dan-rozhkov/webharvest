import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Настоящий Playwright подменяется целиком: проверяем оркестрацию
// launchBrowser (канал, фолбэк, persistent-режим, закрытие браузера при
// сбое newContext), а не сам запуск Chromium.
const fakeContext = () => ({
  addInitScript: vi.fn(async () => {}),
  browser: vi.fn(() => ({})),
  close: vi.fn(async () => {}),
});
const fakeBrowser = () => ({
  newContext: vi.fn(async () => fakeContext()),
  close: vi.fn(async () => {}),
});

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => fakeBrowser()),
    launchPersistentContext: vi.fn(async () => fakeContext()),
  },
}));

const { chromium } = await import('playwright');
const { launchBrowser } = await import('../../src/core/browser-launch.js');

const tmpProfiles: string[] = [];
function tmpProfile(): string {
  const d = mkdtempSync(join(tmpdir(), 'webharvest-launch-'));
  tmpProfiles.push(d);
  return d;
}
afterEach(() => {
  vi.clearAllMocks();
  for (const d of tmpProfiles.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('launchBrowser', () => {
  it('channel по умолчанию — bundled chromium, без channel-опции', async () => {
    await launchBrowser({ headless: true });
    // objectContaining({ channel: undefined }) НЕ матчится против объекта
    // без ключа channel (undefined-свойство требует наличия ключа) — поэтому
    // проверяем отсутствие ключа явно.
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chromium.launch).mock.calls[0]![0]).not.toHaveProperty('channel');
  });
  it('channel chrome — передаёт channel: "chrome" в launch', async () => {
    await launchBrowser({ headless: true, channel: 'chrome' });
    expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ channel: 'chrome' }));
  });
  it('фолбэк на bundled chromium, если Chrome не установлен', async () => {
    vi.mocked(chromium.launch).mockRejectedValueOnce(new Error("Executable doesn't exist"));
    const r = await launchBrowser({ headless: true, channel: 'chrome' });
    expect(chromium.launch).toHaveBeenCalledTimes(2);
    expect(r.usedChannel).toBe('chromium');
  });
  it('profileDir → launchPersistentContext с этим путём', async () => {
    const dir = tmpProfile();
    const r = await launchBrowser({ headless: true, profileDir: dir });
    expect(chromium.launchPersistentContext).toHaveBeenCalledWith(dir, expect.objectContaining({ headless: true }));
    expect(r.persistent).toBe(true);
    expect(chromium.launch).not.toHaveBeenCalled();
  });
  it('persistent-режим тоже применяет stealth (addInitScript)', async () => {
    const dir = tmpProfile();
    await launchBrowser({ headless: true, profileDir: dir });
    const ctx = (await vi.mocked(chromium.launchPersistentContext).mock.results[0]!.value) as {
      addInitScript: ReturnType<typeof vi.fn>;
    };
    expect(ctx.addInitScript).toHaveBeenCalledTimes(1);
  });
  it('при сбое newContext закрывает уже запущенный браузер', async () => {
    const closeBrowser = vi.fn(async () => {});
    const failing = { newContext: vi.fn(async () => { throw new Error('newContext failed'); }), close: closeBrowser };
    vi.mocked(chromium.launch).mockImplementationOnce(async () => failing as never);
    await expect(launchBrowser({ headless: true })).rejects.toThrow('newContext failed');
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });
  it('persistent-режим: сбой applyStealth закрывает контекст (не оставляет осиротевший Chromium)', async () => {
    // Regression для Important-замечания ревью: launchPersistentContext уже
    // поднял процесс Chromium, addInitScript упал — контекст обязан быть
    // закрыт, иначе процесс с заблокированным userDataDir (SingletonLock)
    // живёт до смерти демона, а фолбэк того же профиля маскирует ошибку.
    const closeContext = vi.fn(async () => {});
    const failingCtx = {
      addInitScript: vi.fn(async () => { throw new Error('addInitScript failed'); }),
      browser: vi.fn(() => ({})),
      close: closeContext,
    };
    vi.mocked(chromium.launchPersistentContext).mockImplementationOnce(async () => failingCtx as never);
    const dir = tmpProfile();
    await expect(launchBrowser({ headless: true, profileDir: dir })).rejects.toThrow('addInitScript failed');
    expect(closeContext).toHaveBeenCalledTimes(1);
  });
  it('передаёт stealth-аргументы в launch', async () => {
    await launchBrowser({ headless: true });
    expect(vi.mocked(chromium.launch).mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
      }),
    );
  });
});
