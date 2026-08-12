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
    pool.release(a.id);
    const b = await pool.open(PAGE);
    pool.release(b.id);
    // Трогаем `a`, чтобы жертвой стала именно `b`.
    pool.get(a.id);
    pool.release(a.id);
    await pool.open(PAGE);
    expect(pool.count()).toBe(2);
    expect(() => pool!.get(b.id)).toThrow(HarvestError);
    expect(() => pool!.get(a.id)).not.toThrow();
  });

  it('не вытесняет занятую сессию при переполнении — вытесняется свободная, даже если она моложе', async () => {
    // Находка код-ревью: evictOldest() раньше выбирал жертву просто по
    // наименьшему seq среди ВСЕХ сессий, не глядя на то, использует ли её
    // прямо сейчас чьё-то действие.
    pool = createSessionPool({ maxSessions: 2 });
    const a = await pool.open(PAGE);
    pool.release(a.id);
    const b = await pool.open(PAGE);
    pool.release(b.id);

    // `a` — самая давняя по seq. Помечаем её занятой (имитация действия в
    // процессе, get() без парного release()) — жертвой обязана стать `b`.
    pool.get(a.id);
    await pool.open(PAGE);

    expect(pool.count()).toBe(2);
    expect(() => pool!.get(b.id)).toThrow(HarvestError);
    expect(() => pool!.get(a.id)).not.toThrow();
  });

  it('честно отказывает (код busy), если пул заполнен и вытеснять нечего — все сессии заняты', async () => {
    pool = createSessionPool({ maxSessions: 1 });
    await pool.open(PAGE); // остаётся занятой — release() намеренно не вызываем

    const err = await pool.open(PAGE).catch((e) => e);
    expect(err).toBeInstanceOf(HarvestError);
    expect((err as HarvestError).code).toBe('busy');
    expect(pool.count()).toBe(1);
  });

  it('закрывает всё по shutdown', async () => {
    pool = createSessionPool();
    await pool.open(PAGE);
    await pool.open(PAGE);
    await pool.shutdown();
    expect(pool.count()).toBe(0);
  });

  it('снимает простаивающую сессию по периодическому таймеру, без нового open()/get()', async () => {
    // Раньше sweepIdle() вызывался только изнутри open() — сессия, которую
    // никто больше не открывал/трогал (краш агента, брошенный диалог),
    // оставалась жить до конца работы демона. Таймер обязан снимать её сам.
    //
    // Настоящие таймеры, а не vi.useFakeTimers(): setInterval() внутри
    // createSessionPool() запускается поверх реального Chromium (запуск
    // процесса, CDP-соединение), который где-то внутри сам полагается на
    // реальные setTimeout — под фейковыми таймерами (даже с
    // shouldAdvanceTime: true) он зависает непредсказуемо. idleTimeoutMs
    // нарочно маленький (200ms), чтобы дождаться реального тика без
    // раздувания времени теста.
    pool = createSessionPool({ idleTimeoutMs: 200 });
    const s = await pool.open(PAGE);
    // open() отдаёт сессию занятой (см. JSDoc InternalSession.busy в
    // session-pool.ts) — в реальном демоне daemon/service.ts снимает
    // занятость сразу перед тем, как вернуть sessionId вызывающему агенту.
    // Эмулируем ровно это: агент получил id и "ушёл навсегда" — с этого
    // момента сессия свободна и уязвима для sweep, как и было в этом тесте
    // до появления busy-флага.
    pool.release(s.id);
    expect(pool.count()).toBe(1);

    // Ждём дольше одного периода интервала (== idleTimeoutMs) — без единого
    // обращения к open()/get() к этой сессии.
    await new Promise((r) => setTimeout(r, 500));

    expect(pool.count()).toBe(0);
    expect(() => pool!.get(s.id)).toThrow(HarvestError);
  });

  it('останавливает таймер при shutdown — не мешает завершению процесса/тестов', async () => {
    pool = createSessionPool({ idleTimeoutMs: 200 });
    await pool.open(PAGE);
    await pool.shutdown();
    // unref() уже гарантирует, что таймер не держит процесс живым сам по
    // себе, но явная остановка на shutdown — то же поведение, что у
    // purgeTimer в daemon/service.ts, и оно не должно приводить к обращению
    // к уже закрытому браузеру/контексту на следующем тике интервала.
    await new Promise((r) => setTimeout(r, 500));
    // Ничего не бросило и не зависло — тест сам по себе и есть проверка.
  });
});
