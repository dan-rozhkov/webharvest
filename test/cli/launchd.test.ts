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

  it('прописывает BRAVE_API_KEY в EnvironmentVariables, когда он задан', () => {
    const withKey = plistContents({
      nodePath: '/opt/homebrew/bin/node',
      daemonPath: '/x/index.js',
      logPath: '/y/log',
      port: 8787,
      braveApiKey: 'sk-fake-brave-key',
    });
    expect(withKey).toContain('<key>BRAVE_API_KEY</key>');
    expect(withKey).toContain('<string>sk-fake-brave-key</string>');
  });

  it('не пишет BRAVE_API_KEY в plist, когда он не задан', () => {
    const withoutKey = plistContents({
      nodePath: '/opt/homebrew/bin/node',
      daemonPath: '/x/index.js',
      logPath: '/y/log',
      port: 8787,
    });
    expect(withoutKey).not.toContain('BRAVE_API_KEY');

    const nullKey = plistContents({
      nodePath: '/opt/homebrew/bin/node',
      daemonPath: '/x/index.js',
      logPath: '/y/log',
      port: 8787,
      braveApiKey: null,
    });
    expect(nullKey).not.toContain('BRAVE_API_KEY');
  });

  it('экранирует опасные символы в BRAVE_API_KEY так же, как в остальных полях', () => {
    const plist = plistContents({
      nodePath: '/n',
      daemonPath: '/x',
      logPath: '/y',
      port: 1,
      braveApiKey: 'a&b<c>',
    });
    expect(plist).toContain('a&amp;b&lt;c&gt;');
  });

  it('не экранирует кавычки в текстовом контенте (они не опасны в XML text content)', () => {
    // Quotes only need escaping in XML attributes, not in text content.
    // ProgramArguments values are XML text elements (<string>), not attributes.
    // So quotes like "path/with \"quotes\"/node" are safe as-is.
    const plist = plistContents({
      nodePath: '/path/with "quotes"/node',
      daemonPath: '/x',
      logPath: '/y',
      port: 1,
    });
    // Should preserve the quotes unchanged (no &quot;)
    expect(plist).toContain('with "quotes"');
    expect(plist).not.toContain('&quot;');
  });
});
