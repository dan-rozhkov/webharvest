import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadConfigSafe', () => {
  const originalHome = process.env.HOME;
  const originalPort = process.env.WEBHARVEST_PORT;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'webharvest-cli-config-'));
    process.env.HOME = fakeHome;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalPort === undefined) delete process.env.WEBHARVEST_PORT;
    else process.env.WEBHARVEST_PORT = originalPort;
    vi.resetModules();
  });

  it('возвращает { ok: true, config } для валидного WEBHARVEST_PORT', async () => {
    process.env.WEBHARVEST_PORT = '9999';
    const { loadConfigSafe } = await import('../../src/cli/load-config-safe.js');
    const result = loadConfigSafe();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.port).toBe(9999);
    }
  });

  it('возвращает { ok: false, message } для невалидного WEBHARVEST_PORT, называя переменную и плохое значение', async () => {
    process.env.WEBHARVEST_PORT = 'not-a-port';
    const { loadConfigSafe } = await import('../../src/cli/load-config-safe.js');
    const result = loadConfigSafe();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('WEBHARVEST_PORT');
      expect(result.message).toContain('not-a-port');
    }
  });

  it('не вызывает process.exit сам — это остаётся на месте вызова в index.ts', async () => {
    process.env.WEBHARVEST_PORT = 'garbage';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called by loadConfigSafe');
    });
    const { loadConfigSafe } = await import('../../src/cli/load-config-safe.js');
    expect(() => loadConfigSafe()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe('daemon config still fails loudly (unchanged by the CLI extraction)', () => {
  const originalHome = process.env.HOME;
  const originalPort = process.env.WEBHARVEST_PORT;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'webharvest-daemon-config-'));
    process.env.HOME = fakeHome;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalPort === undefined) delete process.env.WEBHARVEST_PORT;
    else process.env.WEBHARVEST_PORT = originalPort;
    vi.resetModules();
  });

  it('loadConfig() (без обёртки) всё ещё бросает исключение на невалидном WEBHARVEST_PORT', async () => {
    process.env.WEBHARVEST_PORT = 'not-a-port';
    const { loadConfig } = await import('../../src/daemon/config.js');
    expect(() => loadConfig()).toThrow(/WEBHARVEST_PORT/);
  });
});
