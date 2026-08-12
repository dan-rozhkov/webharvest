import { describe, it, expect } from 'vitest';
import {
  cleanText,
  normaliseSpaces,
  formatTreeLine,
  encodeNodeId,
  redactSecrets,
  redactOutlineSecrets,
} from '../../../src/core/a11y/format.js';
import type { A11yNode } from '../../../src/core/a11y/types.js';

/** Минимальный узел — в тестах интересны только заполненные поля. */
function node(partial: Partial<A11yNode> & { role: string }): A11yNode {
  return { nodeId: '1', ...partial };
}

describe('a11y/format: encodeNodeId', () => {
  it('склеивает ординал фрейма и backendNodeId через дефис', () => {
    expect(encodeNodeId(0, 18372)).toBe('0-18372');
  });
});

describe('a11y/format: cleanText', () => {
  it('выкидывает глифы Private Use Area', () => {
    expect(cleanText('\uE001Войти')).toBe('Войти');
  });

  it('схлопывает неразрывные пробелы в один обычный', () => {
    expect(cleanText('Цена\u00A0\u00A01000')).toBe('Цена 1000');
  });

  it('обрезает края', () => {
    expect(cleanText('  Отправить  ')).toBe('Отправить');
  });
});

describe('a11y/format: normaliseSpaces', () => {
  it('схлопывает пробельные серии, но не обрезает края', () => {
    expect(normaliseSpaces(' a \n\t b ')).toBe(' a b ');
  });
});

describe('a11y/format: formatTreeLine', () => {
  it('печатает ID, роль и имя', () => {
    expect(formatTreeLine(node({ role: 'button', name: 'Войти', encodedId: '0-25' })))
      .toBe('[0-25] button: Войти');
  });

  it('опускает двоеточие у безымянного узла', () => {
    expect(formatTreeLine(node({ role: 'generic', encodedId: '0-7' }))).toBe('[0-7] generic');
  });

  it('добавляет флаги состояния', () => {
    expect(formatTreeLine(node({ role: 'checkbox', name: 'Запомнить', checked: true, encodedId: '0-31' })))
      .toBe('[0-31] checkbox: Запомнить [checked]');
  });

  it('отступает детей на два пробела за уровень', () => {
    const tree = node({
      role: 'form',
      encodedId: '0-1',
      children: [
        node({ role: 'textbox', name: 'Email', encodedId: '0-2' }),
        node({ role: 'button', name: 'Отправить', encodedId: '0-3' }),
      ],
    });
    expect(formatTreeLine(tree)).toBe(
      '[0-1] form\n  [0-2] textbox: Email\n  [0-3] button: Отправить',
    );
  });

  it('падает обратно на nodeId, если encodedId не проставлен', () => {
    expect(formatTreeLine(node({ role: 'text', nodeId: '99' }))).toBe('[99] text');
  });

  it('печатает value обычного поля как есть — иначе diff после fill пуст, и агент считает, что ввод не сработал', () => {
    expect(formatTreeLine(node({ role: 'textbox', name: 'Город', value: 'Тбилиси', encodedId: '0-9' })))
      .toBe('[0-9] textbox: Город = Тбилиси');
  });

  it('маскирует value поля пароля фиксированной строкой независимо от длины ввода', () => {
    const line = formatTreeLine(
      node({ role: 'textbox', name: 'Пароль', value: 'секретный-пароль-123', encodedId: '0-9' }),
      0,
      { '0-9': 'input, password' },
    );
    expect(line).toBe('[0-9] textbox: Пароль = ••••');
    expect(line).not.toContain('секретный-пароль-123');
  });

  it('не печатает value, когда его нет', () => {
    expect(formatTreeLine(node({ role: 'button', name: 'Ок', encodedId: '0-1' }))).toBe('[0-1] button: Ок');
  });

  it('печатает value обычного текстового инпута как есть, даже если в него подставили переменную — маскировку по значению делает отдельно redactSecrets', () => {
    const line = formatTreeLine(
      node({ role: 'textbox', name: 'API key', value: 'sk-live-секрет', encodedId: '0-9' }),
      0,
      { '0-9': 'input, text' },
    );
    expect(line).toBe('[0-9] textbox: API key = sk-live-секрет');
  });
});

/** Map<имя, Set<значения>> — форма, которую принимают redactSecrets/redactOutlineSecrets. */
function secretsOf(pairs: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(pairs).map(([name, values]) => [name, new Set(values)]));
}

describe('a11y/format: redactSecrets (произвольный текст — например, текст ошибки playwright)', () => {
  it('вычищает подставленное значение из произвольного текста и заменяет на плейсхолдер с именем переменной', () => {
    const text = 'No option matched "sk-live-секрет"';
    const out = redactSecrets(text, secretsOf({ token: ['sk-live-секрет'] }));
    expect(out).not.toContain('sk-live-секрет');
    expect(out).toBe('No option matched "%token%"');
  });

  it('редактирует все вхождения значения, а не только первое', () => {
    const text = 'a=секрет123, снова секрет123';
    const out = redactSecrets(text, secretsOf({ x: ['секрет123'] }));
    expect(out).toBe('a=%x%, снова %x%');
  });

  it('редактирует сразу несколько разных секретов, длинный раньше короткого, если один — подстрока другого', () => {
    const text = 'field1=секрет-длинный, field2=секрет';
    const out = redactSecrets(text, secretsOf({ short: ['секрет'], long: ['секрет-длинный'] }));
    expect(out).toBe('field1=%long%, field2=%short%');
  });

  it('редактирует ВСЕ значения, зарегистрированные под одним именем, — не только последнее', () => {
    // Сценарий переиспользования имени переменной: browser_fill({token: 'AAAA'})
    // в одно поле, потом browser_fill({token: 'BBBB'}) в другое — оба значения
    // должны редактироваться, а не только 'BBBB'.
    const text = 'первое=AAAA-значение, второе=BBBB-значение';
    const out = redactSecrets(text, secretsOf({ token: ['AAAA-значение', 'BBBB-значение'] }));
    expect(out).toBe('первое=%token%, второе=%token%');
  });

  it('пустая строка в variables ничего не редактирует — не превращает текст в кашу', () => {
    const text = 'обычный текст без секретов';
    const out = redactSecrets(text, secretsOf({ empty: [''] }));
    expect(out).toBe(text);
  });

  it('очень короткие значения (короче трёх символов) не редактируются — иначе портили бы обычный текст', () => {
    const text = 'ок, ок ещё раз';
    const out = redactSecrets(text, secretsOf({ pin: ['ок'] }));
    expect(out).toBe(text);
  });

  it('без секретов на сессии текст не трогает', () => {
    const text = 'Тбилиси';
    expect(redactSecrets(text, new Map())).toBe(text);
  });

  it('пустой текст возвращает как есть', () => {
    expect(redactSecrets('', secretsOf({ x: ['секрет123'] }))).toBe('');
  });
});

describe('a11y/format: redactOutlineSecrets (outline снапшота — редактирует всю строку, кроме ведущего адреса в [скобках])', () => {
  it('вычищает подставленное значение из обычного текстового поля outline и заменяет на плейсхолдер с именем переменной', () => {
    const outline = '[0-9] textbox: API key = sk-live-секрет';
    const out = redactOutlineSecrets(outline, secretsOf({ token: ['sk-live-секрет'] }));
    expect(out).not.toContain('sk-live-секрет');
    expect(out).toBe('[0-9] textbox: API key = %token%');
  });

  it('вычищает значение из диффа снапшотов (diffOutlines применяется уже к отредактированным строкам)', () => {
    const before = '[0-9] textbox: API key';
    const after = '[0-9] textbox: API key = sk-live-секрет';
    const secrets = secretsOf({ token: ['sk-live-секрет'] });
    expect(redactOutlineSecrets(after, secrets)).not.toContain('sk-live-секрет');
    expect(redactOutlineSecrets(before, secrets)).toBe(before);
  });

  it('короткое числовое значение не ломает адреса соседних элементов — регрессия на находку код-ревью', () => {
    // Раньше редактирование шло по всему тексту outline целиком: с
    // variables { qty: '100' } строка `[0-1004] button: Add` превращалась в
    // `[0-%qty%4] button: Add`, потому что «100» — подстрока «1004».
    // Замена, исключающая только ведущие скобки на КАЖДОЙ строке, физически
    // не может задеть адрес соседнего узла — тот живёт в своих собственных
    // скобках на другой строке outline.
    const outline = '[0-1004] button: Add\n[0-2] textbox: Qty = 100';
    const out = redactOutlineSecrets(outline, secretsOf({ qty: ['100'] }));
    expect(out).toBe('[0-1004] button: Add\n[0-2] textbox: Qty = %qty%');
  });

  it('короткое числовое значение не ломает адрес даже на СВОЕЙ строке, но редактируется всюду за его пределами', () => {
    const outline = '[0-1004] textbox: Код 100 = 100';
    const out = redactOutlineSecrets(outline, secretsOf({ code: ['100'] }));
    // "100" внутри адреса `[0-1004]` не тронуто, а вот то же значение и в
    // имени узла, и в его value — оба за пределами скобок — редактируются:
    // ограничена только ведущая пара скобок, а не всё, что идёт до " = ".
    expect(out).toBe('[0-1004] textbox: Код %code% = %code%');
  });

  it('редактирует значение, даже когда оно попало не в сегмент " = ", а в имя узла на той же строке — так реальный AX-снапшот экспонирует value ДВАЖДЫ: через node.value родителя и через дочерний StaticText на своей строке без " = " вовсе', () => {
    const outline = '[0-14] StaticText: сложный-пароль';
    const out = redactOutlineSecrets(outline, secretsOf({ secret: ['сложный-пароль'] }));
    expect(out).not.toContain('сложный-пароль');
    expect(out).toBe('[0-14] StaticText: %secret%');
  });

  it('редактирует все вхождения значения на нескольких строках, а не только первое', () => {
    const outline = 'a = секрет123\nb = секрет123';
    const out = redactOutlineSecrets(outline, secretsOf({ x: ['секрет123'] }));
    expect(out).toBe('a = %x%\nb = %x%');
  });

  it('редактирует сразу несколько разных секретов, длинный раньше короткого, если один — подстрока другого', () => {
    const outline = 'field1 = секрет-длинный\nfield2 = секрет';
    const secrets = secretsOf({ short: ['секрет'], long: ['секрет-длинный'] });
    const out = redactOutlineSecrets(outline, secrets);
    expect(out).toBe('field1 = %long%\nfield2 = %short%');
  });

  it('редактирует ВСЕ значения, зарегистрированные под одним именем — сценарий переиспользования имени переменной', () => {
    const outline = '[0-1] textbox: Поле A = AAAA-значение\n[0-2] textbox: Поле B = BBBB-значение';
    const out = redactOutlineSecrets(outline, secretsOf({ token: ['AAAA-значение', 'BBBB-значение'] }));
    expect(out).toBe('[0-1] textbox: Поле A = %token%\n[0-2] textbox: Поле B = %token%');
  });

  it('пустая строка в variables ничего не редактирует — не превращает текст в кашу', () => {
    const outline = '[0-1] textbox: Комментарий = обычный текст без секретов';
    const out = redactOutlineSecrets(outline, secretsOf({ empty: [''] }));
    expect(out).toBe(outline);
  });

  it('очень короткие значения (короче трёх символов) не редактируются — иначе портили бы обычный текст страницы', () => {
    const outline = '[0-1] textbox: Код = ок, ок ещё раз';
    const out = redactOutlineSecrets(outline, secretsOf({ pin: ['ок'] }));
    expect(out).toBe(outline);
  });

  it('значение, встречающееся как подстрока обычного текста после " = ", тоже редактируется — осознанный компромисс в пользу безопасности', () => {
    const outline = 'x = несекретный текст';
    const out = redactOutlineSecrets(outline, secretsOf({ s: ['секрет'] }));
    expect(out).toBe('x = не%s%ный текст');
  });

  it('без секретов на сессии текст не трогает', () => {
    const outline = '[0-1] textbox: Город = Тбилиси';
    expect(redactOutlineSecrets(outline, new Map())).toBe(outline);
  });

  it('редактирует совпадение и без " = " в строке — например, в имени/роли узла — а не только в value', () => {
    const outline = '[0-1] button: Отправить';
    const out = redactOutlineSecrets(outline, secretsOf({ x: ['Отправить'] }));
    expect(out).toBe('[0-1] button: %x%');
  });

  it('никогда не трогает ведущий адрес в квадратных скобках, даже если он единственное, что совпадает с секретом', () => {
    const outline = '[0-100] button: Кнопка';
    // "0-100" целиком совпадает с "секретом" — но это адрес, а не текст узла.
    const out = redactOutlineSecrets(outline, secretsOf({ addr: ['0-100'] }));
    expect(out).toBe(outline);
  });

  it('пустой текст возвращает как есть', () => {
    expect(redactOutlineSecrets('', secretsOf({ x: ['секрет123'] }))).toBe('');
  });

  it('не портит маскировку password-полей — они уже замаскированы фиксированной строкой до вызова redactOutlineSecrets', () => {
    const line = formatTreeLine(
      node({ role: 'textbox', name: 'Пароль', value: 'секрет123', encodedId: '0-9' }),
      0,
      { '0-9': 'input, password' },
    );
    expect(line).toBe('[0-9] textbox: Пароль = ••••');
    // Даже если то же значение зарегистрировано как секрет variables, во
    // фиксированной маске password-поля просто нечего редактировать —
    // значения там уже нет.
    const redacted = redactOutlineSecrets(line, secretsOf({ password: ['секрет123'] }));
    expect(redacted).toBe(line);
  });
});
