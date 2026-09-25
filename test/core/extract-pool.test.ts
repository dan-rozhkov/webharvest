import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExtractPool, type ExtractPool } from '../../src/core/extract-pool.js';
import { extract } from '../../src/core/extractor.js';

const html = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'mdn-fetch.html'), 'utf8');
// Настоящий поток нужен собранный: worker_threads не исполняет .ts.
const built = pathToFileURL(join(import.meta.dirname, '..', '..', 'dist', 'core', 'extract-worker.js'));

let pool: ExtractPool | undefined;
afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

describe('extract-pool', () => {
  it('без собранного потока работает в главном потоке с тем же результатом', async () => {
    pool = createExtractPool({ workerUrl: new URL('file:///nonexistent/extract-worker.js') });
    expect(await pool.extract(html, 'https://developer.mozilla.org/')).toEqual(extract(html, 'https://developer.mozilla.org/'));
  });

  it.skipIf(!existsSync(built))('в потоке даёт тот же результат, что и extract(), в том числе параллельно', async () => {
    pool = createExtractPool({ size: 2, workerUrl: built });
    const expected = extract(html, 'https://developer.mozilla.org/');
    const results = await Promise.all([1, 2, 3].map(() => pool!.extract(html, 'https://developer.mozilla.org/')));
    for (const r of results) expect(r).toEqual(expected);
  });

  it.skipIf(!existsSync(built))('shutdown отклоняет задачи в очереди, а не вешает их', async () => {
    pool = createExtractPool({ size: 1, workerUrl: built });
    const a = pool.extract(html, 'https://x/');
    const b = pool.extract(html, 'https://x/');
    await pool.shutdown();
    pool = undefined;
    await expect(a).rejects.toThrow(/остановлен/);
    await expect(b).rejects.toThrow(/остановлен/);
  });
});
