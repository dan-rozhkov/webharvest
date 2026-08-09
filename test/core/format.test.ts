import { describe, it, expect } from 'vitest';
import { truncateMarkdown, formatScrape, formatSearch } from '../../src/core/format.js';

describe('truncateMarkdown', () => {
  it('не трогает короткий текст', () => {
    expect(truncateMarkdown('коротко', 100)).toEqual({ text: 'коротко', truncated: false, remaining: 0 });
  });

  it('режет по границе абзаца', () => {
    const md = 'Первый абзац.\n\nВторой абзац подлиннее.\n\nТретий.';
    const r = truncateMarkdown(md, 25);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('Первый абзац.');
    expect(r.remaining).toBe(md.length - r.text.length);
  });

  it('режет жёстко, если абзац один и он длинный', () => {
    const md = 'a'.repeat(100);
    const r = truncateMarkdown(md, 30);
    expect(r.text).toHaveLength(30);
    expect(r.truncated).toBe(true);
  });
});

describe('formatScrape', () => {
  const payload = {
    url: 'https://example.com/a', title: 'Заголовок',
    markdown: 'Тело статьи.', via: 'browser' as const, cached: true,
  };

  it('ставит заголовок, URL и метаданные в шапку', () => {
    const out = formatScrape(payload, 1000);
    expect(out).toContain('# Заголовок');
    expect(out).toContain('https://example.com/a');
    expect(out).toContain('via browser');
    expect(out).toContain('cached');
    expect(out).toContain('Тело статьи.');
  });

  it('не пишет cached, когда контент свежий', () => {
    expect(formatScrape({ ...payload, cached: false }, 1000)).not.toContain('cached');
  });

  it('сообщает об усечении явно', () => {
    const out = formatScrape({ ...payload, markdown: 'a'.repeat(500) }, 100);
    expect(out).toMatch(/обрезано|осталось/i);
  });

  it('добавляет ссылки, если они переданы', () => {
    const out = formatScrape({ ...payload, links: [{ href: 'https://example.com/b', text: 'Дальше' }] }, 1000);
    expect(out).toContain('https://example.com/b');
    expect(out).toContain('Дальше');
  });
});

describe('formatSearch', () => {
  it('нумерует результаты и показывает домен', () => {
    const out = formatSearch('vitest', [
      { url: 'https://vitest.dev/guide/', title: 'Getting Started', snippet: 'быстрый раннер', engine: 'brave' },
    ]);
    expect(out).toContain('1.');
    expect(out).toContain('Getting Started');
    expect(out).toContain('vitest.dev');
    expect(out).toContain('быстрый раннер');
  });

  it('включает содержимое, если оно догружено', () => {
    const out = formatSearch('q', [
      { url: 'https://a.com/', title: 'A', snippet: 's', engine: 'brave', content: 'полный текст страницы' },
    ]);
    expect(out).toContain('полный текст страницы');
  });

  it('показывает ошибку догрузки, не роняя выдачу', () => {
    const out = formatSearch('q', [
      { url: 'https://a.com/', title: 'A', snippet: 's', engine: 'brave', error: 'заблокировано cloudflare' },
    ]);
    expect(out).toContain('заблокировано cloudflare');
    expect(out).toContain('A');
  });

  it('честно сообщает о пустой выдаче', () => {
    expect(formatSearch('нечто', [])).toMatch(/ничего не найдено/i);
  });
});
