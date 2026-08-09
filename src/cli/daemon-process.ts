import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

/** Removes the pidFile, swallowing "already gone" errors. */
function deletePidFileQuiet(pidFile: string): void {
  try {
    rmSync(pidFile);
  } catch {
    // already gone
  }
}

/**
 * Verify that `pid` still belongs to our daemon process before it is trusted.
 *
 * Runs `ps -p <pid> -o command=` and checks the command line contains `daemonPath`.
 * A pid that no longer exists, or that now belongs to an unrelated process (PID reuse
 * after reboot, or a pidFile left over from an old checkout), is treated as stale:
 * the pidFile is deleted and `false` is returned. Only a live process whose command
 * line matches the daemon's entry point returns `true`.
 */
export function verifyPidBelongsToDaemon(pid: string, daemonPath: string, pidFile: string): boolean {
  try {
    const commandLine = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).trim();
    if (commandLine.includes(daemonPath)) {
      return true;
    }
    deletePidFileQuiet(pidFile);
    return false;
  } catch {
    // ps exits non-zero when the pid doesn't exist.
    deletePidFileQuiet(pidFile);
    return false;
  }
}

export type StopResult = 'stopped' | 'stale' | 'not-found' | 'error';

/**
 * Stop a manually-started (non-launchd) daemon tracked by `pidFile`.
 *
 * - `not-found`: no pidFile — nothing to do.
 * - `stale`: the pidFile pointed at a pid that's gone or reused; it has been deleted,
 *   nothing was signalled.
 * - `stopped`: a verified daemon process was signalled and the pidFile removed.
 * - `error`: the pid was verified but signalling it failed (e.g. EPERM). The pidFile is
 *   deliberately left in place — deleting it here would lose the only record of a daemon
 *   that is, as far as we know, still running.
 */
export function stopManualDaemon(
  pidFile: string,
  daemonPath: string,
  signal: NodeJS.Signals | number = 'SIGTERM',
): StopResult {
  if (!existsSync(pidFile)) return 'not-found';

  const pid = readFileSync(pidFile, 'utf8').trim();
  if (!verifyPidBelongsToDaemon(pid, daemonPath, pidFile)) {
    return 'stale';
  }

  try {
    process.kill(Number(pid), signal);
    deletePidFileQuiet(pidFile);
    return 'stopped';
  } catch {
    return 'error';
  }
}

export type ReconcileResult = 'ready' | 'blocked';

/**
 * Called before `install` writes the plist and loads it into launchd.
 *
 * If a daemon was started manually (`webharvest start` with no plist installed), it holds
 * the port and is tracked only by pidFile. Without this step, `install` would delete the
 * pidFile and load the plist regardless, `RunAtLoad` would spawn a second daemon, and the
 * two would race for the same port while the original became untracked and unkillable.
 *
 * Returns `'blocked'` when the existing daemon could not be stopped (see `stopManualDaemon`'s
 * `'error'` case) — the caller must not proceed to install in that case, or it would create a
 * second daemon on a port the first still holds. Returns `'ready'` when there is nothing to
 * reconcile (`'not-found'`), or the existing daemon was stopped or found stale (`'stopped'`,
 * `'stale'`).
 */
export function reconcileBeforeInstall(pidFile: string, daemonPath: string): ReconcileResult {
  const result = stopManualDaemon(pidFile, daemonPath);
  return result === 'error' ? 'blocked' : 'ready';
}
