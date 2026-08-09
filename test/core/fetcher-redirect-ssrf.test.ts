import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

// Проверяет, что редирект пере-валидируется на SSRF так же строго, как исходный
// URL. Реальный тест через loopback-сервер тут невозможен: единственный
// доступный тестам сервер живёт на 127.0.0.1, который сам по себе приватный, а
// значит требует allowPrivate: true — но этот флаг отключает всю SSRF-проверку
// целиком (и для входного URL, и для хопов редиректа), так что показать "вход
// разрешён, а редирект на приватный адрес — нет" в одном сквозном HTTP-тесте не
// получится. Вместо этого мокаем undici.request: вход — публичный литерал IP
// (без сети, т.к. это не DNS-имя, и без реального сокета, т.к. request мокнут),
// а он отвечает 302 на 169.254.169.254 — метаданные облака.
const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...args: unknown[]) => requestMock(...args) }));

function emptyBody(): Readable {
  const r = new Readable({ read() {} });
  r.push(null);
  return r;
}

describe('createFetcher: SSRF на редиректе', () => {
  it('отклоняет редирект на приватный адрес, не делая второй запрос', async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      body: emptyBody(),
    });

    const { createFetcher, DomainHints } = await import('../../src/core/fetcher.js');
    const { DomainQueue } = await import('../../src/core/politeness.js');
    const browser = {
      calls: 0,
      async render(url: string) {
        browser.calls++;
        return { html: '<html></html>', finalUrl: url, status: 200 };
      },
      async shutdown() {},
      isRunning: () => false,
    };

    const f = createFetcher({
      queue: new DomainQueue({ minIntervalMs: 0 }),
      browser,
      hints: new DomainHints(),
      // allowPrivate НЕ установлен: это и есть проверяемый прод-путь.
    });

    await expect(f.fetch('http://93.184.216.34/start')).rejects.toMatchObject({ code: 'invalid_url' });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(browser.calls).toBe(0);
  });
});
