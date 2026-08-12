import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  port: number;
  host: string;
  cachePath: string;
  cacheTtlMs: number;
  searxngUrl: string | null;
  braveApiKey: string | null;
  idleTimeoutMs: number;
  /** Канал запуска браузера: bundled chromium или системный Google Chrome
   *  (с фолбэком на bundled, если Chrome не установлен — см. launchBrowser). */
  browserChannel: 'chromium' | 'chrome';
  /** Persistent user-data-dir браузера (cookies переживают рестарты демона);
   *  null — обычный временный профиль на каждый запуск. */
  browserProfileDir: string | null;
  /** Только для тестов: пускает приватные/локальные адреса мимо SSRF-защиты.
   *  Никогда не читается из config.json — только из явных overrides (кода вызова),
   *  чтобы файл на диске не мог тихо открыть демон для SSRF. */
  allowPrivate: boolean;
}

const DEFAULTS: Config = {
  port: 8787,
  host: '127.0.0.1',
  cachePath: join(homedir(), '.webharvest', 'cache.db'),
  cacheTtlMs: 24 * 60 * 60_000,
  searxngUrl: 'http://127.0.0.1:8080',
  braveApiKey: null,
  idleTimeoutMs: 5 * 60_000,
  browserChannel: 'chromium',
  browserProfileDir: null,
  allowPrivate: false,
};

// Поля, которые config.json на диске не может задать.
//  - allowPrivate отключает SSRF-защиту — файл на диске не должен мочь
//    включить это одним нечаянным "true".
//  - host решает, на каком интерфейсе слушает демон. Глобальное требование
//    проекта — "демон биндится только на 127.0.0.1" — не должно зависеть от
//    того, что кто-то однажды допишет "0.0.0.0" в config.json.
// Единственный легитимный путь изменить эти поля — overrides, переданные
// программно (например, тестами).
const FILE_IGNORED_KEYS = new Set<keyof Config>(['allowPrivate', 'host']);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Fail loudly rather than fall back silently: Number("8787x") is NaN, and a
// NaN port reaches app.listen({port: NaN}), which throws ERR_SOCKET_BAD_PORT
// deep inside Fastify/Node with a message that never mentions
// WEBHARVEST_PORT or the value that caused it - the daemon just exits 1
// reporting a listen URL like "http://127.0.0.1:NaN", and the CLI then goes
// on to probe that nonsense URL. A typo in a plist or shell profile deserves
// a message that names the actual cause, not a downstream crash three
// layers removed from it. Falling back to the default 8787 was considered
// and rejected: it would silently ignore an operator's explicit intent to
// run on a different port (e.g. to avoid a conflict with another instance),
// which is exactly the kind of silent degradation this project's spec rules
// out.
function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `WEBHARVEST_PORT должен быть целым числом от 1 до 65535, получено: "${raw}"`,
    );
  }
  return n;
}

function loadFromFile(): Partial<Config> {
  const path = join(homedir(), '.webharvest', 'config.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    for (const key of FILE_IGNORED_KEYS) delete raw[key];
    return raw;
  } catch {
    // файла нет или он битый — работаем на значениях по умолчанию
    return {};
  }
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const fromFile = loadFromFile();

  const fromEnv: Partial<Config> = {};
  if (process.env.BRAVE_API_KEY) fromEnv.braveApiKey = process.env.BRAVE_API_KEY;
  if (process.env.WEBHARVEST_PORT) fromEnv.port = parsePort(process.env.WEBHARVEST_PORT);
  if (process.env.WEBHARVEST_SEARXNG_URL) fromEnv.searxngUrl = process.env.WEBHARVEST_SEARXNG_URL;
  if (process.env.WEBHARVEST_BROWSER_CHANNEL) {
    const c = process.env.WEBHARVEST_BROWSER_CHANNEL;
    if (c !== 'chromium' && c !== 'chrome') {
      throw new Error(`WEBHARVEST_BROWSER_CHANNEL должен быть "chromium" или "chrome", получено: "${c}"`);
    }
    fromEnv.browserChannel = c;
  }
  if (process.env.WEBHARVEST_BROWSER_PROFILE_DIR) fromEnv.browserProfileDir = process.env.WEBHARVEST_BROWSER_PROFILE_DIR;

  const merged = { ...DEFAULTS, ...fromFile, ...fromEnv, ...overrides };

  // Defense in depth: even an explicit override cannot make the daemon bind
  // to a non-loopback interface. This is the one config invariant we never
  // relax, unlike allowPrivate which tests legitimately need to flip.
  if (!LOOPBACK_HOSTS.has(merged.host)) {
    merged.host = DEFAULTS.host;
  }

  return merged;
}
