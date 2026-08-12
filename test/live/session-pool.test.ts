import { describe, it, expect, afterEach } from 'vitest';
import { createSessionPool, type SessionPool } from '../../src/core/session-pool.js';
import { HarvestError } from '../../src/core/errors.js';

const live = process.env.WEBHARVEST_LIVE === '1' ? describe : describe.skip;

// Без `;charset=utf-8` Chromium декодирует data:-URL как Latin-1, и кириллица
// превращается в мусор — это никак не связано с самим пулом сессий.
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent('<html><body><h1 id="t">привет</h1></body></html>')}`;

live('session-pool', () => {
  let pool: SessionPool | undefined;

  afterEach(async () => {
    await pool?.shutdown();
    pool = undefined;
  });

  it('открывает сессию и отдаёт живую страницу', async () => {
    pool = createSessionPool();
    const s = await pool.open(PAGE);
    expect(s.id).toMatch(/^s_/);
    expect(await s.page.textContent('#t')).toBe('привет');
  });

  it('сохраняет состояние страницы между обращениями', async () => {
    pool = createSessionPool();
    const s = await pool.open(PAGE);
    await s.page.evaluate(() => {
      document.querySelector('#t')!.textContent = 'изменено';
    });
    const again = pool.get(s.id);
    expect(await again.page.textContent('#t')).toBe('изменено');
  });

  it('бросает not_found на неизвестный id', () => {
    pool = createSessionPool();
    expect(() => pool!.get('s_нет')).toThrow(HarvestError);
  });

  it('после close сессия недоступна', async () => {
    pool = createSessionPool();
    const s = await pool.open(PAGE);
    await pool.close(s.id);
    expect(() => pool!.get(s.id)).toThrow(HarvestError);
    expect(pool.count()).toBe(0);
  });

  it('вытесняет самую давнюю сессию при переполнении', async () => {
    pool = createSessionPool({ maxSessions: 2 });
    const a = await pool.open(PAGE);
    const b = await pool.open(PAGE);
    // Трогаем `a`, чтобы жертвой стала именно `b`.
    pool.get(a.id);
    await pool.open(PAGE);
    expect(pool.count()).toBe(2);
    expect(() => pool!.get(b.id)).toThrow(HarvestError);
    expect(() => pool!.get(a.id)).not.toThrow();
  });

  it('закрывает всё по shutdown', async () => {
    pool = createSessionPool();
    await pool.open(PAGE);
    await pool.open(PAGE);
    await pool.shutdown();
    expect(pool.count()).toBe(0);
  });
});
