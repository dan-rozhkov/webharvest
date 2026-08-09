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
await app.listen({ port: config.port, host: config.host });
console.log(`[webharvest] демон слушает http://${config.host}:${config.port}`);
