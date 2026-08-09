import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  verifyPidBelongsToDaemon,
  stopManualDaemon,
  reconcileBeforeInstall,
} from '../../src/cli/daemon-process.js';

const daemonPath = '/fake/daemon/path/index.js';

/** A PID that (almost certainly) does not belong to any running process.
 *  Kept within the 5-digit range macOS `ps` accepts, so it fails with "no such process"
 *  rather than "process id too large". */
function unusedPid(): string {
  return '99999';
}

describe('daemon-process', () => {
  let home: string;
  let pidFile: string;

  beforeEach(() => {
    home = join(tmpdir(), `webharvest-cli-test-${process.pid}-${Date.now()}`);
    mkdirSync(home, { recursive: true });
    pidFile = join(home, 'daemon.pid');
  });

  afterEach(() => {
    try {
      rmSync(home, { recursive: true });
    } catch {
      // already gone
    }
  });

  describe('verifyPidBelongsToDaemon', () => {
    it('treats a live PID whose command line does not match the daemon as stale, and deletes the pidFile', () => {
      // The current test process is a real, live PID — but its command line is vitest/node,
      // not `daemonPath`. A blind `return true` (the old behaviour) would pass this test;
      // only a real command-line check catches it.
      writeFileSync(pidFile, String(process.pid), 'utf8');

      const result = verifyPidBelongsToDaemon(String(process.pid), daemonPath, pidFile);

      expect(result).toBe(false);
      expect(existsSync(pidFile)).toBe(false);
    });

    it('treats a PID that does not exist as stale, and deletes the pidFile', () => {
      const pid = unusedPid();
      writeFileSync(pidFile, pid, 'utf8');

      const result = verifyPidBelongsToDaemon(pid, daemonPath, pidFile);

      expect(result).toBe(false);
      expect(existsSync(pidFile)).toBe(false);
    });

    it('returns true and keeps the pidFile when the command line matches the daemon path', async () => {
      // Spawn a real, live process whose command line contains `daemonPath`, so `ps -o command=`
      // genuinely reports it — this is the only case a stale/blind implementation would get wrong
      // in the other direction (never trusting a real match).
      const child: ChildProcess = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 10000)', daemonPath],
        { stdio: 'ignore' },
      );
      expect(child.pid).toBeDefined();
      // give the OS a moment to register the process
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(pidFile, String(child.pid), 'utf8');

      try {
        const result = verifyPidBelongsToDaemon(String(child.pid), daemonPath, pidFile);
        expect(result).toBe(true);
        expect(existsSync(pidFile)).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });

  describe('stopManualDaemon', () => {
    it('returns not-found when there is no pidFile', () => {
      expect(stopManualDaemon(pidFile, daemonPath)).toBe('not-found');
    });

    it('returns stale and removes the pidFile for a pid that no longer exists', () => {
      writeFileSync(pidFile, unusedPid(), 'utf8');

      expect(stopManualDaemon(pidFile, daemonPath)).toBe('stale');
      expect(existsSync(pidFile)).toBe(false);
    });

    it('signals and removes the pidFile for a verified live daemon process', async () => {
      const child: ChildProcess = spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 10000)', daemonPath],
        { stdio: 'ignore' },
      );
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(pidFile, String(child.pid), 'utf8');

      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const result = stopManualDaemon(pidFile, daemonPath);
      await exited;

      expect(result).toBe('stopped');
      expect(existsSync(pidFile)).toBe(false);
    });

    it('keeps the pidFile when signalling a verified pid fails (e.g. EPERM)', () => {
      const child: ChildProcess = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 10000)', daemonPath],
        { stdio: 'ignore' },
      );
      writeFileSync(pidFile, String(child.pid), 'utf8');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      });

      try {
        const result = stopManualDaemon(pidFile, daemonPath);
        expect(result).toBe('error');
        // A genuinely failed stop must not lose its tracking file.
        expect(existsSync(pidFile)).toBe(true);
        expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(child.pid));
      } finally {
        killSpy.mockRestore();
        child.kill('SIGKILL');
      }
    });
  });

  describe('reconcileBeforeInstall', () => {
    it('is ready when there is no manually-started daemon to reconcile', () => {
      expect(reconcileBeforeInstall(pidFile, daemonPath)).toBe('ready');
    });

    it('is ready after stopping a live manually-started daemon', async () => {
      const child: ChildProcess = spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 10000)', daemonPath],
        { stdio: 'ignore' },
      );
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(pidFile, String(child.pid), 'utf8');

      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const result = reconcileBeforeInstall(pidFile, daemonPath);
      await exited;

      expect(result).toBe('ready');
      expect(existsSync(pidFile)).toBe(false);
    });

    it('is blocked when the existing daemon cannot be stopped, so install must not proceed', () => {
      const child: ChildProcess = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 10000)', daemonPath],
        { stdio: 'ignore' },
      );
      writeFileSync(pidFile, String(child.pid), 'utf8');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      });

      try {
        expect(reconcileBeforeInstall(pidFile, daemonPath)).toBe('blocked');
        // The pidFile must survive so the still-running daemon stays tracked.
        expect(existsSync(pidFile)).toBe(true);
      } finally {
        killSpy.mockRestore();
        child.kill('SIGKILL');
      }
    });
  });
});
