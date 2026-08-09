import { loadConfig } from './config.js';
import { createService } from './service.js';
import { createHttpServer } from './http.js';

const config = loadConfig();
const service = createService(config);
const app = createHttpServer(service);

let stopping = false;

async function stop(signal: string): Promise<void> {
  // A second signal (e.g. an impatient double Ctrl-C) must not re-enter the
  // shutdown sequence while it's already closing the browser/cache.
  if (stopping) return;
  stopping = true;
  console.log(`[webharvest] получен ${signal}, останавливаюсь`);
  await app.close().catch(() => {});
  await service.shutdown().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

// Демон слушает только localhost — намеренно: config.host по умолчанию
// '127.0.0.1', и это единственный интерфейс, на котором мы когда-либо
// должны биндиться.
try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`[webharvest] демон слушает http://${config.host}:${config.port}`);
} catch (e) {
  // Without this, a bind failure (most commonly EADDRINUSE — another
  // daemon instance already running) becomes an unhandled rejection: a
  // raw stack trace on stderr and a non-obvious exit. Same shutdown
  // sequence as a signal, so a browser launched during startup doesn't
  // leak, then a clear one-line explanation and a non-zero exit code.
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[webharvest] не удалось запуститься на http://${config.host}:${config.port}: ${msg}`);
  await service.shutdown().catch(() => {});
  process.exit(1);
}
