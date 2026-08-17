import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadConfig', () => {
  const originalHome = process.env.HOME;
  const originalPort = process.env.WEBHARVEST_PORT;
  const originalBrowserChannel = process.env.WEBHARVEST_BROWSER_CHANNEL;
  const originalBrowserProfileDir = process.env.WEBHARVEST_BROWSER_PROFILE_DIR;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'webharvest-home-'));
    process.env.HOME = fakeHome;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalPort === undefined) delete process.env.WEBHARVEST_PORT;
    else process.env.WEBHARVEST_PORT = originalPort;
    if (originalBrowserChannel === undefined) delete process.env.WEBHARVEST_BROWSER_CHANNEL;
    else process.env.WEBHARVEST_BROWSER_CHANNEL = originalBrowserChannel;
    if (originalBrowserProfileDir === undefined) delete process.env.WEBHARVEST_BROWSER_PROFILE_DIR;
    else process.env.WEBHARVEST_BROWSER_PROFILE_DIR = originalBrowserProfileDir;
    vi.resetModules();
  });

  it('allowPrivate по умолчанию false, если ничего не задано', async () => {
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(loadConfig().allowPrivate).toBe(false);
  });

  it('config.json на диске не может включить allowPrivate — только явный overrides', async () => {
    mkdirSync(join(fakeHome, '.webharvest'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.webharvest', 'config.json'),
      JSON.stringify({ allowPrivate: true, port: 9999 }),
    );

    const { loadConfig } = await import('../../src/daemon/config.js');
    const cfg = loadConfig();
    // Другие поля из файла проходят как обычно...
    expect(cfg.port).toBe(9999);
    // ...но allowPrivate из файла игнорируется: иначе файл на диске мог бы
    // тихо выключить SSRF-защиту демона.
    expect(cfg.allowPrivate).toBe(false);
  });

  it('явный overrides всё ещё может включить allowPrivate (нужно тестам)', async () => {
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(loadConfig({ allowPrivate: true }).allowPrivate).toBe(true);
  });

  it('host по умолчанию 127.0.0.1', async () => {
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(loadConfig().host).toBe('127.0.0.1');
  });

  it('config.json не может перевести демон на 0.0.0.0', async () => {
    mkdirSync(join(fakeHome, '.webharvest'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.webharvest', 'config.json'),
      JSON.stringify({ host: '0.0.0.0' }),
    );

    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(loadConfig().host).toBe('127.0.0.1');
  });

  it('даже explicit override не может увести host с loopback', async () => {
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(loadConfig({ host: '0.0.0.0' }).host).toBe('127.0.0.1');
  });

  it('WEBHARVEST_PORT с валидным числом задаёт порт', async () => {
    process.env.WEBHARVEST_PORT = '9090';
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(loadConfig().port).toBe(9090);
  });

  it('WEBHARVEST_PORT с мусором ("8787x") падает громко, называя переменную и значение, а не превращается в NaN', async () => {
    process.env.WEBHARVEST_PORT = '8787x';
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(() => loadConfig()).toThrow(/WEBHARVEST_PORT/);
    expect(() => loadConfig()).toThrow(/8787x/);
  });

  it('WEBHARVEST_PORT вне диапазона 1-65535 тоже падает громко', async () => {
    process.env.WEBHARVEST_PORT = '99999';
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(() => loadConfig()).toThrow(/WEBHARVEST_PORT/);
  });

  it('WEBHARVEST_PORT="0" падает громко (0 - не валидный порт слушателя)', async () => {
    process.env.WEBHARVEST_PORT = '0';
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(() => loadConfig()).toThrow(/WEBHARVEST_PORT/);
  });

  it('browserChannel по умолчанию "chromium" (bundled), browserProfileDir — null', async () => {
    const { loadConfig } = await import('../../src/daemon/config.js');
    const cfg = loadConfig();
    expect(cfg.browserChannel).toBe('chromium');
    expect(cfg.browserProfileDir).toBeNull();
  });

  it('WEBHARVEST_BROWSER_CHANNEL=chrome задаёт канал системного Chrome', async () => {
    process.env.WEBHARVEST_BROWSER_CHANNEL = 'chrome';
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(loadConfig().browserChannel).toBe('chrome');
  });

  it('WEBHARVEST_BROWSER_CHANNEL с мусором падает громко, называя переменную и значение', async () => {
    process.env.WEBHARVEST_BROWSER_CHANNEL = 'bogus';
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(() => loadConfig()).toThrow(/WEBHARVEST_BROWSER_CHANNEL/);
    expect(() => loadConfig()).toThrow(/bogus/);
  });

  it('browserChannel с мусором в config.json падает так же громко, как из env', async () => {
    // README описывает config.json и env как равноправные источники, но
    // loadFromFile отдаёт сырой JSON.parse: без проверки после слияния
    // "Chrome" тихо проваливался бы мимо channel === 'chrome' в
    // launchBrowser и давал бы bundled chromium вместо запрошенного Chrome.
    mkdirSync(join(fakeHome, '.webharvest'), { recursive: true });
    writeFileSync(join(fakeHome, '.webharvest', 'config.json'), JSON.stringify({ browserChannel: 'Chrome' }));
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(() => loadConfig()).toThrow(/browserChannel/);
    expect(() => loadConfig()).toThrow(/Chrome/);
  });

  it('нестроковый browserProfileDir в config.json падает с внятным сообщением, а не TypeError из join()', async () => {
    mkdirSync(join(fakeHome, '.webharvest'), { recursive: true });
    writeFileSync(join(fakeHome, '.webharvest', 'config.json'), JSON.stringify({ browserProfileDir: 42 }));
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(() => loadConfig()).toThrow(/browserProfileDir/);
  });

  it('валидный browserChannel из config.json проходит', async () => {
    mkdirSync(join(fakeHome, '.webharvest'), { recursive: true });
    writeFileSync(join(fakeHome, '.webharvest', 'config.json'), JSON.stringify({ browserChannel: 'chrome' }));
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(loadConfig().browserChannel).toBe('chrome');
  });

  it('WEBHARVEST_BROWSER_PROFILE_DIR задаёт каталог persistent-профиля', async () => {
    process.env.WEBHARVEST_BROWSER_PROFILE_DIR = '/tmp/xyz';
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(loadConfig().browserProfileDir).toBe('/tmp/xyz');
  });
});
