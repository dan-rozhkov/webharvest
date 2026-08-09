import { describe, it, expect } from 'vitest';
import { plistContents, LABEL } from '../../src/cli/launchd.js';

describe('plistContents', () => {
  const plist = plistContents({
    nodePath: '/opt/homebrew/bin/node',
    daemonPath: '/Users/x/prj/webharvest/dist/daemon/index.js',
    logPath: '/Users/x/.webharvest/daemon.log',
    port: 8787,
  });

  it('содержит корректный label', () => {
    expect(plist).toContain(`<string>${LABEL}</string>`);
  });

  it('прописывает пути к node и демону', () => {
    expect(plist).toContain('/opt/homebrew/bin/node');
    expect(plist).toContain('dist/daemon/index.js');
  });

  it('включает автоперезапуск и логи', () => {
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('daemon.log');
  });

  it('экранирует XML-опасные символы в путях', () => {
    const escaped = plistContents({
      nodePath: '/tmp/a&b/node',
      daemonPath: '/tmp/<x>/index.js',
      logPath: '/tmp/log',
      port: 1,
    });
    expect(escaped).toContain('a&amp;b');
    expect(escaped).toContain('&lt;x&gt;');
  });
});
