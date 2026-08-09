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
] as const;

function explain(e: unknown): string {
  if (HarvestError.is(e)) {
    const hint =
      e.code === 'blocked' ? ' Попробуй другой источник — эту страницу закрывает антибот.'
      : e.code === 'timeout' ? ' Можно повторить попытку.'
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
