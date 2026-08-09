import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as extractorModule from '../../src/core/extractor.js';
import { createService } from '../../src/daemon/service.js';
import { loadConfig } from '../../src/daemon/config.js';

// Wraps the real extract() in a spy so we can count invocations across a
// full scrape() call, without changing its behaviour. Isolated to this file
// (vi.mock is file-scoped) so the rest of the suite is unaffected. vitest
// hoists this call above the imports above at transform time regardless of
// source position.
vi.mock('../../src/core/extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/extractor.js')>();
  return { ...actual, extract: vi.fn(actual.extract) };
});

let server: Server | undefined;
let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'webharvest-home-'));
  process.env.HOME = fakeHome;
  (extractorModule.extract as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  server?.close();
  server = undefined;
});

const cfg = () => loadConfig({ cachePath: ':memory:', searxngUrl: null, braveApiKey: null, allowPrivate: true });

const article = '<html><head><title>Тестовая</title></head><body><article><p>' + 'слово '.repeat(300) + '</p></article></body></html>';

async function serve(body: string): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe('scrape() reuses fetcher.fetch()\'s extraction probe', () => {
  it('вызывает extract() ровно один раз для прямого HTTP-пути (не эскалированного)', async () => {
    const base = await serve(article);
    const svc = createService(cfg());
    await svc.scrape({ url: base + '/' });
    await svc.shutdown();

    // Before the fix: fetcher.fetch() ran extract() once (as the escalation
    // probe) and service.scrape() ran it again on the same html — 2 calls.
    // After: service.scrape() reuses the probe's result — 1 call.
    expect(extractorModule.extract).toHaveBeenCalledTimes(1);
  });

  it('вызывает extract() ровно дважды для пути с эскалацией в браузер (проба HTTP + финальный браузерный HTML — не трижды)', async () => {
    const shell =
      '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script>' +
      'document.getElementById("root").innerHTML = "<article><h1>Заголовок</h1><p>" + "текст ".repeat(300) + "</p></article>";' +
      '</script></body></html>';
    const base = await serve(shell);
    const svc = createService(cfg());
    const r = await svc.scrape({ url: base + '/' });
    expect(r.via).toBe('browser');
    await svc.shutdown();

    // fetcher.fetch() itself unavoidably runs extract() twice on this path
    // (once on the thin HTTP shell to decide escalation, once on the final
    // browser html) — but service.scrape() must not add a third call on top.
    expect(extractorModule.extract).toHaveBeenCalledTimes(2);
  }, 30_000);
});
