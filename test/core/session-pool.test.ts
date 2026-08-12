import { describe, it, expect, vi, afterEach } from 'vitest';

// Настоящий Chromium подменяется целиком: этот файл проверяет только
// оркестрацию самого пула (периодический sweepIdle-таймер и его остановку
// на shutdown), и ей не нужен реальный браузер. Мок позволяет использовать
// vi.useFakeTimers() без риска зависнуть на внутренних setTimeout настоящего
// Playwright/Chromium (см. test/live/session-pool.test.ts, где ровно это и
// происходит — оттого те тесты идут на настоящем времени).
const fakePage = () => ({
  goto: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  url: () => 'about:blank',
});

const fakeContext = () => ({
  newPage: vi.fn(async () => fakePage()),
  close: vi.fn(async () => {}),
  addInitScript: vi.fn(async () => {}),
});

const fakeBrowser = () => ({
  newContext: vi.fn(async () => fakeContext()),
  close: vi.fn(async () => {}),
});

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => fakeBrowser()),
  },
}));

const { chromium } = await import('playwright');
const { createSessionPool } = await import('../../src/core/session-pool.js');
type SessionPool = ReturnType<typeof createSessionPool>;

let pool: SessionPool | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await pool?.shutdown();
  pool = undefined;
});

describe('createSessionPool: периодический sweep простаивающих сессий', () => {
  it('снимает простаивающую сессию по таймеру, без нового open()/get() к ней', async () => {
    // Раньше sweepIdle() запускался только изнутри open() — сессия, которую
    // никто больше не трогал (краш агента, брошенный диалог), висела до
    // конца работы демона. Периодический таймер обязан снимать её сам,
    // независимо от того, обращается ли кто-то к пулу вообще.
    vi.useFakeTimers();
    pool = createSessionPool({ idleTimeoutMs: 200 });
    const s = await pool.open('http://example.test/');
    // open() отдаёт сессию занятой (см. JSDoc InternalSession.busy) — в
    // реальном демоне daemon/service.ts снимает занятость сразу перед тем,
    // как вернуть sessionId вызывающему агенту (см. withSession/release() в
    // service.ts). Здесь эмулируем ровно это: агент получил id и "ушёл
    // навсегда" — с этого момента сессия свободна и уязвима для sweep.
    pool.release(s.id);
    expect(pool.count()).toBe(1);

    // Интервал сам равен idleTimeoutMs, так что первый тик приходится ровно
    // на момент истечения простоя (граница `lastUsedAt < deadline` там ещё
    // не строго пройдена) — сессия гарантированно снимается не позже
    // второго тика, т.е. в пределах ~2×idleTimeoutMs (см. комментарий в
    // session-pool.ts у sweepTimer). Продвигаем время за этот предел.
    vi.advanceTimersByTime(2 * 200 + 50);
    // drop() внутри колбэка таймера асинхронный (await page.close()) — даём
    // микротаскам, на которых резолвится замоканный close(), прогнаться.
    await Promise.resolve();
    await Promise.resolve();

    expect(pool.count()).toBe(0);
    expect(() => pool!.get(s.id)).toThrow();
  });

  it('не снимает сессию, к которой недавно обращались (get() продлевает жизнь)', async () => {
    vi.useFakeTimers();
    pool = createSessionPool({ idleTimeoutMs: 200 });
    const s = await pool.open('http://example.test/');
    pool.release(s.id); // см. комментарий в предыдущем тесте

    vi.advanceTimersByTime(150);
    pool.get(s.id); // продлевает lastUsedAt (и помечает сессию занятой)
    pool.release(s.id); // действие сразу завершилось — снова свободна
    vi.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();

    // 150+150 = 300 > idleTimeoutMs (200) от момента open(), но от момента
    // get() прошло только 150 — сессия должна пережить этот тик.
    expect(pool.count()).toBe(1);
  });

  it('не снимает по таймеру занятую сессию, даже если её действие идёт дольше idleTimeoutMs', async () => {
    // Находка код-ревью: раньше lastUsedAt/seq обновлялись только на входе в
    // использование сессии, поэтому таймер простоя мог закрыть страницу
    // прямо во время выполняющегося действия, если оно просто заняло больше
    // idleTimeoutMs. `busy` — источник истины поверх lastUsedAt для sweep.
    vi.useFakeTimers();
    pool = createSessionPool({ idleTimeoutMs: 200 });
    const s = await pool.open('http://example.test/');
    pool.get(s.id); // имитирует начало действия — сессия занята, release() ещё не вызван

    vi.advanceTimersByTime(3 * 200 + 50);
    await Promise.resolve();
    await Promise.resolve();

    expect(pool.count()).toBe(1);
    expect(() => pool!.get(s.id)).not.toThrow();

    pool.release(s.id);
    vi.advanceTimersByTime(2 * 200 + 50);
    await Promise.resolve();
    await Promise.resolve();
    // Как только действие завершилось (release), простой снова считается —
    // и сессия снимается на следующем тике.
    expect(pool.count()).toBe(0);
  });

  it('останавливает таймер на shutdown — advanceTimersByTime после него не обращается к уже закрытому пулу', async () => {
    vi.useFakeTimers();
    pool = createSessionPool({ idleTimeoutMs: 200 });
    await pool.open('http://example.test/');
    await pool.shutdown();

    // Если бы clearInterval() не вызывался, следующий тик попытался бы
    // пройтись по уже пустой (но не факт, что безопасной) карте сессий —
    // сам факт, что это не бросает и не виснет, и есть проверка.
    expect(() => vi.advanceTimersByTime(10 * 60_000)).not.toThrow();
  });
});

describe('createSessionPool: вытеснение не трогает занятую сессию', () => {
  it('вытесняет самую давнюю СВОБОДНУЮ сессию, а не занятую с меньшим seq', async () => {
    // Находка код-ревью: evictOldest() раньше выбирал жертву просто по
    // наименьшему seq среди ВСЕХ сессий — шестой параллельный open() мог
    // закрыть страницу, которую прямо сейчас использует чужое действие.
    pool = createSessionPool({ maxSessions: 2 });
    const a = await pool.open('http://example.test/a');
    pool.release(a.id);
    const b = await pool.open('http://example.test/b');
    pool.release(b.id);

    // `a` — самая давняя по seq. Помечаем её занятой (имитация действия в
    // процессе) и не освобождаем: жертвой обязана стать `b`, а не `a`.
    pool.get(a.id);

    const c = await pool.open('http://example.test/c');
    pool.release(c.id);

    expect(pool.count()).toBe(2);
    expect(() => pool!.get(b.id)).toThrow(); // b вытеснена
    expect(() => pool!.get(a.id)).not.toThrow(); // a пережила вытеснение — она была занята
  });

  it('честно отказывает (код busy), если пул заполнен и вытеснять нечего — все сессии заняты', async () => {
    // Вторая половина той же находки: молчаливый фолбэк (открыть сверх
    // maxSessions или тихо выбрать занятую жертву) недопустим — вызывающий
    // должен получить явную причину отказа, а не загадочный not_found или
    // timeout чуть позже.
    pool = createSessionPool({ maxSessions: 1 });
    const a = await pool.open('http://example.test/a');
    // `a` остаётся занятой — release() намеренно не вызываем.
    void a;

    await expect(pool.open('http://example.test/b')).rejects.toMatchObject({ code: 'busy' });
    expect(pool.count()).toBe(1); // не открыла шестую (здесь — вторую) сессию поверх лимита
  });
});

describe('createSessionPool: ensureContext закрывает Chromium, если newContext() падает', () => {
  it('закрывает уже запущенный процесс браузера при сбое newContext(), а не оставляет его без владельца', async () => {
    // Находка код-ревью: chromium.launch() успешно отрабатывало в локальную
    // переменную b, но b.newContext(...) падало — b нигде не закрывался и
    // ссылка на него терялась вместе с этим catch, так что процесс Chromium
    // жил до перезапуска демона, а следующий open() запускал ещё один.
    const closeBrowser = vi.fn(async () => {});
    const failingBrowser = {
      newContext: vi.fn(async () => {
        throw new Error('newContext упал (смоделированный сбой)');
      }),
      close: closeBrowser,
    };
    vi.mocked(chromium.launch).mockClear();
    vi.mocked(chromium.launch).mockImplementationOnce(async () => failingBrowser as never);

    pool = createSessionPool();
    await expect(pool.open('http://example.test/')).rejects.toThrow('newContext упал');
    expect(closeBrowser).toHaveBeenCalledTimes(1);

    // Следующий open() не должен залипнуть на мёртвом b: launch() вызывается
    // заново (с дефолтным успешным fakeBrowser из mock-фабрики выше) и
    // открывает сессию как обычно.
    const s = await pool.open('http://example.test/');
    expect(s.id).toMatch(/^s_/);
    expect(chromium.launch).toHaveBeenCalledTimes(2);
  });
});

describe('createSessionPool: stealth применяется к каждому новому контексту', () => {
  it('вызывает addInitScript при открытии сессии (applyStealth из stealth.js)', async () => {
    // Раньше усиленный init-скрипт жил только в browser.ts — сессии browser use
    // открывались без него и светились перед Turnstile. Теперь оба пула зовут
    // applyStealth() из общего модуля, и здесь мы проверяем, что session-pool
    // действительно прокидывает скрипт в контекст, который вернул newContext.
    // БЕЗ fake timers (в отличие от тестов выше): этот тест не продвигает
    // время, а только проверяет оркестрацию, и реальные таймеры тут безопасны.
    vi.mocked(chromium.launch).mockClear();
    pool = createSessionPool();
    const s = await pool.open('http://example.test/');
    expect(s.id).toMatch(/^s_/);
    const ctx = await vi.mocked(chromium.launch).mock.results[0]!.value;
    const context = await (ctx as { newContext: ReturnType<typeof vi.fn> }).newContext.mock.results[0]!.value;
    expect((context as { addInitScript: ReturnType<typeof vi.fn> }).addInitScript).toHaveBeenCalledTimes(1);
  });
});
