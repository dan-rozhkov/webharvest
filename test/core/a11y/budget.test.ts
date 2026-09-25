import { describe, it, expect } from 'vitest';
import { budgetOutline, budgetNotice } from '../../../src/core/a11y/budget.js';

const SMALL = `[0-1] RootWebArea: Shop
  [0-2] div
    [0-3] button: Buy`;

describe('a11y/budget', () => {
  it('маленькое дерево отдаёт как есть', () => {
    const b = budgetOutline(SMALL);
    expect(b).toMatchObject({ text: SMALL, compacted: false, part: 1, parts: 1 });
    expect(budgetNotice(b)).toBe('');
  });

  it('в компактном виде убирает безымянные обёртки и маркеры, пересчитывая отступы', () => {
    const outline = `[0-1] RootWebArea: Shop
  [0-2] div
    [0-3] list
      [0-4] listitem
        [0-5] ListMarker: •
        [0-6] link: Home
    [0-7] StaticText: |
    [0-8] button: Buy`;
    const b = budgetOutline(outline, { budget: 50 });
    expect(b.compacted).toBe(true);
    const all = Array.from({ length: b.parts }, (_, i) => budgetOutline(outline, { budget: 50, part: i + 1 }).text).join('\n');
    expect(all).toBe(`[0-1] RootWebArea: Shop
  [0-6] link: Home
  [0-8] button: Buy`);
  });

  it('имя контейнера с детьми не дублирует их текст, длинный текст обрезается', () => {
    const long = 'x'.repeat(200);
    const outline = `[0-1] RootWebArea: T
  [0-2] LayoutTableCell: Home | About
    [0-3] link: Home
  [0-4] StaticText: ${long}`;
    const text = budgetOutline(outline, { budget: 10_000, full: false, part: 1 }).text;
    expect(text).toBe(outline); // влезло — не трогаем
    const compacted = budgetOutline(outline, { budget: 150 });
    expect(compacted.text).not.toContain('Home | About');
    expect(compacted.text).toContain('[0-3] link: Home');
    expect(compacted.text).toContain(`${'x'.repeat(80)}…`);
  });

  it('делит на части по строкам и подсказывает следующую', () => {
    const outline = ['[0-1] RootWebArea: T', ...Array.from({ length: 50 }, (_, i) => `  [0-${i + 2}] button: Button number ${i}`)].join('\n');
    const first = budgetOutline(outline, { budget: 400 });
    expect(first.parts).toBeGreaterThan(1);
    expect(first.text.length).toBeLessThanOrEqual(400);
    expect(budgetNotice(first)).toContain('part=2');
    const last = budgetOutline(outline, { budget: 400, part: 999 });
    expect(last.part).toBe(first.parts);
    expect(budgetNotice(last)).toContain('последняя');
    // Ни одна строка не потерялась между частями.
    const joined = Array.from({ length: first.parts }, (_, i) => budgetOutline(outline, { budget: 400, part: i + 1 }).text).join('\n');
    expect(joined.split('\n')).toHaveLength(51);
  });

  it('full отдаёт полное дерево без бюджета', () => {
    const outline = 'y'.repeat(100_000);
    expect(budgetOutline(outline, { full: true }).text).toBe(outline);
  });
});
