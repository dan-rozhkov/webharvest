import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Настоящий Playwright подменяется целиком: проверяем оркестрацию
// launchBrowser (канал, фолбэк, persistent-режим, закрытие браузера при
// сбое newContext), а не сам запуск Chromium.
const fakeContext = () => ({
  addInitScript: vi.fn(async () => {}),
  on: vi.fn(),
  browser: vi.fn(() => ({})),
  close: vi.fn(async () => {}),
});
const fakeBrowser = () => ({
  on: vi.fn(),
  newContext: vi.fn(async () => fakeContext()),
  close: vi.fn(async () => {}),
});

// Настоящий прокси не поднимаем: фабрика подменена, close считаем.
const proxyMocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  start: vi.fn(),
}));
vi.mock('../../src/core/egress-proxy.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/core/egress-proxy.js')>()),
  startEgressProxy: proxyMocks.start,
}));
proxyMocks.start.mockImplementation(async () => ({
  url: 'http://127.0.0.1:1',
  wasDenied: () => false,
  close: proxyMocks.close,
}));

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
  it('фолбэк сообщает о себе в лог — деградация канала не беззвучна', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(chromium.launch).mockRejectedValueOnce(new Error("Executable doesn't exist"));
    await launchBrowser({ headless: true, channel: 'chrome' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/chromium/i));
    warn.mockRestore();
  });
  it('НЕ откатывается на chromium, если Chrome упал не из-за отсутствия', async () => {
    // Залоченный userDataDir, краш процесса, сбой стелса — фолбэком не
    // лечатся: повтор в bundled chromium лишь подменит явно выбранный
    // оператором канал и спрячет настоящую причину.
    vi.mocked(chromium.launch).mockRejectedValueOnce(
      new Error('Failed to create a ProcessSingleton for your profile directory'),
    );
    await expect(launchBrowser({ headless: true, channel: 'chrome' })).rejects.toThrow(/ProcessSingleton/);
    expect(chromium.launch).toHaveBeenCalledTimes(1);
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
    const failing = { on: vi.fn(), newContext: vi.fn(async () => { throw new Error('newContext failed'); }), close: closeBrowser };
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
  it('передаёт stealth-аргументы в launch и не меняет их', async () => {
    await launchBrowser({ headless: true });
    const args = vi.mocked(chromium.launch).mock.calls[0]![0]!.args;
    expect(args?.slice(0, 2)).toEqual(['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']);
  });
  it('добавляет WebRTC-аргумент рядом со stealth', async () => {
    await launchBrowser({ headless: true });
    expect(vi.mocked(chromium.launch).mock.calls[0]![0]!.args).toContain(
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    );
    await launchBrowser({ headless: true, profileDir: tmpProfile() });
    expect(vi.mocked(chromium.launchPersistentContext).mock.calls[0]![1]!.args).toContain(
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    );
  });
  it('весь трафик идёт через фильтрующий прокси, loopback из обхода убран', async () => {
    await launchBrowser({ headless: true });
    const args = vi.mocked(chromium.launch).mock.calls[0]![0]!.args!;
    expect(args.some((a) => /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/.test(a))).toBe(true);
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
    await launchBrowser({ headless: true, profileDir: tmpProfile() });
    expect(vi.mocked(chromium.launchPersistentContext).mock.calls[0]![1]!.args).toContain('--proxy-bypass-list=<-loopback>');
  });
  it('не меняет JS-окружение страницы: нет route/routeWebSocket (у фейка их нет — вызов упал бы) и serviceWorkers:block', async () => {
    // Playwright ради них подменяет WebSocket/ServiceWorkerContainer страницы —
    // это видно антиботам. SSRF держит только прокси.
    await launchBrowser({ headless: true });
    const browser = (await vi.mocked(chromium.launch).mock.results[0]!.value) as { newContext: ReturnType<typeof vi.fn> };
    expect(browser.newContext.mock.calls[0]![0]).not.toHaveProperty('serviceWorkers');
    await launchBrowser({ headless: true, profileDir: tmpProfile() });
    expect(vi.mocked(chromium.launchPersistentContext).mock.calls[0]![1]).not.toHaveProperty('serviceWorkers');
  });
  it('прокси закрывается, если запуск не удался (и не запускается реальный)', async () => {
    vi.mocked(chromium.launch).mockRejectedValueOnce(new Error('boom'));
    await expect(launchBrowser({ headless: true })).rejects.toThrow('boom');
    expect(proxyMocks.close).toHaveBeenCalledTimes(1);
  });
  it('прокси закрывается вместе с браузером (disconnected) и контекстом (close)', async () => {
    const r = await launchBrowser({ headless: true });
    const onB = (r.browser as unknown as { on: ReturnType<typeof vi.fn> }).on;
    const cb = onB.mock.calls.find((c) => c[0] === 'disconnected')![1] as () => void;
    cb();
    expect(proxyMocks.close).toHaveBeenCalledTimes(1);
    const p = await launchBrowser({ headless: true, profileDir: tmpProfile() });
    const onC = (p.context as unknown as { on: ReturnType<typeof vi.fn> }).on;
    (onC.mock.calls.find((c) => c[0] === 'close')![1] as () => void)();
    expect(proxyMocks.close).toHaveBeenCalledTimes(2);
  });
});
