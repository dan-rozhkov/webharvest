import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadConfig', () => {
  const originalHome = process.env.HOME;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'webharvest-home-'));
    process.env.HOME = fakeHome;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
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
});
