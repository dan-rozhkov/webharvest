/**
 * Бюджет ожидания челленджа в doRender обязан оставлять хвост на то, что
 * идёт ПОСЛЕ ожидания: второй networkidle (до 1000мс), settle (300мс) и
 * page.content(). Без резерва ожидание доедало бюджет до самого timeout,
 * внешняя гонка в render() (timeout + 1500) успевала сработать первой — и
 * вызывающий получал 'timeout' вместо HTML челленджа, по которому fetcher
 * распознаёт 'blocked' и имя защиты.
 *
 * Проверяем именно арифметику бюджета на шве, а не по секундомеру: разница
 * там измеряется сотнями миллисекунд, и wall-clock-тест был бы флаки в обе
 * стороны.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

const budgets: number[] = [];
vi.mock('../../src/core/challenge.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/core/challenge.js')>();
  return {
    ...actual,
    waitForChallengeResolution: (page: never, opts: { timeoutMs: number }) => {
      budgets.push(opts.timeoutMs);
      return actual.waitForChallengeResolution(page, opts);
    },
  };
});

import type { BrowserPool } from '../../src/core/browser.js';

const { createBrowserPool } = await import('../../src/core/browser.js');

let server: Server | undefined;
let pool: BrowserPool | undefined;

afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
  server?.close();
  server = undefined;
  budgets.length = 0;
});

async function serveChallenge(): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<html><head><title>Just a moment...</title></head>
       <body><div id="challenge-stage">проверяем браузер</div></body></html>`,
    );
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}/`;
}

describe('бюджет ожидания челленджа', () => {
  it('оставляет хвост на content() и возвращает HTML челленджа, а не timeout', async () => {
    const url = await serveChallenge();
    pool = createBrowserPool({ idleTimeoutMs: 60_000 });
    const timeoutMs = 6_000;

    const r = await pool.render(url, { timeoutMs });

    // HTML челленджа доехал до вызывающего — именно его разбирает fetcher.
    expect(r.html).toContain('challenge-stage');
    // Бюджет ожидания урезан минимум на резерв (2с) от остатка timeout —
    // без вычета здесь было бы ~timeout минус время навигации.
    expect(budgets).toHaveLength(1);
    expect(budgets[0]!).toBeLessThanOrEqual(timeoutMs - 2_000);
  });
});
