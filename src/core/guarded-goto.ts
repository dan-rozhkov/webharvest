import type { Page, Response } from 'playwright';
import { HarvestError } from './errors.js';
import { navigationWasBlocked, PROXY_ERROR_HEADER, trackNavigationChain, type EgressProxy } from './egress-proxy.js';

/**
 * page.goto с атрибуцией отказов прокси — единая последовательность для трёх
 * пулов (Chromium-рендер, browser use, Lightpanda). Возвращает ответ или
 * бросает типизированную HarvestError:
 * - invalid_url: прокси отказал по политике именно ЭТОЙ навигации (её host:port
 *   или хоп редиректа есть в журнале отказов с момента старта);
 * - network: собственная ошибка прокси на plain HTTP (DNS, недостижим,
 *   таймаут установки). Прокси отвечает 502/504 с маркером, браузер получает
 *   «страницу», а не ошибку навигации — без этой проверки она сошла бы за
 *   успешный рендер.
 * Прочие ошибки goto пробрасываются как есть (таймаут и т.п. — дело пула), но
 * если за время навигации прокси отказал ей по политике, они превращаются
 * в invalid_url (на HTTPS отказ — это обрыв туннеля, а не ответ).
 * Маркерам верим только на http:, где прокси вычищает их из ответов источника.
 */
export async function gotoGuarded(
  page: Page,
  url: string,
  proxy: EgressProxy | null,
  options: Parameters<Page['goto']>[1],
): Promise<Response | null> {
  const start = Date.now();
  const nav = trackNavigationChain(page, url);
  try {
    const response = await page.goto(url, options);
    if (response && response.status() === 403 && navigationWasBlocked(proxy, nav.chain, start, response)) {
      throw new HarvestError('invalid_url', `Адрес запрещён (приватная сеть): ${response.url()}`);
    }
    if (
      response &&
      (response.status() === 502 || response.status() === 504) &&
      response.url().startsWith('http:') &&
      response.headers()[PROXY_ERROR_HEADER]
    ) {
      throw new HarvestError('network', `Не удалось соединиться с ${response.url()} (ошибка прокси ${response.status()})`);
    }
    return response;
  } catch (e) {
    if (HarvestError.is(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (!/timeout/i.test(msg) && navigationWasBlocked(proxy, nav.chain, start)) {
      throw new HarvestError('invalid_url', `Адрес запрещён (приватная сеть): ${url}`);
    }
    throw e;
  } finally {
    nav.dispose();
  }
}
