/**
 * Построчный диф двух снапшотов. После действия модели нужно показать не всё
 * дерево заново, а только то, что появилось — на длинной сессии это разница
 * в разы по токенам.
 *
 * Сравнение идёт по содержимому строки без ведущих пробелов: сдвиг отступа
 * означает, что узел переехал по иерархии, а не что он новый.
 *
 * Портировано из browserbase/stagehand (MIT),
 * packages/extension/understudy/a11y/snapshot/treeFormatUtils.ts
 * Copyright (c) Browserbase, Inc. См. NOTICE в корне репозитория.
 */
export function diffOutlines(prev: string, next: string): string {
  const seen = new Set(
    (prev || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );

  const added = (next || '').split('\n').filter((line) => {
    const core = line.trim();
    return core.length > 0 && !seen.has(core);
  });
  if (added.length === 0) return '';

  // Переиндентация к нулю: иначе вырванный из середины кусок приезжает модели
  // с отступом, который ничего не значит без родителей.
  let minIndent = Infinity;
  for (const line of added) {
    minIndent = Math.min(minIndent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;

  return added.map((l) => l.slice(minIndent)).join('\n');
}
