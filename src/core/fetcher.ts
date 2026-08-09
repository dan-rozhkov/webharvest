import { request } from 'undici';
import { HarvestError } from './errors.js';
import { assertAllowedUrl, assertPublicHost } from './url.js';
import { extract, type Extracted } from './extractor.js';
import { shouldEscalate, detectChallenge, isTextualContentType } from './escalation.js';
import type { DomainQueue } from './politeness.js';
import type { BrowserPool } from './browser.js';
import { DomainHints } from './domain-hints.js';

export { DomainHints };

export interface FetchResult {
  html: string;
  finalUrl: string;
  status: number;
  via: 'http' | 'browser';
  /** The extract() result computed from THIS html/finalUrl — the probe run
   *  to decide whether to escalate doubles as the final extraction, so
   *  callers (service.scrape) never need to run extract() a second time on
   *  the same document. After a browser escalation this is the browser's
   *  final html, never the discarded HTTP attempt. */
  extracted: Extracted;
}

export interface FetcherDeps {
  queue: DomainQueue;
  browser: BrowserPool;
  hints: DomainHints;
  httpTimeoutMs?: number;
  browserTimeoutMs?: number;
  maxBytes?: number;
  /** Только для тестов: пускает 127.0.0.1 и прочие приватные адреса мимо
   *  SSRF-валидации. Никогда не должен включаться в проде. */
  allowPrivate?: boolean;
}

const USER_AGENT = 'webharvest/0.1 (+personal research tool)';
const MAX_REDIRECTS = 5;

export function createFetcher(deps: FetcherDeps) {
  const httpTimeoutMs = deps.httpTimeoutMs ?? 10_000;
  const browserTimeoutMs = deps.browserTimeoutMs ?? 30_000;
  const maxBytes = deps.maxBytes ?? 5 * 1024 * 1024;

  /** Валидирует URL так же строго, как публичный вход: и синхронную проверку
   *  формы (assertAllowedUrl), и DNS-резолв (assertPublicHost). Вызывается и
   *  на исходном URL, и на каждом хопе редиректа, и на finalUrl из браузера —
   *  иначе 302 на 169.254.169.254 или редирект внутри браузера пробивает SSRF. */
  async function validate(rawUrl: string): Promise<URL> {
    if (deps.allowPrivate) return new URL(rawUrl);
    const u = assertAllowedUrl(rawUrl);
    await assertPublicHost(u.hostname);
    return u;
  }

  /** Ставит операцию в очередь конкретного хоста — но только если слот этого
   *  хоста ещё не удерживается где-то выше по цепочке текущего fetch(). Это
   *  и есть политес по хосту-получателю (не по хосту, с которого начался
   *  редирект), и одновременно защита от самозаклинивания: DomainQueue.run
   *  вложенный сам в себя для ОДНОГО И ТОГО ЖЕ хоста может дедлокнуться —
   *  если у хоста maxConcurrent слотов уже заняты внешними (ещё не
   *  завершившимися) вызовами run, а вложенный вызов ждёт освобождения
   *  слота, который освободится только после завершения этого самого
   *  вложенного вызова. Цепочка a.com → b.com → a.com — ровно этот случай:
   *  без heldHosts третий хоп запросил бы слот a.com повторно, хотя внешний
   *  вызов уже держит его открытым, и вся операция зависла бы навсегда.
   *  heldHosts отражает не "хост когда-либо встречался в этой цепочке", а
   *  "слот этого хоста сейчас открыт где-то в стеке вызовов": хост
   *  добавляется перед постановкой в очередь и снимается в finally, как
   *  только соответствующий queue.run возвращается. Это и предотвращает
   *  самозаклинивание a.com → b.com → a.com (третий хоп видит, что слот
   *  a.com всё ещё открыт внешним вызовом fetch(), который не вернётся,
   *  пока не завершится этот самый хоп — и не встаёт в очередь повторно), и
   *  сохраняет честный политес для a.com → b.com → c.com → b.com (к хопу 4
   *  слот хопа 2 на b.com уже отпущен, поэтому повторный визит на b.com
   *  снова встаёт в очередь и снова ограничивается). Хоп, совпадающий с
   *  хостом, чей слот прямо сейчас держит объемлющий вызов (родитель или
   *  более дальний предок в стеке), просто выполняется под этим слотом без
   *  собственного тайминга/лимита — цена безопасности от дедлока на
   *  патологическом случае немедленного возврата к тому же хосту.
   */
  async function withHostQueue<T>(host: string, heldHosts: Set<string>, fn: () => Promise<T>): Promise<T> {
    if (heldHosts.has(host)) return fn();
    heldHosts.add(host);
    try {
      return await deps.queue.run(host, fn);
    } finally {
      heldHosts.delete(host);
    }
  }

  async function performRequest(url: string) {
    try {
      return await request(url, {
        method: 'GET',
        maxRedirections: 0,
        headersTimeout: httpTimeoutMs,
        bodyTimeout: httpTimeoutMs,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9,ru;q=0.8',
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(msg)) {
        throw new HarvestError('timeout', `Сервер не ответил за ${httpTimeoutMs} мс: ${url}`);
      }
      throw new HarvestError('network', `Не удалось загрузить ${url}: ${msg}`);
    }
  }

  /** Один логический GET без автоследования undici за редиректами: undici
   *  сам ходит по Location до maxRedirections, но для этого нужен
   *  предварительно провалидированный URL на каждом хопе — иначе
   *  SSRF-проверка исходного адреса ничего не гарантирует про адрес, куда
   *  сервер решит перенаправить. Поэтому редиректы разбираются вручную
   *  здесь, а не отдаются undici; и каждый хоп идёт через очередь СВОЕГО
   *  хоста (withHostQueue), а не хоста, с которого стартовал fetch —
   *  редиректор (шортлинк, AMP/utm-гейтвей) не должен давать вызывающему
   *  обходить политес целевого сайта. */
  async function httpGet(
    startUrl: string,
    heldHosts: Set<string>,
  ): Promise<{
    html: string;
    finalUrl: string;
    status: number;
    contentType: string | null;
  }> {
    let currentUrl = startUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const hopHost = new URL(currentUrl).hostname;
      const res = await withHostQueue(hopHost, heldHosts, () => performRequest(currentUrl));

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // dump(), не destroy(): на неполностью прочитанном BodyReadable undici
        // destroy() кидает необработанный AbortError через отдельный тик.
        await res.body.dump?.();
        const location = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
        const nextUrl = new URL(location ?? '', currentUrl).toString();
        const validated = await validate(nextUrl);
        currentUrl = validated.toString();
        continue;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        size += buf.length;
        if (size > maxBytes) {
          res.body.destroy();
          throw new HarvestError('too_large', `Тело ответа превысило ${maxBytes} байт: ${currentUrl}`);
        }
        chunks.push(buf);
      }

      const contentType = (res.headers['content-type'] as string | undefined) ?? null;
      return {
        html: Buffer.concat(chunks).toString('utf8'),
        finalUrl: currentUrl,
        status: res.statusCode,
        contentType,
      };
    }

    throw new HarvestError('network', `Слишком много редиректов: ${startUrl}`);
  }

  async function fetch(rawUrl: string): Promise<FetchResult> {
    const u = await validate(rawUrl);
    const host = u.hostname;
    // Хосты, чей слот очереди уже открыт где-то в этой цепочке (см.
    // withHostQueue) — затравлен исходным хостом, потому что fetch() сам
    // держит его слот на всё время своего выполнения.
    const heldHosts = new Set<string>([host]);

    return deps.queue.run(host, async () => {
      // Домен уже показал, что без браузера не отдаётся — не тратим HTTP-запрос.
      // skipHintUpdate: этот рендер выбран ПОТОМУ ЧТО hint уже стоит, а не
      // потому что он его заслужил заново — не должен продлевать TTL (см.
      // markNeedsBrowser ниже).
      if (deps.hints.needsBrowser(host)) {
        return renderViaBrowser(u.toString(), heldHosts, { skipHintUpdate: true });
      }

      const attempt = await httpGet(u.toString(), heldHosts);

      // Content-type проверяем ДО extract(): бинарное тело (PDF, картинка,
      // ...) до 5 МБ иначе декодируется в UTF-8 и прогоняется через четыре
      // прохода JSDOM только для того, чтобы результат тут же выбросить —
      // shouldEscalate() всё равно завернёт его чуть ниже по этой же причине.
      // Отсутствующий content-type (isTextualContentType(null) === true)
      // по-прежнему считается текстом и идёт по обычному пути.
      if (!isTextualContentType(attempt.contentType)) {
        // application/json (и прочий нетекстовый content-type) браузер не
        // спасёт: рендерить страницу, чтобы получить тот же JSON, — чистые
        // потери времени и ещё один сетевой запрос. Это не домен нуждается
        // в браузере, это конкретный ответ не годится для извлечения — hint
        // не пишем.
        //
        // Но защита, отданная под нетекстовым content-type, тоже не HTML —
        // агент узнал бы "не HTML" вместо "заблокировано Cloudflare", если
        // не перепроверить явно, прежде чем поверить content-type на слово.
        const challenge = detectChallenge(attempt.html);
        if (challenge) {
          throw new HarvestError('blocked', `Страница закрыта защитой ${challenge}: ${attempt.finalUrl}`, {
            by: challenge,
          });
        }
        throw new HarvestError('not_html', `Ответ не похож на HTML: ${attempt.finalUrl}`, {
          reason: 'content_type',
          contentType: attempt.contentType,
        });
      }

      const probe = extract(attempt.html, attempt.finalUrl);
      const verdict = shouldEscalate({
        status: attempt.status,
        contentType: attempt.contentType,
        html: attempt.html,
        extractedTextLength: probe.textLength,
      });

      if (!verdict.escalate) {
        return { html: attempt.html, finalUrl: attempt.finalUrl, status: attempt.status, via: 'http', extracted: probe };
      }

      // attempt.finalUrl, а не исходный url: если HTTP-путь уже прошёл через
      // редиректы, браузер должен рендерить конечный адрес, а не заново
      // проходить всю цепочку с нуля.
      return renderViaBrowser(attempt.finalUrl, heldHosts, {
        challenge: detectChallenge(attempt.html),
        contentType: attempt.contentType,
      });
    });
  }

  async function renderViaBrowser(
    url: string,
    heldHosts: Set<string>,
    context: {
      challenge?: ReturnType<typeof detectChallenge>;
      contentType?: string | null;
      /** True when this render was selected BECAUSE deps.hints.needsBrowser()
       *  was already true, not because this call is what earned the hint.
       *  A success here must not re-mark the domain — DomainHints' TTL exists
       *  to give a marked domain a fresh shot at the cheap HTTP path, and a
       *  domain scraped at least once per TTL window would otherwise never
       *  see that clock actually reach zero. */
      skipHintUpdate?: boolean;
    } = {},
  ): Promise<FetchResult> {
    // Хост, чьё содержимое реально потребовало эскалации (URL после
    // HTTP-редиректов) — не обязательно исходный хост fetch(). Именно на
    // него ставим slot очереди и именно его помечаем в hints при успехе,
    // иначе a.com получал бы клеймо "нужен браузер" из-за того, что
    // редиректящий его b.com оказался SPA.
    const targetHost = new URL(url).hostname;

    return withHostQueue(targetHost, heldHosts, async () => {
      const rendered = await deps.browser.render(url, { timeoutMs: browserTimeoutMs });
      // Браузер тоже может быть перенаправлен (в т.ч. на приватный адрес по
      // цепочке редиректов внутри страницы) — finalUrl проверяем так же строго,
      // как и HTTP-хопы.
      await validate(rendered.finalUrl);

      const stillChallenged = detectChallenge(rendered.html);
      if (stillChallenged) {
        throw new HarvestError('blocked', `Страница закрыта защитой ${stillChallenged}: ${url}`, {
          by: stillChallenged,
        });
      }

      const probe = extract(rendered.html, rendered.finalUrl);
      const verdict = shouldEscalate({
        status: rendered.status,
        contentType: 'text/html',
        html: rendered.html,
        extractedTextLength: probe.textLength,
      });

      // Браузер — последняя инстанция. Если и он не дал текста, честно сообщаем,
      // а не отдаём пустоту или заглушку как контент.
      if (verdict.escalate) {
        if (context.challenge) {
          throw new HarvestError('blocked', `Страница закрыта защитой ${context.challenge}: ${url}`, {
            by: context.challenge,
          });
        }
        // Бот-статусы (403/429/503) без узнаваемой сигнатуры защиты — не
        // "нет текста", а конкретный ответ сервера. Иначе стилизованная
        // 403-страница со своим текстом сообщила бы агенту неправду:
        // "на странице не нашлось читаемого текста", хотя текст там есть,
        // просто origin явно отказал.
        if (verdict.reason === 'status') {
          throw new HarvestError('upstream_error', `Сервер вернул ошибку ${rendered.status}: ${url}`, {
            status: rendered.status,
          });
        }
        throw new HarvestError('not_html', `На странице не нашлось читаемого текста: ${url}`, {
          reason: verdict.reason,
          contentType: context.contentType ?? null,
        });
      }

      // Пишем hint только теперь, когда браузер реально спас контент, и
      // только если этот рендер сам заслужил hint, а не был выбран по уже
      // стоящему (см. skipHintUpdate) — иначе домен, который скрейпят чаще,
      // чем раз в TTL, никогда не увидит эти 24 часа истёкшими и навсегда
      // останется приколот к браузеру, даже перестав нуждаться в JS. Если бы
      // мы писали его перед рендером (как раньше), постоянно заблокированный
      // домен жёг бы полный браузерный рендер на каждый запрос все 24 часа
      // TTL, хотя и дешёвый HTTP-путь всё равно закончился бы тем же blocked.
      if (!context.skipHintUpdate) {
        deps.hints.markNeedsBrowser(targetHost);
      }
      return { html: rendered.html, finalUrl: rendered.finalUrl, status: rendered.status, via: 'browser', extracted: probe };
    });
  }

  return { fetch };
}
