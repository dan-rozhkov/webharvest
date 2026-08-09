#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { loadConfig } from '../daemon/config.js';
import { plistContents, LABEL } from './launchd.js';

const config = loadConfig();
const here = dirname(fileURLToPath(import.meta.url));
const daemonPath = resolve(here, '../daemon/index.js');
const home = join(homedir(), '.webharvest');
const logPath = join(home, 'daemon.log');
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
    mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: process.env,
    });
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
    }

    // Finally, for daemons started manually (not via install), kill any remaining process.
    try {
      execFileSync('pkill', ['-f', daemonPath], { stdio: 'ignore' });
    } catch {
      // No process found or already dead.
    }

    console.log('Демон остановлен.');
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
    spawn('tail', ['-f', logPath], { stdio: 'inherit' });
  },

  async install() {
    mkdirSync(home, { recursive: true });
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(
      plistPath,
      plistContents({
        nodePath: process.execPath,
        daemonPath,
        logPath,
        port: config.port,
      }),
    );
    try {
      execFileSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' });
    } catch {
      // Not loaded yet, that's fine.
    }
    try {
      execFileSync('launchctl', ['load', plistPath]);
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
