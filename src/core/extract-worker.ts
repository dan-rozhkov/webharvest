/**
 * Поток пула extract-pool.ts: тот же extract(), только вне главного потока
 * демона. Сообщения — { id, html, url } → { id, ok, value | error }.
 */
import { parentPort } from 'node:worker_threads';
import { extract } from './extractor.js';

parentPort!.on('message', (msg: { id: number; html: string; url: string }) => {
  try {
    parentPort!.postMessage({ id: msg.id, ok: true, value: extract(msg.html, msg.url) });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
