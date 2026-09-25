/**
 * Пул потоков для extract().
 *
 * extract() синхронный и тяжёлый: на Википедии ~2 с чистого CPU (JSDOM +
 * Defuddle + Readability + Turndown). В главном потоке это значит, что демон
 * на всё это время глух — стоят и чужие browser_* действия, и остальные
 * страницы поиска с fetchContent, которые могли бы разбираться параллельно.
 * Пул выносит разбор в worker_threads; результат тот же самый — та же
 * функция, тот же вход.
 *
 * Потоки поднимаются лениво и гаснут после простоя (каждый держит свой JSDOM
 * и десятки мегабайт). Если собранного файла потока нет — например, код
 * запущен из исходников под vitest/tsx, — пул честно работает в главном
 * потоке: медленнее, но с тем же результатом.
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { extract, type Extracted } from './extractor.js';

export interface ExtractPool {
  extract(html: string, url: string): Promise<Extracted>;
  shutdown(): Promise<void>;
}

interface Task {
  id: number;
  html: string;
  url: string;
  resolve: (v: Extracted) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
}

export function createExtractPool(opts: { size?: number; idleMs?: number; workerUrl?: URL } = {}): ExtractPool {
  const size = opts.size ?? Math.max(1, Math.min(3, availableParallelism() - 1));
  const idleMs = opts.idleMs ?? 5 * 60_000;
  const workerUrl = opts.workerUrl ?? new URL('./extract-worker.js', import.meta.url);
  const inline = !existsSync(fileURLToPath(workerUrl));

  const slots: Slot[] = [];
  const queue: Task[] = [];
  let nextId = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function spawn(): Slot {
    const slot: Slot = { worker: new Worker(workerUrl), task: null };
    slot.worker.on('message', (msg: { id: number; ok: boolean; value?: Extracted; error?: string }) => {
      const task = slot.task;
      if (!task || task.id !== msg.id) return;
      slot.task = null;
      if (msg.ok) task.resolve(msg.value!);
      else task.reject(new Error(msg.error));
      pump();
    });
    const die = (e: unknown) => {
      const i = slots.indexOf(slot);
      if (i !== -1) slots.splice(i, 1);
      slot.task?.reject(e instanceof Error ? e : new Error(`extract-поток завершился: ${String(e)}`));
      slot.task = null;
      pump();
    };
    slot.worker.on('error', die);
    slot.worker.on('exit', (code) => {
      if (slots.includes(slot)) die(new Error(`extract-поток завершился с кодом ${code}`));
    });
    slots.push(slot);
    return slot;
  }

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (queue.length || slots.some((s) => s.task)) return;
    idleTimer = setTimeout(() => {
      for (const s of slots.splice(0)) void s.worker.terminate();
    }, idleMs);
    idleTimer.unref();
  }

  function pump(): void {
    while (queue.length) {
      const slot = slots.find((s) => !s.task) ?? (slots.length < size ? spawn() : null);
      if (!slot) break;
      const task = queue.shift()!;
      slot.task = task;
      slot.worker.postMessage({ id: task.id, html: task.html, url: task.url });
    }
    armIdle();
  }

  return {
    extract(html, url) {
      if (inline || closed) return Promise.resolve().then(() => extract(html, url));
      return new Promise<Extracted>((resolve, reject) => {
        queue.push({ id: ++nextId, html, url, resolve, reject });
        pump();
      });
    },
    async shutdown() {
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      const all = slots.splice(0);
      for (const t of queue.splice(0)) t.reject(new Error('extract-пул остановлен'));
      for (const s of all) s.task?.reject(new Error('extract-пул остановлен'));
      await Promise.all(all.map((s) => s.worker.terminate()));
    },
  };
}
