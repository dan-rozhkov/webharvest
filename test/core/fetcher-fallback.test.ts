import { describe, it, expect } from 'vitest';
import { createFetcher, DomainHints } from '../../src/core/fetcher.js';
import { DomainQueue } from '../../src/core/politeness.js';
import type { BrowserPool, RenderResult } from '../../src/core/browser.js';

type FakePool = BrowserPool & { calls: number };

function pool(respond: (url: string) => RenderResult | Error): FakePool {
  const p = {
    calls: 0,
    async render(url: string) {
      p.calls++;
      const r = respond(url);
      if (r instanceof Error) throw r;
      return r;
    },
    async shutdown() {},
    isRunning: () => false,
  };
  return p;
}

const page = (html: string, finalUrl?: string) => (url: string) => ({ html, finalUrl: finalUrl ?? url, status: 200 });

const article = '<html><body><article><h1>Заголовок</h1><p>' + 'текст '.repeat(200) + '</p></article></body></html>';
const short = '<html><body><article><h1>Заголовок</h1><p>' + 'текст '.repeat(30) + '</p></article></body></html>';
const empty = '<html><body><div id="root"></div></body></html>';
const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

// Публичный литерал IP + hint: fetch() сразу идёт в браузер, без сети и DNS.
const URL_ = 'http://93.184.216.34/page';

function fetcherWith(browser: BrowserPool, fallbackBrowser: BrowserPool, extra: { allowPrivate?: boolean } = {}) {
  const hints = new DomainHints();
  hints.markNeedsBrowser('93.184.216.34');
  return createFetcher({ queue: new DomainQueue({ minIntervalMs: 0 }), browser, fallbackBrowser, hints, ...extra });
}

describe('fetcher: фолбэк с основного движка рендера на запасной', () => {
  it('не зовёт запасной движок, если основной дал полноценный текст', async () => {
    const primary = pool(page(article));
    const fallback = pool(page(article));
    const r = await fetcherWith(primary, fallback).fetch(URL_);
    expect(r.via).toBe('browser');
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it('уходит на запасной, если основной упал', async () => {
    const primary = pool(() => new Error('Target.createTarget: TargetAlreadyLoaded'));
    const fallback = pool(page(article));
    const r = await fetcherWith(primary, fallback).fetch(URL_);
    expect(r.html).toContain('Заголовок');
    expect(fallback.calls).toBe(1);
  });

  it('уходит на запасной, если основной не дал текста', async () => {
    const primary = pool(page(empty));
    const fallback = pool(page(article));
    const r = await fetcherWith(primary, fallback).fetch(URL_);
    expect(r.html).toContain('Заголовок');
    expect(fallback.calls).toBe(1);
  });

  it('уходит на запасной, если основной упёрся в челлендж', async () => {
    const primary = pool(page(challenge));
    const fallback = pool(page(article));
    const r = await fetcherWith(primary, fallback).fetch(URL_);
    expect(r.html).toContain('Заголовок');
    expect(fallback.calls).toBe(1);
  });

  it('перепроверяет на запасном короткий текст основного, но принимает короткий текст запасного', async () => {
    const primary = pool(page(short));
    const fallback = pool(page(short));
    const r = await fetcherWith(primary, fallback).fetch(URL_);
    expect(r.html).toContain('Заголовок');
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
  });

  it('отдаёт ошибку запасного, если не справились оба', async () => {
    const primary = pool(() => new Error('lightpanda crashed'));
    const fallback = pool(page(challenge));
    await expect(fetcherWith(primary, fallback).fetch(URL_)).rejects.toMatchObject({ code: 'blocked' });
  });

  it('не повторяет рендер на запасном при SSRF-отказе по finalUrl основного', async () => {
    const primary = pool(page(article, 'http://169.254.169.254/evil'));
    const fallback = pool(page(article));
    await expect(fetcherWith(primary, fallback).fetch(URL_)).rejects.toMatchObject({ code: 'invalid_url' });
    expect(fallback.calls).toBe(0);
  });

  it('без запасного движка ведёт себя как раньше: короткий текст принимается', async () => {
    const primary = pool(page(short));
    const hints = new DomainHints();
    hints.markNeedsBrowser('93.184.216.34');
    const f = createFetcher({ queue: new DomainQueue({ minIntervalMs: 0 }), browser: primary, hints });
    const r = await f.fetch(URL_);
    expect(r.html).toContain('Заголовок');
    expect(primary.calls).toBe(1);
  });
});
