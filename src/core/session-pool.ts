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

  async function ensureContext(): Promise<BrowserContext> {
    if (context) return context;
    if (launching) return launching;
    launching = (async () => {
      const b = await chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
      });
      const c = await b.newContext({
        userAgent: UA,
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
      });
      browser = b;
      context = c;
      return c;
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

  /** Снимает сессии, к которым давно не обращались. */
  function sweepIdle(): void {
    const deadline = Date.now() - idleTimeoutMs;
    for (const [id, s] of sessions) {
      if (s.lastUsedAt < deadline) void drop(id);
    }
  }

  async function evictOldest(): Promise<void> {
    let victim: InternalSession | undefined;
    for (const s of sessions.values()) {
      if (!victim || s.seq < victim.seq) victim = s;
    }
    if (victim) await drop(victim.id);
  }

  return {
    async open(url: string): Promise<BrowserSession> {
      sweepIdle();
      if (sessions.size >= maxSessions) await evictOldest();

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

      const session: InternalSession = { id: nextId(), page, lastUsedAt: Date.now(), seq: nextSeq() };
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
      return s;
    },

    close: drop,

    async shutdown(): Promise<void> {
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
