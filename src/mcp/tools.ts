import { HarvestError } from '../core/errors.js';
import { formatScrape, formatSearch } from '../core/format.js';
import type { DaemonClient } from './client.js';

const ELEMENT_ID_HINT =
  'Адрес элемента — строка вида «0-18372» (ординал фрейма и id узла через дефис), скопированная ' +
  'из дерева, которое вернул последний browser_open или browser_snapshot на этой сессии.';

export const TOOL_DEFINITIONS = [
  {
    name: 'scrape',
    description:
      'Загружает веб-страницу и возвращает её основное содержимое в markdown, без навигации, рекламы и cookie-баннеров. ' +
      'Умеет страницы на JavaScript. Используй, когда нужно прочитать конкретный URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Полный URL страницы' },
        maxChars: { type: 'number', description: 'Потолок длины ответа, по умолчанию 40000' },
        refresh: { type: 'boolean', description: 'Игнорировать кэш и загрузить заново' },
        includeLinks: { type: 'boolean', description: 'Добавить список ссылок со страницы' },
      },
      required: ['url'],
    },
  },
  {
    name: 'search',
    description:
      'Ищет по вебу и возвращает результаты с заголовками и описаниями. ' +
      'С fetchContent сразу загружает содержимое первых результатов. Используй, когда нужного URL ещё нет.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос' },
        limit: { type: 'number', description: 'Сколько результатов, по умолчанию 5, максимум 10' },
        fetchContent: { type: 'boolean', description: 'Загрузить содержимое первых результатов' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_open',
    description:
      'Открывает страницу в живом браузере и возвращает id сессии и дерево страницы. ' +
      'Страница остаётся открытой между вызовами. Используй, когда со страницей надо ' +
      `взаимодействовать, а не просто прочитать её — для чтения есть scrape. ${ELEMENT_ID_HINT} ` +
      'Дальше сам решай по дереву, какие элементы кликать/заполнять — отдельного шага ' +
      '«осмотреться» не требуется.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Полный URL страницы' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Возвращает свежее дерево той же открытой страницы, не выполняя никакого действия. ' +
      'Используй, чтобы посмотреть на текущее состояние страницы: после навигации, которую не отследить ' +
      `дифом действия, или просто чтобы свериться перед следующим шагом. ${ELEMENT_ID_HINT}`,
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'id сессии из browser_open' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_click',
    description:
      'Кликает по элементу на открытой странице и возвращает, что изменилось (диф дерева до/после). ' +
      'elementId должен быть скопирован из последнего снапшота этой сессии (browser_open/browser_snapshot ' +
      'или ответа предыдущего действия) — после каждого действия адреса элементов могут смениться.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        elementId: { type: 'string', description: 'Адрес элемента из последнего снапшота, например 0-18372' },
      },
      required: ['sessionId', 'elementId'],
    },
  },
  {
    name: 'browser_hover',
    description:
      'Наводит курсор на элемент (без клика) и возвращает, что изменилось на странице — полезно для ' +
      'меню и подсказок, раскрывающихся по hover. elementId должен быть скопирован из последнего снапшота ' +
      'этой сессии — после каждого действия адреса элементов могут смениться.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        elementId: { type: 'string', description: 'Адрес элемента из последнего снапшота, например 0-18372' },
      },
      required: ['sessionId', 'elementId'],
    },
  },
  {
    name: 'browser_fill',
    description:
      'Очищает текстовое поле и вписывает в него значение целиком. elementId должен быть скопирован из ' +
      'последнего снапшота этой сессии — после каждого действия адреса элементов могут смениться. ' +
      'Секреты (пароли, токены) не пиши в text открытым текстом: вставь в text плейсхолдер вида %password% ' +
      'и передай настоящее значение в variables — {"password": "..."}. Демон подставит его прямо перед ' +
      'вводом в браузер, минуя твой собственный контекст, так что значение не осядет в истории диалога.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        elementId: { type: 'string', description: 'Адрес элемента из последнего снапшота, например 0-18372' },
        text: { type: 'string', description: 'Значение поля целиком; секреты — плейсхолдером %имя%' },
        variables: {
          type: 'object',
          description: 'Значения плейсхолдеров из text: ключ — имя без %, значение — то, что реально ввести',
        },
      },
      required: ['sessionId', 'elementId', 'text'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Печатает текст в поле посимвольно, генерируя настоящие события клавиатуры — используй вместо ' +
      'browser_fill там, где поле реагирует на ввод по символам (автокомплиты, маски ввода). elementId ' +
      'должен быть скопирован из последнего снапшота этой сессии. Та же подстановка секретов через ' +
      'variables и плейсхолдеры %имя%, что и у browser_fill.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        elementId: { type: 'string', description: 'Адрес элемента из последнего снапшота, например 0-18372' },
        text: { type: 'string', description: 'Текст для посимвольного ввода; секреты — плейсхолдером %имя%' },
        variables: {
          type: 'object',
          description: 'Значения плейсхолдеров из text: ключ — имя без %, значение — то, что реально ввести',
        },
      },
      required: ['sessionId', 'elementId', 'text'],
    },
  },
  {
    name: 'browser_press',
    description:
      'Нажимает одну клавишу (Enter, Escape, Tab, ArrowDown и т. п.) на сфокусированном элементе. ' +
      'elementId должен быть скопирован из последнего снапшота этой сессии — после каждого действия ' +
      'адреса элементов могут смениться.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        elementId: { type: 'string', description: 'Адрес элемента из последнего снапшота, например 0-18372' },
        key: { type: 'string', description: 'Название клавиши в терминах Playwright, например Enter' },
      },
      required: ['sessionId', 'elementId', 'key'],
    },
  },
  {
    name: 'browser_select',
    description:
      'Выбирает пункт в нативном выпадающем списке (<select>) по подписи. Кастомные (не нативные) ' +
      'выпадающие списки так не открываются — их нужно сначала раскрыть browser_click, затем кликнуть по ' +
      'нужному пункту. elementId должен быть скопирован из последнего снапшота этой сессии.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        elementId: { type: 'string', description: 'Адрес элемента <select> из последнего снапшота' },
        value: { type: 'string', description: 'Подпись нужного пункта списка' },
      },
      required: ['sessionId', 'elementId', 'value'],
    },
  },
  {
    name: 'browser_scroll',
    description:
      'Прокручивает элемент (если он сам прокручиваемый) или всю страницу до указанной доли высоты. ' +
      'elementId должен быть скопирован из последнего снапшота этой сессии.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        elementId: { type: 'string', description: 'Адрес элемента из последнего снапшота, например 0-18372' },
        percent: { type: 'string', description: 'Доля прокрутки в процентах, например "50" или "100%"' },
      },
      required: ['sessionId', 'elementId', 'percent'],
    },
  },
  {
    name: 'browser_close',
    description: 'Закрывает сессию браузера. Вызывай, когда работа со страницей закончена.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'id сессии из browser_open' } },
      required: ['sessionId'],
    },
  },
] as const;

function explain(e: unknown): string {
  if (HarvestError.is(e)) {
    const hint =
      e.code === 'blocked' ? ' Попробуй другой источник — эту страницу закрывает антибот.'
      : e.code === 'timeout' ? ' Можно повторить попытку.'
      : e.code === 'not_found' ? ' Открой страницу заново через browser_open или сними свежий снапшот.'
      : '';
    const msg = e.message.endsWith('.') ? e.message : `${e.message}.`;
    return `Не удалось: ${msg}${hint}`;
  }
  return `Не удалось: ${e instanceof Error ? e.message : String(e)}`;
}

export async function handleScrape(
  client: DaemonClient,
  args: { url: string; maxChars?: number; refresh?: boolean; includeLinks?: boolean },
): Promise<string> {
  try {
    const payload = await client.scrape({
      url: args.url,
      refresh: args.refresh ?? false,
      includeLinks: args.includeLinks ?? false,
    });
    return formatScrape(payload, args.maxChars ?? 40_000);
  } catch (e) {
    return explain(e);
  }
}

export async function handleSearch(
  client: DaemonClient,
  args: { query: string; limit?: number; fetchContent?: boolean },
): Promise<string> {
  try {
    const results = await client.search({
      query: args.query,
      limit: args.limit ?? 5,
      fetchContent: args.fetchContent ?? false,
    });
    return formatSearch(args.query, results);
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserOpen(
  client: DaemonClient,
  args: { url: string },
): Promise<string> {
  try {
    const r = await client.browserOpen(args);
    return `Сессия: ${r.sessionId}\n\nДерево страницы:\n${r.outline}`;
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserSnapshot(
  client: DaemonClient,
  args: { sessionId: string },
): Promise<string> {
  try {
    const r = await client.browserSnapshot(args);
    return `Дерево страницы:\n${r.outline}`;
  } catch (e) {
    return explain(e);
  }
}

function formatChanged(changed: string): string {
  return changed ? `Сделано. На странице появилось:\n${changed}` : 'Сделано. Видимых изменений на странице нет.';
}

export async function handleBrowserClick(
  client: DaemonClient,
  args: { sessionId: string; elementId: string },
): Promise<string> {
  try {
    return formatChanged((await client.browserClick(args)).changed);
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserHover(
  client: DaemonClient,
  args: { sessionId: string; elementId: string },
): Promise<string> {
  try {
    return formatChanged((await client.browserHover(args)).changed);
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserFill(
  client: DaemonClient,
  args: { sessionId: string; elementId: string; text: string; variables?: Record<string, string> },
): Promise<string> {
  try {
    return formatChanged((await client.browserFill(args)).changed);
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserType(
  client: DaemonClient,
  args: { sessionId: string; elementId: string; text: string; variables?: Record<string, string> },
): Promise<string> {
  try {
    return formatChanged((await client.browserType(args)).changed);
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserPress(
  client: DaemonClient,
  args: { sessionId: string; elementId: string; key: string },
): Promise<string> {
  try {
    return formatChanged((await client.browserPress(args)).changed);
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserSelect(
  client: DaemonClient,
  args: { sessionId: string; elementId: string; value: string },
): Promise<string> {
  try {
    return formatChanged((await client.browserSelect(args)).changed);
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserScroll(
  client: DaemonClient,
  args: { sessionId: string; elementId: string; percent: string },
): Promise<string> {
  try {
    return formatChanged((await client.browserScroll(args)).changed);
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserClose(
  client: DaemonClient,
  args: { sessionId: string },
): Promise<string> {
  try {
    await client.browserClose(args);
    return 'Сессия закрыта.';
  } catch (e) {
    return explain(e);
  }
}
