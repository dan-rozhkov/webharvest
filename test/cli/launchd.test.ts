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

  it('экранирует амперсанд перед другими символами правильно (не двойное экранирование)', () => {
    const plist = plistContents({
      nodePath: '/a&b&c/node',
      daemonPath: '/x',
      logPath: '/y',
      port: 1,
    });
    // Should have exactly two &amp; sequences, not &amp;amp;
    expect(plist).toContain('a&amp;b&amp;c');
    expect(plist).not.toContain('&amp;amp;');
  });

  it('обрабатывает пути с пробелами', () => {
    const plist = plistContents({
      nodePath: '/path with spaces/node',
      daemonPath: '/path with spaces/index.js',
      logPath: '/path with spaces/log',
      port: 1,
    });
    expect(plist).toContain('path with spaces');
  });

  it('обрабатывает пути с юникодом', () => {
    const plist = plistContents({
      nodePath: '/путь/node',
      daemonPath: '/путь/index.js',
      logPath: '/логи/daemon.log',
      port: 1,
    });
    expect(plist).toContain('путь');
    expect(plist).toContain('логи');
  });

  it('обрабатывает комбинацию опасных символов', () => {
    const plist = plistContents({
      nodePath: '/a < b & c > d/node',
      daemonPath: '/x',
      logPath: '/y',
      port: 1,
    });
    expect(plist).toContain('a &lt; b &amp; c &gt; d');
  });
});
