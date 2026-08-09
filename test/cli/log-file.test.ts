import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLogSink, describeLogsAvailability } from '../../src/cli/log-file.js';

describe('openLogSink', () => {
  it('создаёт недостающие родительские директории и открывает файл на запись', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webharvest-logtest-'));
    const logPath = join(dir, 'nested', 'daemon.log');
    const fd = openLogSink(logPath);
    writeSync(fd, 'hello\n');
    closeSync(fd);
    expect(readFileSync(logPath, 'utf8')).toBe('hello\n');
  });

  it('дозаписывает в конец существующего файла, а не перезаписывает его', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webharvest-logtest-'));
    const logPath = join(dir, 'daemon.log');
    const fd1 = openLogSink(logPath);
    writeSync(fd1, 'first\n');
    closeSync(fd1);

    const fd2 = openLogSink(logPath);
    writeSync(fd2, 'second\n');
    closeSync(fd2);

    expect(readFileSync(logPath, 'utf8')).toBe('first\nsecond\n');
  });
});

describe('describeLogsAvailability', () => {
  it('сообщает, что файла логов нет, вместо того чтобы дать команде logs повиснуть на несуществующем пути', () => {
    const result = describeLogsAvailability('/nonexistent/webharvest-logtest/daemon.log');
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.message).toContain('/nonexistent/webharvest-logtest/daemon.log');
      expect(result.message).toMatch(/webharvest start/);
    }
  });

  it('сообщает, что файл доступен, когда он реально существует', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webharvest-logtest-'));
    const logPath = join(dir, 'daemon.log');
    writeFileSync(logPath, '');
    expect(describeLogsAvailability(logPath)).toEqual({ available: true });
  });
});
