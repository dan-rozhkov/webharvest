import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

// Проверяет, что хост, чей слот очереди уже был ОТПУЩЕН где-то в середине
// цепочки редиректов, при повторном визите позже в той же цепочке снова
// встаёт в очередь — а не просто "когда-либо встречался в этой цепочке".
// Мокаем undici.request, чтобы управлять всей цепочкой a → b → c → b без
// реальной сети (никакой из этих хостов не обязан существовать) и без
// зависимости от алиасов loopback-хоста, которых в этом окружении доступно
// только два (127.0.0.1 и localhost) — здесь нужно три разных имени.
const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...args: unknown[]) => requestMock(...args) }));

function emptyBody(): Readable {
  const r = new Readable({ read() {} });
  r.push(null);
  return r;
}

function bodyOf(text: string): Readable {
  const r = new Readable({ read() {} });
  r.push(Buffer.from(text));
  r.push(null);
  return r;
}

function redirect(location: string) {
  return { statusCode: 302, headers: { location }, body: emptyBody() };
}

function html(body: string) {
  return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: bodyOf(body) };
}

const article = '<html><body><article><h1>Заголовок</h1><p>' + 'текст '.repeat(200) + '</p></article></body></html>';

describe('createFetcher: очередь при не-соседнем повторном визите хоста', () => {
  it('ставит хост b в очередь дважды в цепочке a → b → c → b, а не только при первом визите', async () => {
    requestMock
      .mockResolvedValueOnce(redirect('http://b.example/hop'))
      .mockResolvedValueOnce(redirect('http://c.example/hop'))
      .mockResolvedValueOnce(redirect('http://b.example/final'))
      .mockResolvedValueOnce(html(article));

    const { createFetcher, DomainHints } = await import('../../src/core/fetcher.js');
    const browser = {
      calls: 0,
      async render(url: string) {
        browser.calls++;
        return { html: article, finalUrl: url, status: 200 };
      },
      async shutdown() {},
      isRunning: () => false,
    };

    const calls: string[] = [];
    const queue = { run: async (host: string, fn: () => Promise<unknown>) => { calls.push(host); return fn(); } };

    const f = createFetcher({
      queue: queue as unknown as import('../../src/core/politeness.js').DomainQueue,
      browser,
      hints: new DomainHints(),
      allowPrivate: true,
    });

    const r = await f.fetch('http://a.example/start');
    expect(r.via).toBe('http');
    expect(r.finalUrl).toBe('http://b.example/final');

    // a — исходный хост, его слот держит сам fetch() на всё время операции
    // (не через withHostQueue, поэтому он не пере-встаёт в очередь при
    // повторных визитах — это отдельная, намеренная семантика). c встаёт
    // в очередь один раз. b должен встать в очередь ДВАЖДЫ: первый раз на
    // хопе 2, и снова на хопе 4 — к этому моменту слот b с хопа 2 уже
    // отпущен (тот queue.run уже вернулся до начала хопа 3), так что это
    // не самозаклинивание, а обычный повторный, честно ограничиваемый визит.
    expect(calls).toEqual(['a.example', 'b.example', 'c.example', 'b.example']);
  });
});
