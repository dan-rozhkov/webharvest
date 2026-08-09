import type { SearchResult } from './search/types.js';

export interface ScrapePayload {
  url: string;
  title: string;
  markdown: string;
  via: 'http' | 'browser';
  cached: boolean;
  links?: { href: string; text: string }[];
}

export function truncateMarkdown(
  md: string,
  maxChars: number,
): { text: string; truncated: boolean; remaining: number } {
  const cap = Math.max(0, maxChars);
  if (md.length <= cap) return { text: md, truncated: false, remaining: 0 };

  let window = md.slice(0, cap);
  const lastBreak = window.lastIndexOf('\n\n');
  let text = lastBreak > cap * 0.5 ? window.slice(0, lastBreak).trimEnd() : window.trimEnd();

  // Trim unpaired high surrogate at end (left by hard-cut through emoji/surrogate pair)
  text = text.replace(/[\ud800-\udbff]$/, '');

  return { text, truncated: true, remaining: md.length - text.length };
}

const nf = new Intl.NumberFormat('ru-RU');

export function formatScrape(p: ScrapePayload, maxChars: number): string {
  const { text, truncated, remaining } = truncateMarkdown(p.markdown, maxChars);

  const badges = [p.url, `via ${p.via}`];
  if (p.cached) badges.push('cached');
  badges.push(`${nf.format(p.markdown.length)} символов`);

  const parts = [
    `# ${p.title || 'Без заголовка'}`,
    badges.join(' · '),
    '---',
    text,
  ];

  if (truncated) {
    parts.push('', `_Обрезано: осталось ещё ${nf.format(remaining)} символов. Увеличь maxChars, если нужен полный текст._`);
  }

  if (p.links?.length) {
    parts.push('', '## Ссылки', ...p.links.map((l) => `- [${l.text || l.href}](${l.href})`));
  }

  return parts.join('\n');
}

export function formatSearch(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `По запросу «${query}» ничего не найдено.`;
  }

  const blocks = results.map((r, i) => {
    let host: string;
    try { host = new URL(r.url).hostname; } catch { host = r.url; }

    const lines = [`${i + 1}. **${r.title || r.url}** — ${host}`, `   ${r.url}`];
    if (r.snippet) lines.push(`   ${r.snippet}`);
    if (r.error) lines.push(`   ⚠️ Содержимое не загружено: ${r.error}`);
    if (r.content) lines.push('', r.content);
    return lines.join('\n');
  });

  return [`Результаты по запросу «${query}» (${results.length}):`, '', ...blocks].join('\n');
}
