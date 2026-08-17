import { describe, it, expect, vi } from 'vitest';
import { isChallengeActive, waitForChallengeResolution, clickTurnstileCheckbox } from '../../src/core/challenge.js';

/**
 * Локейтор-мок с полной цепочкой вызовов, которой пользуется боевой код:
 * count() (для isChallengeActive), first() + boundingBox() (для мышиного
 * фолбэка clickTurnstileCheckbox). first() возвращает сам себя — как
 * настоящий Playwright-Locator, где .first() это тот же локейтор с
 * суженным выбором.
 */
function fakeLocator(overrides: Record<string, unknown> = {}) {
  const loc = {
    count: vi.fn(async () => 0),
    first: vi.fn(() => loc),
    boundingBox: vi.fn(async () => ({ x: 10, y: 10, width: 300, height: 65 })),
    ...overrides,
  };
  return loc;
}

function fakePage(overrides: Record<string, unknown> = {}) {
  return {
    locator: vi.fn(() => fakeLocator()),
    frameLocator: vi.fn(() => ({
      locator: vi.fn(() => ({ first: vi.fn(() => ({ click: vi.fn(async () => {}) })) })),
    })),
    title: vi.fn(async () => 'Test Page'),
    isClosed: vi.fn(() => false),
    mouse: { click: vi.fn(async () => {}) },
    waitForTimeout: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

/**
 * waitForTimeout, который реально ждёт 500мс по виртуальным таймерам
 * (setTimeout под vi.useFakeTimers). Без этого цикл ожидания в
 * waitForChallengeResolution крутился бы вплотную микротасками, и
 * advanceTimersByTimeAsync не успевал бы двигать часы между итерациями.
 */
const pacedWaitForTimeout = () => vi.fn(() => new Promise<void>((r) => setTimeout(r, 500)));

describe('isChallengeActive', () => {
  it('false на обычной странице', async () => {
    const page = fakePage();
    expect(await isChallengeActive(page)).toBe(false);
  });

  it('false при наличии только встроенного Turnstile-виджета (без маркеров блокирующего челленджа)', async () => {
    // Находка ревью: iframe turnstile / #cf-turnstile / #turnstile-wrapper есть
    // и у обычного виджета формы (логин/контакт), а не только у блокирующего
    // челленджа. Виджет никуда не исчезает — если считать его челленджем,
    // ожидание сжигало бы весь бюджет на каждой легитимной странице с формой.
    const page = fakePage({
      locator: vi.fn((sel: string) =>
        fakeLocator({ count: vi.fn(async () => (sel.includes('turnstile') ? 1 : 0)) }),
      ),
    });
    expect(await isChallengeActive(page)).toBe(false);
  });

  it('true при наличии маркера блокирующего челленджа (#challenge-stage)', async () => {
    const page = fakePage({
      locator: vi.fn((sel: string) =>
        fakeLocator({ count: vi.fn(async () => (sel.includes('challenge-stage') ? 1 : 0)) }),
      ),
    });
    expect(await isChallengeActive(page)).toBe(true);
  });

  it('true по заголовку "Just a moment"', async () => {
    const page = fakePage({ title: vi.fn(async () => 'Just a moment...') });
    expect(await isChallengeActive(page)).toBe(true);
  });

  it('пробрасывает ошибку закрытой страницы, а не трактует её как «челленджа нет»', async () => {
    // Находка ревью: раньше try/catch глотал и «Target page/context has been
    // closed» при конкурентном shutdown/eviction — isChallengeActive возвращал
    // false, и open() отдавал агенту мёртвую сессию. Закрытая страница — это
    // реальная ошибка, её надо пробросить выше.
    const boom = new Error('Target page, context or browser has been closed');
    const page = fakePage({
      isClosed: vi.fn(() => true),
      locator: vi.fn(() => ({ count: vi.fn(async () => { throw boom; }) })),
    });
    await expect(isChallengeActive(page)).rejects.toThrow(boom);
  });
});

describe('waitForChallengeResolution', () => {
  it('мгновенно возвращает true, если челленджа нет', async () => {
    const page = fakePage();
    await expect(waitForChallengeResolution(page, { timeoutMs: 5000 })).resolves.toBe(true);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('возвращает false, если челлендж не решился за timeout', async () => {
    // Без fake timers: челлендж «висит» вечно, цикл крутится реальные 50мс
    // и упирается в дедлайн — waitForTimeout-мок резолвится мгновенно.
    const page = fakePage({
      locator: vi.fn(() => fakeLocator({ count: vi.fn(async () => 1) })),
    });
    await expect(waitForChallengeResolution(page, { timeoutMs: 50 })).resolves.toBe(false);
  });

  it('ждёт, пока челлендж исчезнет, и возвращает true', async () => {
    vi.useFakeTimers();
    try {
      let activeChecks = 0;
      const page = fakePage({
        locator: vi.fn((sel: string) =>
          fakeLocator({
            // Первый вызов isChallengeActive видит челлендж (#challenge-stage —
            // маркер блокирующего челленджа), второй — уже нет: счётчик тикает
            // только на этом селекторе, до которого цикл доходит в каждом
            // вызове isChallengeActive.
            count: vi.fn(async () => {
              if (sel.includes('challenge-stage')) return activeChecks++ === 0 ? 1 : 0;
              return 0;
            }),
          }),
        ),
        waitForTimeout: pacedWaitForTimeout(),
      });
      const p = waitForChallengeResolution(page, { timeoutMs: 60_000 });
      // Продвигаем на две итерации цикла (500мс × 2): первая видит челлендж,
      // вторая — уже чистую страницу.
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('кликает чекбокс Turnstile, если виджет не исчез за 4с', async () => {
    vi.useFakeTimers();
    try {
      const page = fakePage({
        locator: vi.fn(() => fakeLocator({ count: vi.fn(async () => 1) })),
        // Внутренний клик по чекбоксу во фрейме недоступен (cross-origin
        // frameLocator не дал элемента) — код обязан упасть на мышиный фолбэк.
        frameLocator: vi.fn(() => ({
          locator: vi.fn(() => ({
            first: vi.fn(() => ({ click: vi.fn(async () => { throw new Error('фрейм недоступен'); }) })),
          })),
        })),
        waitForTimeout: pacedWaitForTimeout(),
      });
      const p = waitForChallengeResolution(page, { timeoutMs: 60_000 });
      // Докручиваем до 4.5с: виджет всё ещё на странице, цикл обязан один раз
      // кликнуть по чекбоксу (мышиный фолбэк).
      await vi.advanceTimersByTimeAsync(4500);
      expect(page.mouse.click).toHaveBeenCalled();
      // Дожимаем до дедлайна, чтобы цикл ожидания завершился, а не висел.
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(p).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clickTurnstileCheckbox', () => {
  it('не делает ничего без виджета', async () => {
    const page = fakePage();
    await clickTurnstileCheckbox(page);
    expect(page.mouse.click).not.toHaveBeenCalled();
  });

  it('кликает чекбокс внутри фрейма, когда он доступен', async () => {
    const frameClick = vi.fn(async () => {});
    const page = fakePage({
      locator: vi.fn(() => fakeLocator({ count: vi.fn(async () => 1) })),
      frameLocator: vi.fn(() => ({
        locator: vi.fn(() => ({ first: vi.fn(() => ({ click: frameClick })) })),
      })),
    });
    await clickTurnstileCheckbox(page);
    expect(frameClick).toHaveBeenCalled();
    expect(page.mouse.click).not.toHaveBeenCalled();
  });

  it('падает на мышиный клик, если чекбокс во фрейме недоступен', async () => {
    const page = fakePage({
      locator: vi.fn(() => fakeLocator({ count: vi.fn(async () => 1) })),
      frameLocator: vi.fn(() => ({
        locator: vi.fn(() => ({
          first: vi.fn(() => ({ click: vi.fn(async () => { throw new Error('фрейм закрыт'); }) })),
        })),
      })),
    });
    await clickTurnstileCheckbox(page);
    // boundingBox мока: { x: 10, y: 10, width: 300, height: 65 } →
    // клик в левой части виджета: (10 + 300*0.2, 10 + 65/2) = (70, 42.5).
    expect(page.mouse.click).toHaveBeenCalledWith(70, 42.5);
  });
});
