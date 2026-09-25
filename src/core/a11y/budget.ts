/**
 * Бюджет на размер дерева, которое уходит агенту.
 *
 * Полное дерево тяжёлой страницы — сотни килобайт (Википедия: ~370 КБ,
 * ~100k токенов), и каждый такой ответ стоит агенту секунд чтения на каждом
 * шаге. Внутри демона дерево остаётся полным (диф, резолв адресов); режется
 * только текст ответа:
 *
 *  1. влезает в бюджет — отдаём как есть;
 *  2. не влезает — компактный вид: без безымянных обёрток (div/span/list…)
 *     и маркеров списков, длинный текст обрезан, отступы пересчитаны по
 *     оставшимся предкам; все адреса интерактивных элементов на месте;
 *  3. и так не влезает — режем компактный вид на части по строкам, агент
 *     просит следующую через browser_snapshot {part}.
 */

export const OUTLINE_BUDGET_CHARS = 24_000;
const TEXT_CLIP = 80;

/** Безымянные узлы этих ролей — чистая вёрстка, в компактном виде не нужны. */
const WRAPPER_ROLES = new Set([
  'div', 'span', 'generic', 'none', 'presentation', 'list', 'listitem', 'section', 'paragraph',
  'group', 'LineBreak', 'superscript', 'subscript', 'strong', 'emphasis', 'code', 'cite', 'abbr',
  'time', 'mark', 'Section', 'label', 'figure', 'blockquote', 'article',
  'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'tbody', 'thead', 'tfoot', 'rowgroup',
]);
/** Имя такого контейнера — склейка текста его детей: при детях оно дублирует их. */
const CONCAT_NAME_ROLES = new Set(['LayoutTableCell', 'cell', 'gridcell', 'row', 'listitem', 'paragraph', 'Section', 'label']);
/** Пустые ячейки/строки таблиц-раскладок: ни имени, ни детей — ничего не несут. */
const EMPTY_LEAF_ROLES = new Set(['row', 'cell', 'gridcell', 'table', 'columnheader', 'rowheader']);
/** Текст без единой буквы/цифры — разделители «|», «·», «•». */
const PUNCT_ONLY = /^[^\p{L}\p{N}]*$/u;
const DROP_ROLES = new Set(['ListMarker']);
const TEXT_ROLES = new Set(['StaticText', 'paragraph', 'cell', 'gridcell', 'blockquote', 'listitem', 'LayoutTableCell']);

const LINE = /^(\s*)\[(\d+-\d+)\] ([^:]+?)(?:: (.*))?$/;

function compact(outline: string): string {
  const lines = outline.split('\n');
  const out: string[] = [];
  // Отступы оставшихся предков: строка встаёт на уровень их числа.
  const kept: number[] = [];
  const indentOf = (l: string | undefined) => (l === undefined ? -1 : l.length - l.trimStart().length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = LINE.exec(line);
    if (!m) {
      out.push(line.trim());
      continue;
    }
    const [, ws, id, role, rawName] = m;
    const indent = ws!.length;
    while (kept.length && kept[kept.length - 1]! >= indent) kept.pop();
    if (DROP_ROLES.has(role!)) continue;
    const hasChildren = indentOf(lines[i + 1]) > indent;
    const name = rawName !== undefined && CONCAT_NAME_ROLES.has(role!) && hasChildren ? undefined : rawName;
    if (!name && WRAPPER_ROLES.has(role!)) continue;
    if (!name && !hasChildren && EMPTY_LEAF_ROLES.has(role!)) continue;
    if (role === 'StaticText' && PUNCT_ONLY.test(name ?? '')) continue;
    let label = name;
    if (label && TEXT_ROLES.has(role!) && label.length > TEXT_CLIP) label = `${label.slice(0, TEXT_CLIP)}…`;
    out.push(`${'  '.repeat(kept.length)}[${id}] ${role}${label !== undefined ? `: ${label}` : ''}`);
    kept.push(indent);
  }
  return out.join('\n');
}

/** Режет по границам строк на куски не длиннее budget (строка длиннее — отдельным куском). */
function split(text: string, budget: number): string[] {
  const parts: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const line of text.split('\n')) {
    if (len + line.length + 1 > budget && cur.length) {
      parts.push(cur.join('\n'));
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) parts.push(cur.join('\n'));
  return parts;
}

export interface BudgetedOutline {
  text: string;
  /** Компактный вид вместо полного (обёртки убраны, длинный текст обрезан). */
  compacted: boolean;
  /** 1-based номер отданной части и их общее число (1 из 1 — без деления). */
  part: number;
  parts: number;
}

export function budgetOutline(
  outline: string,
  opts: { part?: number; full?: boolean; budget?: number } = {},
): BudgetedOutline {
  const budget = opts.budget ?? OUTLINE_BUDGET_CHARS;
  if (opts.full || outline.length <= budget) {
    return { text: outline, compacted: false, part: 1, parts: 1 };
  }
  const small = compact(outline);
  const parts = split(small, budget);
  const part = Math.min(Math.max(1, Math.floor(opts.part ?? 1)), parts.length);
  return { text: parts[part - 1]!, compacted: true, part, parts: parts.length };
}

/** Подпись под урезанным деревом: что опущено и как получить остальное. */
export function budgetNotice(b: BudgetedOutline): string {
  if (!b.compacted) return '';
  const lines = ['(Дерево большое — показан компактный вид: без обёрток, длинный текст обрезан. Полное — browser_snapshot с full=true; прочитать текст страницы — scrape.)'];
  if (b.parts > 1) {
    lines.push(
      b.part < b.parts
        ? `(Часть ${b.part} из ${b.parts}. Следующая — browser_snapshot с part=${b.part + 1}.)`
        : `(Часть ${b.part} из ${b.parts}, последняя.)`,
    );
  }
  return lines.join('\n');
}
