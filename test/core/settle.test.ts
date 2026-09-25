import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { trackNetwork, waitForNetworkQuiet, watchNavigation, settleAfterAction } from '../../src/core/settle.js';

/** Страница-заглушка: события запросов эмитим руками, как Playwright. */
function fakePage() {
  const ee = new EventEmitter();
  const main = { name: 'main' };
  const page = Object.assign(ee, {
    isClosed: () => false,
    mainFrame: () => main,
    waitForLoadState: async () => {},
  });
  return { page: page as unknown as Page, emit: ee.emit.bind(ee), main };
}

function req(type = 'fetch', opts: { nav?: boolean; frame?: unknown } = {}) {
  return { resourceType: () => type, isNavigationRequest: () => opts.nav ?? false, frame: () => opts.frame };
}

describe('settle: trackNetwork', () => {
  it('считает незавершённые запросы только после заданного поколения', () => {
    const { page, emit } = fakePage();
    const t = trackNetwork(page);
    const old = req();
    emit('request', old);
    const gen = t.generation();
    const fresh = req();
    emit('request', fresh);
    expect(t.pendingSince(0)).toBe(2);
    expect(t.pendingSince(gen)).toBe(1);
    emit('requestfinished', fresh);
    expect(t.pendingSince(gen)).toBe(0);
  });

  it('не считает бесконечные и не трогающие DOM запросы', () => {
    const { page, emit } = fakePage();
    const t = trackNetwork(page);
    for (const type of ['websocket', 'eventsource', 'ping', 'image', 'font', 'media']) emit('request', req(type));
    expect(t.pendingSince(0)).toBe(0);
    expect(t.generation()).toBe(0);
  });
});

describe('settle: waitForNetworkQuiet', () => {
  it('без запросов ждёт ровно окно тишины', async () => {
    const { page } = fakePage();
    const t = trackNetwork(page);
    const started = Date.now();
    await waitForNetworkQuiet(page, t, { sinceGen: 0, quietMs: 60, capMs: 1000 });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(55);
    expect(took).toBeLessThan(300);
  });

  it('ждёт завершения запроса, начатого после действия, и тишины после него', async () => {
    const { page, emit } = fakePage();
    const t = trackNetwork(page);
    const r = req();
    emit('request', r);
    setTimeout(() => emit('requestfinished', r), 150);
    const started = Date.now();
    await waitForNetworkQuiet(page, t, { sinceGen: 0, quietMs: 50, capMs: 2000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('не ждёт запрос, начатый до действия (long-poll с открытия страницы)', async () => {
    const { page, emit } = fakePage();
    const t = trackNetwork(page);
    emit('request', req());
    const gen = t.generation();
    const started = Date.now();
    await waitForNetworkQuiet(page, t, { sinceGen: gen, quietMs: 30, capMs: 2000 });
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('возвращается по потолку, если сеть не утихает', async () => {
    const { page, emit } = fakePage();
    const t = trackNetwork(page);
    emit('request', req());
    const started = Date.now();
    await waitForNetworkQuiet(page, t, { sinceGen: 0, quietMs: 30, capMs: 150 });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(500);
  });
});

describe('settle: settleAfterAction', () => {
  it('клик без навигации: navigated=false, без полных секунд ожидания', async () => {
    const { page } = fakePage();
    const t = trackNetwork(page);
    const nav = watchNavigation(page);
    const started = Date.now();
    const r = await settleAfterAction(page, t, nav, 'pointer', t.generation());
    expect(r.navigated).toBe(false);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('клик по ссылке: дожидается коммита нового документа', async () => {
    const { page, emit, main } = fakePage();
    const t = trackNetwork(page);
    const nav = watchNavigation(page);
    const gen = t.generation();
    const doc = req('document', { nav: true, frame: main });
    setTimeout(() => emit('request', doc), 20);
    setTimeout(() => {
      emit('framenavigated', main);
      emit('requestfinished', doc);
    }, 200);
    const r = await settleAfterAction(page, t, nav, 'pointer', gen);
    expect(r.navigated).toBe(true);
  });

  it('навигационный запрос без коммита (скачивание) не держит до потолка', async () => {
    const { page, emit, main } = fakePage();
    const t = trackNetwork(page);
    const nav = watchNavigation(page);
    const doc = req('document', { nav: true, frame: main });
    setTimeout(() => emit('request', doc), 10);
    setTimeout(() => emit('requestfailed', doc), 60);
    const started = Date.now();
    const r = await settleAfterAction(page, t, nav, 'pointer', t.generation());
    expect(r.navigated).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
