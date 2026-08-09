import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { shouldEscalate, detectChallenge } from '../../src/core/escalation.js';
import { extract } from '../../src/core/extractor.js';

const load = (id: string) => readFileSync(new URL(`../fixtures/${id}.html`, import.meta.url), 'utf8');
const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

const base = { status: 200, contentType: 'text/html; charset=utf-8' };

describe('shouldEscalate', () => {
  it('не эскалирует нормальную статью', () => {
    const fixture = load('wikipedia-web');
    const v = shouldEscalate({
      ...base,
      html: fixture,
      extractedTextLength: extract(fixture, 'https://x/').textLength,
    });
    expect(v).toEqual({ escalate: false, reason: null });
  });

  it('эскалирует SPA-оболочку', () => {
    const fixture = load('spa-shell');
    const v = shouldEscalate({ ...base, html: fixture, extractedTextLength: 12 });
    expect(v).toEqual({ escalate: true, reason: 'thin_spa' });
  });

  it('эскалирует страницу челленджа', () => {
    const fixture = load('cf-challenge');
    const v = shouldEscalate({ ...base, html: fixture, extractedTextLength: 80 });
    expect(v).toEqual({ escalate: true, reason: 'challenge' });
  });

  it.each([403, 429, 503])('эскалирует по статусу %i', (status) => {
    expect(
      shouldEscalate({ ...base, status, html: html('<p>nope</p>'), extractedTextLength: 4 }),
    ).toEqual({ escalate: true, reason: 'status' });
  });

  it('не эскалирует по 404 — страницы просто нет, браузер не поможет', () => {
    expect(
      shouldEscalate({ ...base, status: 404, html: html('<p>Not found</p>'), extractedTextLength: 9 })
        .escalate,
    ).toBe(false);
  });

  it('эскалирует при нетекстовом content-type', () => {
    expect(
      shouldEscalate({
        ...base,
        contentType: 'application/octet-stream',
        html: '',
        extractedTextLength: 0,
      }),
    ).toEqual({ escalate: true, reason: 'content_type' });
  });

  it('эскалирует при пустом body', () => {
    expect(
      shouldEscalate({ ...base, html: html('<div id="root"></div>'), extractedTextLength: 0 }),
    ).toEqual({ escalate: true, reason: 'empty_body' });
  });

  it('НЕ эскалирует короткую, но настоящую страницу без скриптов', () => {
    const short = html('<article><h1>Заметка</h1><p>' + 'слово '.repeat(20) + '</p></article>');
    expect(shouldEscalate({ ...base, html: short, extractedTextLength: 130 }).escalate).toBe(false);
  });

  it('эскалирует короткий текст при большом объёме скриптов', () => {
    const spa = html('<div id="app"></div><script>' + 'x'.repeat(40_000) + '</script>');
    expect(shouldEscalate({ ...base, html: spa, extractedTextLength: 20 })).toEqual({
      escalate: true,
      reason: 'thin_spa',
    });
  });

  it('называет челлендж, а не статус, когда защита ответила 403', () => {
    // Порядок значим: fetcher должен уметь назвать защиту в ошибке blocked.
    expect(
      shouldEscalate({ ...base, status: 403, html: load('cf-challenge'), extractedTextLength: 80 }),
    ).toEqual({ escalate: true, reason: 'challenge' });
  });

  it('оболочку со скриптами называет thin_spa, а не empty_body', () => {
    const scriptOnly = html('<div id="root"></div><script>var t = "много текста внутри";</script>');
    expect(shouldEscalate({ ...base, html: scriptOnly, extractedTextLength: 0 })).toEqual({
      escalate: true,
      reason: 'thin_spa',
    });
  });
});

/**
 * Главная проверка задачи: пороги обязаны быть верны на всех десяти фикстурах,
 * а не только на тех, что названы поимённо. Ложное срабатывание стоит секунд
 * Chromium на каждой странице, пропуск — молча урезанного контента.
 */
describe('shouldEscalate на всех фикстурах', () => {
  const expected: Record<string, boolean> = {
    'wikipedia-web': false,
    'mdn-fetch': false,
    'nodejs-blog': false,
    'github-repo': false,
    'vitest-docs': false,
    'playwright-docs': false,
    'hn-front': false,
    'spa-shell': true,
    'substack-post': true,
    'cf-challenge': true,
  };

  for (const [id, escalate] of Object.entries(expected)) {
    it(`${id} → escalate=${escalate}`, () => {
      const fixture = load(id);
      const textLength = extract(fixture, 'https://example.com/').textLength;
      const v = shouldEscalate({ ...base, html: fixture, extractedTextLength: textLength });
      expect(v.escalate).toBe(escalate);
    });
  }

  it('hn-front проходит с запасом по обеим осям, а не впритык', () => {
    const fixture = load('hn-front');
    const textLength = extract(fixture, 'https://news.ycombinator.com/').textLength;
    const scripts = (fixture.match(/<script[\s\S]*?<\/script>/gi) ?? []).reduce(
      (s, x) => s + x.length,
      0,
    );
    // Листинг даёт меньше текста, чем статья: порог худобы (2000) он проходит
    // почти вдвое, а перекос в скрипты (x40) — на три порядка.
    expect(textLength).toBeGreaterThan(3500);
    expect(scripts).toBeLessThan(textLength);
  });

  it('spa-shell зовётся оболочкой, а не пустым ответом', () => {
    const fixture = load('spa-shell');
    expect(shouldEscalate({ ...base, html: fixture, extractedTextLength: 0 })).toEqual({
      escalate: true,
      reason: 'thin_spa',
    });
  });

  it('substack-post эскалирует именно как оболочка', () => {
    const fixture = load('substack-post');
    const textLength = extract(fixture, 'https://astralcodexten.substack.com/archive').textLength;
    expect(shouldEscalate({ ...base, html: fixture, extractedTextLength: textLength })).toEqual({
      escalate: true,
      reason: 'thin_spa',
    });
  });
});

describe('detectChallenge', () => {
  it('узнаёт Cloudflare', () => {
    expect(detectChallenge(load('cf-challenge'))).toBe('cloudflare');
  });

  it('узнаёт DataDome', () => {
    expect(detectChallenge(html('<script src="https://js.datadome.co/tags.js"></script>'))).toBe(
      'datadome',
    );
  });

  it('узнаёт PerimeterX', () => {
    expect(detectChallenge(html('<div id="px-captcha"></div>'))).toBe('perimeterx');
  });

  it('узнаёт Akamai', () => {
    expect(
      detectChallenge(html('<script>bmak.startTracking("/akam/13/1f2e3d4c");</script>')),
    ).toBe('akamai');
  });

  it('возвращает null на обычной странице', () => {
    expect(detectChallenge(load('wikipedia-web'))).toBeNull();
  });

  it('не срабатывает на статью, упоминающую Cloudflare в тексте', () => {
    expect(
      detectChallenge(
        html(
          '<article><p>Мы переехали на Cloudflare в прошлом году. Just a moment, подумали мы.</p></article>',
        ),
      ),
    ).toBeNull();
  });

  it('не срабатывает на длинную статью, где маркеры упомянуты в теле', () => {
    // Маркеры лежат далеко за пределами head, в видимом тексте — это статья про защиты.
    const body =
      '<article>' +
      '<p>' + 'Обычный абзац про веб. '.repeat(400) + '</p>' +
      '<p>Скрипт грузится с client.perimeterx.net, а кука называется _abck=.</p>' +
      '<p>Cloudflare ставит window._cf_chl_opt и id="px-captcha".</p>' +
      '</article>';
    expect(detectChallenge(html(body))).toBeNull();
  });

  it('возвращает null на всех фикстурах с настоящим контентом', () => {
    for (const id of ['mdn-fetch', 'nodejs-blog', 'github-repo', 'vitest-docs', 'playwright-docs', 'hn-front', 'substack-post']) {
      expect(detectChallenge(load(id)), id).toBeNull();
    }
  });
});
