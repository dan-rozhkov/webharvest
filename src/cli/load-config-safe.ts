import { loadConfig, type Config } from '../daemon/config.js';

export type LoadConfigResult =
  | { ok: true; config: Config }
  | { ok: false; message: string };

/**
 * `loadConfig()` fails loudly on an invalid config (e.g. a malformed
 * WEBHARVEST_PORT) — that's the right call for the daemon (see
 * `src/daemon/index.ts`), which should never silently fall back to a wrong
 * port. But the CLI is also how an operator recovers from exactly that kind
 * of typo (e.g. `webharvest stop`), so it must not die with a raw Node
 * stack trace: this catches the throw and hands back a message formatted
 * for the CLI's own output instead of a stack trace.
 *
 * Deliberately does not call `process.exit` itself — that stays at the call
 * site in `src/cli/index.ts` — so this function is pure enough to unit test
 * directly (a top-level `process.exit` in a module under test would kill
 * the test runner).
 */
export function loadConfigSafe(): LoadConfigResult {
  try {
    return { ok: true, config: loadConfig() };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
