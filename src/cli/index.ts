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

async function isUp(): Promise<boolean> {
  try {
    const res = await request(`${baseUrl}/health`, { headersTimeout: 1500, bodyTimeout: 1500 });
    return res.statusCode === 200;
  } catch {
    return false;
  }
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
    // First, try to stop via launchctl (if running under launchd).
    // This prevents the daemon from being immediately restarted by launchd's KeepAlive.
    try {
      execFileSync('launchctl', ['stop', LABEL], { stdio: 'ignore' });
    } catch {
      // Not running under launchd, or already stopped — that's fine.
    }

    // Then, try to kill any remaining process matching the daemon path.
    try {
      execFileSync('pkill', ['-f', daemonPath], { stdio: 'ignore' });
    } catch {
      // No process found or already dead.
    }

    console.log('Демон остановлен.');
  },

  async status() {
    const running = await isUp();
    if (running) {
      console.log(`Работает: ${baseUrl}`);
    } else {
      console.log('Не работает.');
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
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    } catch {
      // Not loaded yet, that's fine.
    }
    execFileSync('launchctl', ['load', plistPath]);
    console.log(`Автозапуск настроен: ${plistPath}`);
  },

  async uninstall() {
    if (existsSync(plistPath)) {
      try {
        execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
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
