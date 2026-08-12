/**
 * Рендер дерева в отступной outline и нормализация текста.
 *
 * Портировано из browserbase/stagehand (MIT),
 * packages/extension/understudy/a11y/snapshot/treeFormatUtils.ts
 * Copyright (c) Browserbase, Inc. См. NOTICE в корне репозитория.
 */
import type { A11yNode } from './types.js';

/** Адрес узла для модели: ординал фрейма и backendNodeId через дефис. */
export function encodeNodeId(frameOrdinal: number, backendNodeId: number): string {
  return `${frameOrdinal}-${backendNodeId}`;
}

const PUA_START = 0xe000;
const PUA_END = 0xf8ff;
/** Неразрывные и «узкие» пробелы плюс BOM: визуально пробел, для поиска — нет. */
const NBSP = new Set<number>([0x00a0, 0x202f, 0x2007, 0xfeff]);

/**
 * Чистка имени узла перед печатью. Диапазон Private Use Area — глифы
 * иконочных шрифтов: без своего шрифта не рендерятся ничем, но занимают токен.
 */
export function cleanText(input: string): string {
  let out = '';
  let prevSpace = false;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= PUA_START && code <= PUA_END) continue;
    if (NBSP.has(code)) {
      if (!prevSpace) {
        out += ' ';
        prevSpace = true;
      }
      continue;
    }
    out += input[i];
    prevSpace = input[i] === ' ';
  }
  return out.trim();
}

/**
 * Схлопывает пробельные серии в один пробел, но края не трогает — этим она и
 * отличается от `cleanText`. Нужна для сравнения имени родителя с конкатенацией
 * текстовых детей, где обрезка краёв дала бы ложное совпадение.
 */
export function normaliseSpaces(s: string): string {
  let out = '';
  let inWs = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      if (!inWs) {
        out += ' ';
        inWs = true;
      }
    } else {
      out += ch;
      inWs = false;
    }
  }
  return out;
}

function formatStateFlags(node: A11yNode): string {
  let flags = '';
  if (node.selected) flags += ' [selected]';
  if (node.checked) flags += ' [checked]';
  return flags;
}

/**
 * После успешного `type`/`fill` до этой правки outline не менялся вовсе —
 * `value` из AX-дерева нигде не печатался, поэтому diffOutlines() был пуст и
 * агент читал заполнение поля как "ничего не произошло" и повторял его,
 * задваивая текст. Пароль — исключение: замаскированное значение печатаем
 * фиксированной длины, не зависящей от реального ввода, потому что outline
 * уходит прямо в контекст модели, а секрет там появляться не должен даже
 * частично (в т.ч. через саму длину строки).
 */
function formatValue(node: A11yNode, tagNameMap: Record<string, string>): string {
  if (!node.value) return '';
  const isPassword = node.encodedId !== undefined && tagNameMap[node.encodedId] === 'input, password';
  return isPassword ? ' = ••••' : ` = ${cleanText(node.value)}`;
}

/**
 * Одна строка на узел: `[адрес] роль: имя [флаги] = значение`, дети с
 * отступом в два пробела за уровень. Ссылка в строку не попадает — она
 * лежит в `urlMap`, иначе модель начинает выдумывать URL вместо того, чтобы
 * вернуть ID. `tagNameMap` нужен только для того, чтобы отличить пароль от
 * остальных полей и замаскировать его значение — необязателен, потому что
 * узлов без значения (подавляющее большинство) это не касается вовсе.
 */
export function formatTreeLine(
  node: A11yNode,
  level = 0,
  tagNameMap: Record<string, string> = {},
): string {
  const indent = '  '.repeat(level);
  const labelId = node.encodedId ?? node.nodeId;
  const label = `[${labelId}] ${node.role}${node.name ? `: ${cleanText(node.name)}` : ''}${formatStateFlags(node)}${formatValue(node, tagNameMap)}`;
  const kids = node.children?.map((c) => formatTreeLine(c, level + 1, tagNameMap)).join('\n') ?? '';
  return kids ? `${indent}${label}\n${kids}` : `${indent}${label}`;
}
