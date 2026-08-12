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
 * Значение может быть подставлено под разными именами переменных в разное
 * время (см. JSDoc `BrowserSession.secrets` в session-pool.ts — там же и
 * причина, почему одно имя может держать НЕСКОЛЬКО значений). Имя нужно
 * только чтобы показать в outline понятный плейсхолдер `%имя%`; какое из
 * нескольких значений одного имени встретилось в тексте — не важно, оно всё
 * равно редактируется под тем же именем.
 *
 * Значения короче трёх символов отфильтровываются здесь же, а не в вызывающем
 * коде: реальный секрет такой длины ничего не защищает даже немаскированный,
 * а вот обычные короткие слова текста страницы («да», «ок», «to») совпадают
 * с ними постоянно — редактировать их значило бы портить не относящийся к
 * секретам текст ради защиты значения, которое и так не является секретом.
 * Более длинные значения ставятся раньше более коротких в результирующем
 * порядке: если одно подставленное значение — подстрока другого (variables
 * этого не запрещают), короткое не должно "перекусить" уже вставленный
 * плейсхолдер длинного и превратить его в мешанину из двух имён.
 */
function secretEntries(secrets: ReadonlyMap<string, ReadonlySet<string>>): [string, string][] {
  const flat: [string, string][] = [];
  for (const [name, values] of secrets) {
    for (const value of values) {
      if (value.length >= 3) flat.push([name, value]);
    }
  }
  return flat.sort((a, b) => b[1].length - a[1].length);
}

/**
 * Редактирует из произвольного текста все значения, которые демон когда-либо
 * подставил из `variables` в эту сессию browser use (см. `session.secrets` в
 * session-pool.ts). Для текста произвольной формы (в первую очередь — текста
 * ошибок playwright, см. `redactHarvestError` в daemon/service.ts): такой
 * текст не имеет предсказуемой структуры, поэтому единственный способ
 * гарантированно вычистить из него секрет — заменить все вхождения по всему
 * тексту. Для outline снапшота это слишком грубо (см. `redactOutlineSecrets`
 * ниже и её JSDoc, где объясняется, почему) — не используйте эту функцию для
 * outline.
 *
 * Пустая строка в variables (легитимный способ попросить "очисти поле")
 * заведомо отфильтрована в secretEntries() выше — `text.split('').join(...)`
 * вставил бы плейсхолдер между каждым символом и превратил бы весь текст в
 * кашу.
 */
export function redactSecrets(text: string, secrets: ReadonlyMap<string, ReadonlySet<string>>): string {
  if (!text || secrets.size === 0) return text;
  let out = text;
  for (const [name, value] of secretEntries(secrets)) {
    out = out.split(value).join(`%${name}%`);
  }
  return out;
}

// Адрес узла (см. encodeNodeId/formatTreeLine выше) — единственное, что эта
// функция обязана никогда не трогать. formatTreeLine всегда печатает его в
// квадратных скобках первым на строке (после отступа): `  [0-25] button:
// Войти`. Группа захватывает отступ вместе со скобками целиком.
const LINE_ADDRESS_PREFIX = /^(\s*\[[^\]]*\])/;

/**
 * Как `redactSecrets`, но для outline снапшота: на каждой строке редактирует
 * весь текст, КРОМЕ ведущего адреса узла в квадратных скобках (см.
 * `LINE_ADDRESS_PREFIX` выше) — именно и единственно там резолвер (a11y/
 * resolve.ts) ищет `[фрейм-backendNodeId]`, который агент потом возвращает
 * методам действий.
 *
 * Раньше здесь была глобальная замена по всему outline целиком — и она
 * ломала адреса: с `variables { qty: '100' }` строка `[0-1004] button: Add`
 * превращалась в `[0-%qty%4] button: Add`, потому что «100» — подстрока
 * «1004». Фильтр «длина >= 3» в secretEntries() эту находку не спасает:
 * 3-4-значные значения совпадают с частью 4-5-значного backendNodeId
 * регулярно, а не в редком краевом случае.
 *
 * Более узкий вариант — редактировать только сегмент после ` = `, который
 * печатает `formatValue` — тоже не годится: в реальном AX-дереве Chromium
 * значение текстового поля нередко экспонируется ДВАЖДЫ — и через
 * `node.value` родителя (` = значение`), и через отдельный дочерний
 * `StaticText`-узел на СВОЕЙ строке (`[0-14] StaticText: значение`, без
 * какого-либо ` = `). Ограничение только сегментом ` = ` оставляло бы
 * секрет читаемым на этой второй строке. Ведущий адрес — единственная
 * часть строки, которая гарантированно не содержит и не может содержать
 * подставленное значение (это разные, непересекающиеся данные узла), так
 * что исключить из замены можно и нужно только его: остальной текст строки
 * — роль, имя, флаги, значение — весь потенциально место утечки, и весь
 * редактируется. Это делает защиту адресов гарантией, а не эвристикой: сам
 * адрес физически не может быть задет, потому что он вообще не входит в
 * заменяемый сегмент — не «обычно не задевает», а не может в принципе.
 *
 * Строка без ведущего адреса (не вывод `formatTreeLine`, такого в outline не
 * бывает, но на всякий случай) редактируется целиком — протекции нечему
 * противостоять, раз в ней нет и не может быть адреса.
 */
export function redactOutlineSecrets(text: string, secrets: ReadonlyMap<string, ReadonlySet<string>>): string {
  if (!text || secrets.size === 0) return text;
  const entries = secretEntries(secrets);
  if (entries.length === 0) return text;

  return text
    .split('\n')
    .map((line) => {
      const m = line.match(LINE_ADDRESS_PREFIX);
      const head = m ? m[1]! : '';
      let rest = m ? line.slice(head.length) : line;
      for (const [name, secretValue] of entries) {
        rest = rest.split(secretValue).join(`%${name}%`);
      }
      return head + rest;
    })
    .join('\n');
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
