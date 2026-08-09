#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { loadConfig } from '../daemon/config.js';
import { plistContents, LABEL } from './launchd.js';
import { reconcileBeforeInstall, stopManualDaemon } from './daemon-process.js';
import { openLogSink, describeLogsAvailability } from './log-file.js';

// loadConfig() fails loudly on an invalid config (e.g. a malformed
// WEBHARVEST_PORT) — that's the right call for the daemon, which should
// never silently fall back to a wrong port. But the CLI is also how an
// operator recovers from exactly that kind of typo (e.g. `webharvest stop`),
// so it must not die with a raw Node stack trace: print the message through
// the CLI's own formatting and exit 1 instead.
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const daemonPath = resolve(here, '../daemon/index.js');
const home = join(homedir(), '.webharvest');
const logPath = join(home, 'daemon.log');
const pidFile = join(home, 'daemon.pid');
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const baseUrl = `http://${config.host}:${config.port}`;

async function getHealth(): Promise<{ ok: boolean; browser: boolean } | null> {
  try {
    const res = await request(`${baseUrl}/health`, { headersTimeout: 1500, bodyTimeout: 1500 });
    if (res.statusCode === 200) {
      const body = await res.body.json() as { ok?: boolean; browser?: boolean };
      return { ok: body.ok ?? false, browser: body.browser ?? false };
    }
    return null;
  } catch {
    return null;
  }
}

async function isUp(): Promise<boolean> {
  const health = await getHealth();
  return health?.ok ?? false;
}

async function waitUp(attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isUp()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const commands: Record<string, () => Promise<void>> = {
  async start() {
    if (await isUp()) return console.log('Демон уже работает.');

    // If plist is installed, ensure job is loaded and start it via launchd
    if (existsSync(plistPath)) {
      try {
        // Try to load the job in case it was unloaded by stop
        try {
          execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' });
        } catch {
          // Job may already be loaded, that's fine
        }
        // Now start the job
        execFileSync('launchctl', ['start', LABEL]);
        console.log(await waitUp() ? `Демон запущен через launchd: ${baseUrl}` : `Демон не поднялся, смотри ${logPath}`);
      } catch (err) {
        console.error(`Ошибка при запуске через launchd: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      return;
    }

    // Otherwise, start daemon as unsupervised background process
    mkdirSync(home, { recursive: true });
    const logFd = openLogSink(logPath);
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    // Record the PID so stop can kill it precisely
    if (child.pid) {
      writeFileSync(pidFile, String(child.pid), 'utf8');
    }
    child.unref();
    console.log(await waitUp() ? `Демон поднят: ${baseUrl}` : `Демон не поднялся, смотри ${logPath}`);
  },

  async stop() {
    // If running under launchd, unload the plist to remove the daemon from launchd's supervision.
    // launchctl stop only pauses the job; KeepAlive=true causes immediate restart.
    // unload -w (or bootout) exits the daemon and leaves it unloaded so it stays stopped.
    if (existsSync(plistPath)) {
      try {
        execFileSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' });
      } catch {
        // Plist may not be loaded, or unload may not be available (older macOS).
        // Try bootout as fallback for newer macOS (10.13+).
        try {
          execFileSync('launchctl', ['bootout', `gui/${execFileSync('id', ['-u'], { encoding: 'utf8' }).trim()}`, plistPath], {
            stdio: 'ignore',
          });
        } catch {
          // Neither works; plist may not be loaded. That's fine.
        }
      }
      // Clear any stale pidFile from a previous manual start
      try {
        rmSync(pidFile);
      } catch {
        // pidFile doesn't exist, that's fine
      }
      console.log('Демон остановлен.');
      return;
    }

    // For daemons started manually (not via install), use the recorded PID if available.
    // stopManualDaemon only removes the pidFile when the daemon is confirmed gone or stale;
    // if signalling fails (e.g. EPERM) the pidFile is kept so tracking isn't lost.
    const result = stopManualDaemon(pidFile, daemonPath);
    if (result === 'error') {
      console.error('Не удалось остановить демон (нет прав или процесс занят). daemon.pid сохранён.');
      process.exit(1);
    }
    console.log(result === 'not-found' ? 'Работающий демон не найден.' : 'Демон остановлен.');
  },

  async status() {
    const health = await getHealth();
    if (health === null) {
      console.log('Не работает.');
    } else if (health.ok) {
      const browser = health.browser ? '(браузер запущен)' : '(браузер спит)';
      console.log(`Работает: ${baseUrl} ${browser}`);
    } else {
      const browser = health.browser ? '(браузер запущен)' : '(браузер спит)';
      console.log(`Нездоров: ${baseUrl} ${browser}`);
    }
  },

  async logs() {
    const status = describeLogsAvailability(logPath);
    if (!status.available) {
      console.log(status.message);
      return;
    }
    spawn('tail', ['-f', logPath], { stdio: 'inherit' });
  },

  async install() {
    // Reconcile any manually-started daemon before enabling supervision. Without this,
    // RunAtLoad would spawn a second daemon on the same port while the original becomes
    // untracked and unkillable (its pidFile would otherwise just be deleted below).
    if (reconcileBeforeInstall(pidFile, daemonPath) === 'blocked') {
      console.error(
        'Не удалось остановить вручную запущенный демон; install отменён, чтобы не плодить второй процесс на том же порту.',
      );
      process.exit(1);
    }

    mkdirSync(home, { recursive: true });
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(
      plistPath,
      plistContents({
        nodePath: process.execPath,
        daemonPath,
        logPath,
        port: config.port,
        // config.braveApiKey already resolved BRAVE_API_KEY from the
        // environment (see loadConfig()) at the moment `install` runs —
        // threading it through here is what actually gets it into the
        // launchd job's environment, which does not inherit ours.
        braveApiKey: config.braveApiKey,
      }),
    );
    // First unload to clear any existing Disabled override
    try {
      execFileSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' });
    } catch {
      // Not loaded yet, that's fine.
    }
    // Load with -w to clear the Disabled override and enable at boot
    try {
      execFileSync('launchctl', ['load', '-w', plistPath]);
    } catch (err) {
      console.error(`Ошибка при загрузке в launchd: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    console.log(`Автозапуск настроен: ${plistPath}`);
  },

  async uninstall() {
    if (existsSync(plistPath)) {
      try {
        execFileSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' });
      } catch {
        // Already unloaded, that's fine.
      }
      rmSync(plistPath);
    }
    console.log('Автозапуск отключён.');
  },
};

const cmd = process.argv[2] ?? 'status';
const run = commands[cmd];
if (!run) {
  console.error(
    `Неизвестная команда: ${cmd}\nДоступно: ${Object.keys(commands).join(', ')}`,
  );
  process.exit(1);
}
await run();
