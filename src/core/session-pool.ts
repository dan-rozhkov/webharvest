/**
 * Пул живых страниц для browser use.
 *
 * `BrowserPool` из browser.ts под это не подходит принципиально: он открывает
 * страницу, забирает HTML и закрывает — состояния между вызовами нет. Здесь
 * страница живёт до явного закрытия, вытеснения по LRU или простоя, потому что
 * агент делает над ней много последовательных шагов.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { HarvestError } from './errors.js';

export interface BrowserSession {
  id: string;
  page: Page;
  lastUsedAt: number;
  /**
   * Имя переменной → множество ВСЕХ значений, которые демон когда-либо
   * подставил под этим именем из `variables` в browser_fill/browser_type на
   * этой сессии (см. redactOutlineSecrets/redactSecrets в a11y/format.ts).
   * Множество, а не одно значение на имя: агент вправе переиспользовать одно
   * и то же имя переменной (например, `%token%`) в двух разных вызовах с
   * разными значениями — второй вызов раньше просто перезаписывал значение
   * первого в Map<string, string>, и первое значение, всё ещё живущее в DOM
   * того поля, куда его подставили, переставало редактироваться и утекало в
   * следующий снапшот. Имя тут нужно только для того, чтобы показать в
   * outline понятный плейсхолдер `%имя%` — какое конкретно из значений этого
   * имени встретилось в тексте, для результата не важно, оба редактируются
   * одинаково.
   *
   * Копится по сессии, а не по одному вызову действия: значение остаётся в
   * DOM страницы (например, в value обычного `<input>`) и после того, как
   * само действие завершилось, — следующий снапшот той же страницы обязан
   * вычистить из него то же значение, даже если в ЕГО собственном вызове
   * variables вообще не передавались. Живёт только в памяти процесса вместе
   * с сессией: не пишется в cache.ts, не попадает в логи и пропадает вместе
   * с картой при закрытии/вытеснении сессии — тем же путём, что и сама Page.
   */
  secrets: Map<string, Set<string>>;
}

export interface SessionPoolOptions {
  /** Сколько сессия живёт без обращений. По умолчанию 10 минут. */
  idleTimeoutMs?: number;
  /** Потолок одновременно открытых страниц. По умолчанию 5. */
  maxSessions?: number;
  headless?: boolean;
}

export interface SessionPool {
  open(url: string): Promise<BrowserSession>;
  get(id: string): BrowserSession;
  /** Парный вызов к `get(id)` (или к `open()`, чья сессия тоже создаётся
   *  занятой) — сообщает пулу, что вызывающий закончил работать с сессией
   *  прямо сейчас, так что sweep/eviction снова могут её тронуть. Обязан
   *  вызываться в `finally`, иначе сессия останется помеченной занятой
   *  навсегда и никогда не будет ни снята по простою, ни вытеснена. */
  release(id: string): void;
  close(id: string): Promise<void>;
  shutdown(): Promise<void>;
  count(): number;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

let counter = 0;
function nextId(): string {
  counter += 1;
  return `s_${Date.now().toString(36)}${counter.toString(36)}`;
}

// Отдельный монотонный счётчик обращений — только для порядка вытеснения.
// `Date.now()` даёт миллисекундное разрешение, а открытие/получение сессий
// в реальности укладывается в один и тот же тик: два `lastUsedAt` могут
// совпасть, и тогда сравнение "<" ничего не вытеснит правильно. `seq`
// растёт на каждое обращение и совпасть не может, поэтому именно по нему
// определяем самую давнюю сессию; `lastUsedAt` остаётся для sweepIdle —
// там сравнение идёт с реальным простоем в минутах, где миллисекундные
// совпадения не играют роли.
let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

interface InternalSession extends BrowserSession {
  seq: number;
  /**
   * true между `get(id)` (или создание в `open()`) и парным `release(id)` —
   * то есть пока вызывающий код в daemon/service.ts всё ещё где-то в
   * середине `await`-цепочки над этой сессией (снапшот, action, повторная
   * проверка url и т.д.). И `sweepIdle`, и `evictOldest` обязаны пропускать
   * такую сессию: `lastUsedAt`/`seq` обновляются только на ВХОДЕ в
   * использование, поэтому долгое действие (или просто зависшая вкладка)
   * могло раньше выглядеть как «давно не трогали» и быть снесено прямо
   * посреди работы — с точки зрения вызывающего это не отличить от того, что
   * страницу закрыли снаружи ('Target page, context or browser has been
   * closed'). `busy` — источник истины поверх `lastUsedAt`/`seq`, а не вместо
   * них: те по-прежнему нужны, чтобы выбрать жертву СРЕДИ свободных сессий.
   */
  busy: boolean;
}

export function createSessionPool(opts: SessionPoolOptions = {}): SessionPool {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
  const maxSessions = opts.maxSessions ?? 5;
  const headless = opts.headless ?? true;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let launching: Promise<BrowserContext> | null = null;
  // Map сохраняет порядок вставки, но нам нужен порядок обращений — поэтому
  // вытесняем по seq (см. nextSeq выше), а не по позиции в Map.
  const sessions = new Map<string, InternalSession>();

  // Прежде sweepIdle() запускался только изнутри open() — значит, агент,
  // который открыл сессию и ушёл навсегда (краш, брошенный диалог), оставлял
  // страницу и сам Chromium жить до конца работы демона: без нового open()
  // от кого-то ещё простой никто не проверял, хотя модульная документация
  // выше обещает смерть по простою. Периодический таймер закрывает этот
  // разрыв: интервал равен idleTimeoutMs, так что осиротевшая сессия
  // проживёт максимум ~2×idleTimeoutMs с момента последнего обращения, а не
  // до перезапуска демона. unref() — тот же приём, что у purgeTimer в
  // daemon/service.ts: таймер не должен сам по себе держать процесс живым.
  const sweepTimer = setInterval(sweepIdle, idleTimeoutMs);
  sweepTimer.unref();

  async function ensureContext(): Promise<BrowserContext> {
    if (context) return context;
    if (launching) return launching;
    launching = (async () => {
      const b = await chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
      });
      try {
        const c = await b.newContext({
          userAgent: UA,
          viewport: { width: 1440, height: 900 },
          locale: 'en-US',
        });
        browser = b;
        context = c;
        return c;
      } catch (e) {
        // b.newContext() уже запустило настоящий процесс Chromium в `b`
        // (chromium.launch() выше успешно отработало) — если его не закрыть
        // здесь, ссылка на него теряется вместе с этим catch (ни `browser`,
        // ни `context` не были присвоены), и процесс живёт до перезапуска
        // демона: осиротевший Chromium, который никто и никогда не закроет.
        // Следующий open() при этом просто попробует ensureContext() заново
        // и запустит ЕЩЁ один — раньше это и происходило. Ошибку самого
        // close() глотаем: если процесс уже не поднялся толком, закрыть его
        // всё равно надо попытаться, но вторичный сбой здесь не важнее
        // исходного, который летит вызывающему через rethrow ниже.
        await b.close().catch(() => {});
        throw e;
      }
    })();
    try {
      return await launching;
    } finally {
      launching = null;
    }
  }

  /** Закрывает страницу и забывает сессию. Ошибку закрытия глотаем: */
  /** если страница уже мертва, забыть её всё равно надо. */
  async function drop(id: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.page.close().catch(() => {});
  }

  /** Снимает сессии, к которым давно не обращались — но не занятые прямо
   *  сейчас (см. JSDoc `busy` у InternalSession): у той `lastUsedAt` может
   *  быть сколь угодно старым, если её единственное действие просто идёт
   *  дольше idleTimeoutMs, а это не то же самое, что простой. */
  function sweepIdle(): void {
    const deadline = Date.now() - idleTimeoutMs;
    for (const [id, s] of sessions) {
      if (!s.busy && s.lastUsedAt < deadline) void drop(id);
    }
  }

  /**
   * Возвращает true, если что-то реально вытеснила. Жертва выбирается только
   * среди свободных (`!busy`) сессий — иначе шестой параллельный `open()`
   * закрыл бы страницу, которую прямо сейчас использует чьё-то действие,
   * просто потому что у неё самый маленький `seq` среди ВСЕХ сессий. Занятая
   * сессия не участвует в сравнении вовсе, даже если её `seq` меньше всех:
   * освободится — станет кандидатом в следующий раз.
   */
  async function evictOldest(): Promise<boolean> {
    let victim: InternalSession | undefined;
    for (const s of sessions.values()) {
      if (s.busy) continue;
      if (!victim || s.seq < victim.seq) victim = s;
    }
    if (!victim) return false;
    await drop(victim.id);
    return true;
  }

  return {
    async open(url: string): Promise<BrowserSession> {
      sweepIdle();
      if (sessions.size >= maxSessions) {
        const evicted = await evictOldest();
        // Все существующие сессии заняты — вытеснять нечего. Молча открыть
        // шестую страницу поверх лимита было бы тихим фолбэком, который
        // сводит maxSessions к декорации; молча отказать без объяснения —
        // вернуть загадочный not_found/timeout чуть позже. Явный 'busy'
        // говорит вызывающему ровно то, что произошло: сессии есть, но все
        // они прямо сейчас заняты, — и что делать (закрыть ненужную или
        // повторить попытку), а не «почини свои аргументы».
        if (!evicted) {
          throw new HarvestError(
            'busy',
            `Все ${maxSessions} сессий browser use сейчас заняты — закройте неиспользуемую сессию (browser_close) или повторите попытку позже`,
          );
        }
      }

      const ctx = await ensureContext();
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (e) {
        await page.close().catch(() => {});
        const msg = e instanceof Error ? e.message : String(e);
        if (/timeout/i.test(msg)) {
          throw new HarvestError('timeout', `Браузер не дождался ${url}`);
        }
        throw new HarvestError('network', `Браузер не смог открыть ${url}: ${msg}`);
      }

      const session: InternalSession = {
        id: nextId(),
        page,
        lastUsedAt: Date.now(),
        seq: nextSeq(),
        secrets: new Map(),
        // Занята с момента создания: до возврата вызывающему код в
        // daemon/service.ts ещё сделает пост-навигационную проверку url и
        // снимет первый снапшот — за это время сессия так же уязвима для
        // evictOldest() из чужого параллельного open(), как и во время
        // обычного действия. Снимается вызовом release() (см. get() ниже) —
        // daemon/service.ts обязан вызвать его перед своим return, как и для
        // сессии, полученной через get().
        busy: true,
      };
      sessions.set(session.id, session);
      return session;
    },

    get(id: string): BrowserSession {
      const s = sessions.get(id);
      if (!s) {
        throw new HarvestError('not_found', `Сессия ${id} не найдена — возможно, она уже закрыта`);
      }
      // Обращение продлевает жизнь: агент может думать между шагами.
      s.lastUsedAt = Date.now();
      s.seq = nextSeq();
      s.busy = true;
      return s;
    },

    release(id: string): void {
      const s = sessions.get(id);
      if (!s) return; // сессию могли закрыть явным browser_close, пока действие шло — не ошибка.
      s.busy = false;
      // Отсчёт простоя перезапускается от момента, когда действие
      // ЗАВЕРШИЛОСЬ, а не когда началось — длинное, но живое действие не
      // должно тратить бюджет простоя, накопленный, пока оно ещё выполнялось.
      s.lastUsedAt = Date.now();
    },

    close: drop,

    async shutdown(): Promise<void> {
      clearInterval(sweepTimer);
      await Promise.all([...sessions.keys()].map(drop));
      const c = context;
      const b = browser;
      context = null;
      browser = null;
      await c?.close().catch(() => {});
      await b?.close().catch(() => {});
    },

    count: () => sessions.size,
  };
}
