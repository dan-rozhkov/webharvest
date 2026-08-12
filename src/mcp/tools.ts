import { HarvestError } from '../core/errors.js';
import { formatScrape, formatSearch } from '../core/format.js';
import type { DaemonClient } from './client.js';

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
      'взаимодействовать, а не просто прочитать её — для чтения есть scrape.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Полный URL страницы' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_observe',
    description:
      'Находит на открытой странице элементы по описанию и возвращает их адреса и ' +
      'возможные действия, ничего не делая. Используй, чтобы осмотреться перед действием.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        instruction: { type: 'string', description: 'Что искать, обычными словами' },
      },
      required: ['sessionId', 'instruction'],
    },
  },
  {
    name: 'browser_act',
    description:
      'Выполняет одно действие на открытой странице по описанию: клик, ввод текста, ' +
      'выбор в списке, прокрутка. Возвращает, что изменилось на странице. ' +
      'Используй по одному действию за раз.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        instruction: { type: 'string', description: 'Одно действие, обычными словами' },
        variables: {
          type: 'object',
          description:
            'Значения для подстановки: в инструкции упоминай их как %имя%. ' +
            'Сами значения модели не показываются — так передаются пароли и токены.',
        },
      },
      required: ['sessionId', 'instruction'],
    },
  },
  {
    name: 'browser_extract',
    description:
      'Достаёт данные с открытой страницы в заданной JSON-схеме. ' +
      'Используй, когда нужен структурированный результат, а не текст страницы.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'id сессии из browser_open' },
        instruction: { type: 'string', description: 'Что извлечь' },
        schema: { type: 'object', description: 'JSON Schema желаемого результата' },
      },
      required: ['sessionId', 'instruction', 'schema'],
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
      : e.code === 'not_found' ? ' Открой страницу заново через browser_open.'
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

export async function handleBrowserObserve(
  client: DaemonClient,
  args: { sessionId: string; instruction: string },
): Promise<string> {
  try {
    const r = await client.browserObserve(args);
    if (r.elements.length === 0) return 'Подходящих элементов не нашлось.';
    return r.elements
      .map((e) => `[${e.elementId}] ${e.description} — ${e.method}`)
      .join('\n');
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserAct(
  client: DaemonClient,
  args: { sessionId: string; instruction: string; variables?: Record<string, string> },
): Promise<string> {
  try {
    const r = await client.browserAct(args);
    if (!r.performed) return 'Подходящего элемента для этого действия на странице нет.';
    return r.changed
      ? `Сделано: ${r.description}\n\nНа странице появилось:\n${r.changed}`
      : `Сделано: ${r.description}\n\nВидимых изменений на странице нет.`;
  } catch (e) {
    return explain(e);
  }
}

export async function handleBrowserExtract(
  client: DaemonClient,
  args: { sessionId: string; instruction: string; schema: Record<string, unknown> },
): Promise<string> {
  try {
    return JSON.stringify(await client.browserExtract(args), null, 2);
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
