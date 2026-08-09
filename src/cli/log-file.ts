import { openSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Opens (creating parent directories and the file itself if needed) an fd
 * suitable for passing directly as a child_process `stdio` entry, so a
 * manually-spawned daemon's stdout/stderr land in the same log file
 * `webharvest logs` tails. Previously the manual spawn path used
 * `stdio: ['ignore', 'ignore', 'ignore']` — only the launchd-installed path
 * (StandardOutPath/StandardErrorPath in the plist) ever wrote daemon.log, so
 * `webharvest start` without `install` produced a daemon that logged
 * nowhere, and `webharvest logs` pointed the user at a file that would never
 * exist.
 */
export function openLogSink(logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true });
  return openSync(logPath, 'a');
}

/**
 * What `webharvest logs` should do: tail the file if it exists, or say
 * something useful instead of handing `tail -f` a path that was never
 * written (which blocks silently waiting for a file that will never appear,
 * rather than reporting anything actionable).
 */
export function describeLogsAvailability(
  logPath: string,
): { available: true } | { available: false; message: string } {
  if (existsSync(logPath)) return { available: true };
  return {
    available: false,
    message:
      `Файл логов не найден: ${logPath}. Демон ни разу не запускался (ни вручную, ни через launchd), ` +
      'либо ещё не написал ни строки — запусти `webharvest start` и повтори.',
  };
}
