import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createFetcher, DomainHints } from '../../src/core/fetcher.js';
import { DomainQueue } from '../../src/core/politeness.js';
import type { BrowserPool } from '../../src/core/browser.js';

// extract() runs 4 JSDOM/Readability/Defuddle passes - expensive, and
// pointless on a binary body that's about to be rejected as not_html
// anyway. Spying on the real module (rather than asserting behaviour
// indirectly) is the only way to prove the call never happens at all.
// vi.mock() calls (and vi.hoisted() blocks) are hoisted above these imports
// by vitest's transform, so createFetcher above already sees the mock.
const { extractSpy } = vi.hoisted(() => ({ extractSpy: vi.fn() }));
vi.mock('../../src/core/extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/extractor.js')>();
  extractSpy.mockImplementation(actual.extract);
  return { ...actual, extract: extractSpy };
});

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  extractSpy.mockClear();
});

async function serve(handler: (url: string) => { status?: number; type?: string; body: string }): Promise<string> {
  server = createServer((req, res) => {
    const { status = 200, type = 'text/html', body } = handler(req.url ?? '/');
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

function fakeBrowser(html: string): BrowserPool & { calls: number } {
  const pool = {
    calls: 0,
    async render(url: string) {
      pool.calls++;
      return { html, finalUrl: url, status: 200 };
    },
    async shutdown() {},
    isRunning: () => false,
  };
  return pool as BrowserPool & { calls: number };
}

const deps = (browser: BrowserPool) => ({
  queue: new DomainQueue({ minIntervalMs: 0 }),
  browser,
  hints: new DomainHints(),
  allowPrivate: true,
});

const article = '<html><body><article><h1>Заголовок</h1><p>' + 'текст '.repeat(200) + '</p></article></body></html>';

describe('createFetcher: content-type gate runs before extract()', () => {
  it('не запускает extract() вовсе на бинарном теле — вместо probe-затем-отбросить сразу бросает not_html', async () => {
    const bin = '%PDF-1.4 ' + 'x'.repeat(2000);
    const base = await serve(() => ({ type: 'application/pdf', body: bin }));
    const browser = fakeBrowser(article);
    const f = createFetcher(deps(browser));
    await expect(f.fetch(base + '/x.pdf')).rejects.toMatchObject({ code: 'not_html' });
    expect(extractSpy).not.toHaveBeenCalled();
    expect(browser.calls).toBe(0);
  });

  it('на обычном HTML extract() всё же вызывается (спай не тривиально проходит из-за отсутствия вызова вовсе)', async () => {
    const base = await serve(() => ({ body: article }));
    const browser = fakeBrowser(article);
    const f = createFetcher(deps(browser));
    const r = await f.fetch(base + '/');
    expect(r.via).toBe('http');
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });
});
