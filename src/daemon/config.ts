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
  respectRobots: boolean;
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
  respectRobots: false,
  allowPrivate: false,
};

// Поля, которые config.json на диске не может задать. allowPrivate отключает
// SSRF-защиту — если бы файл конфигурации мог включить это одним нечаянным
// "true", демон стал бы прокси на приватную сеть без единого явного решения
// вызывающего кода. Единственный легитимный путь — overrides, переданные
// программно (например, тестами).
const FILE_IGNORED_KEYS = new Set<keyof Config>(['allowPrivate']);

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
  if (process.env.WEBHARVEST_PORT) fromEnv.port = Number(process.env.WEBHARVEST_PORT);
  if (process.env.WEBHARVEST_SEARXNG_URL) fromEnv.searxngUrl = process.env.WEBHARVEST_SEARXNG_URL;

  return { ...DEFAULTS, ...fromFile, ...fromEnv, ...overrides };
}
