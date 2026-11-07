import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLightpandaPool, envWithoutProxy } from '../../src/core/lightpanda.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Lightpanda: окружение процесса без прокси-переменных', () => {
  it('envWithoutProxy убирает NO_PROXY/HTTP(S)_PROXY/ALL_PROXY в обоих регистрах', () => {
    const out = envWithoutProxy({
      PATH: '/bin', HOME: '/h',
      NO_PROXY: '127.0.0.1', no_proxy: 'localhost',
      HTTP_PROXY: 'http://p', http_proxy: 'http://p',
      HTTPS_PROXY: 'http://p', https_proxy: 'http://p',
      ALL_PROXY: 'socks5://p', all_proxy: 'socks5://p',
      NOT_A_PROXY_VAR: 'keep',
    });
    expect(out).toEqual({ PATH: '/bin', HOME: '/h', NOT_A_PROXY_VAR: 'keep' });
  });

  it('реальный spawn получает очищенное окружение и --http-proxy на наш прокси', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-lp-'));
    dirs.push(dir);
    const out = join(dir, 'env.txt');
    const bin = join(dir, 'fake-lightpanda');
    writeFileSync(bin, `#!/bin/sh\n{ echo "ARGS:$*"; env; } > "${out}"\nexit 0\n`);
    chmodSync(bin, 0o755);
    const saved = { ...process.env };
    Object.assign(process.env, { NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', HTTPS_PROXY: 'http://evil:1', https_proxy: 'http://evil:1', ALL_PROXY: 'http://evil:1', all_proxy: 'http://evil:1', HTTP_PROXY: 'http://evil:1', http_proxy: 'http://evil:1' });
    const pool = createLightpandaPool({ bin });
    try {
      await expect(pool.render('http://example.test/')).rejects.toThrow(/Lightpanda/);
    } finally {
      for (const k of ['NO_PROXY', 'no_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await pool.shutdown();
    }
    const dump = readFileSync(out, 'utf8');
    expect(dump).toMatch(/ARGS:serve .*--http-proxy http:\/\/127\.0\.0\.1:\d+/);
    expect(dump).not.toMatch(/^(no_proxy|http_proxy|https_proxy|all_proxy)=/im);
    expect(dump).toMatch(/^PATH=/m);
  });
});
