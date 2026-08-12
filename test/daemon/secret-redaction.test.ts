import { describe, it, expect } from 'vitest';
import { registerSecrets, redactSnapshot, redactHarvestError } from '../../src/daemon/service.js';
import { HarvestError } from '../../src/core/errors.js';
import type { A11ySnapshot } from '../../src/core/a11y/types.js';

// Юниты для куска performAction, который закрывает HIGH-находку: значение,
// подставленное browser_fill/browser_type через variables в обычный (не
// password) input, не должно уходить наружу ни в outline, ни в диф, ни в
// снапшот следующего вызова на той же сессии. Здесь эта логика проверяется
// как чистые функции — без реального Chromium, тем же приёмом, что
// assertUrlIsSafe/assertSessionUrlSafePure в browser-url-safety.test.ts.

function snapshot(outline: string): A11ySnapshot {
  return { outline, urlMap: {}, xpathMap: {}, tagNameMap: {} };
}

describe('daemon/service: registerSecrets — секреты копятся по сессии', () => {
  it('добавляет переменные из variables в session.secrets', () => {
    const session = { secrets: new Map<string, Set<string>>() };
    registerSecrets(session, { token: 'sk-live-секрет' });
    expect(session.secrets.get('token')).toEqual(new Set(['sk-live-секрет']));
  });

  it('копит значения через несколько вызовов act, а не перезаписывает набор целиком', () => {
    // Именно это и защищает от третьего вектора утечки из находки: значение,
    // подставленное ОДНИМ вызовом act, остаётся в DOM страницы и должно
    // редактироваться из снапшота СЛЕДУЮЩЕГО вызова, даже если у того своих
    // variables нет вовсе.
    const session = { secrets: new Map<string, Set<string>>() };
    registerSecrets(session, { token: 'sk-live-секрет' });
    registerSecrets(session, undefined);
    registerSecrets(session, { password: 'ещё-секрет' });

    expect(session.secrets.get('token')).toEqual(new Set(['sk-live-секрет']));
    expect(session.secrets.get('password')).toEqual(new Set(['ещё-секрет']));
    expect(session.secrets.size).toBe(2);
  });

  it('переиспользование одного имени переменной с разными значениями копит ОБА значения, а не только последнее', () => {
    // Находка код-ревью: browser_fill #1 с {token: 'AAAA'} в одно поле, потом
    // #2 с {token: 'BBBB'} в другое. В Map<string, string> второй вызов
    // затирал бы первое значение — 'AAAA', всё ещё живущее в DOM первого
    // поля, переставало бы редактироваться и утекало бы в outline.
    const session = { secrets: new Map<string, Set<string>>() };
    registerSecrets(session, { token: 'AAAA' });
    registerSecrets(session, { token: 'BBBB' });

    const values = session.secrets.get('token');
    expect(values).toEqual(new Set(['AAAA', 'BBBB']));
    expect(values?.size).toBe(2);
  });

  it('без variables ничего не делает', () => {
    const session = { secrets: new Map<string, Set<string>>() };
    registerSecrets(session, undefined);
    expect(session.secrets.size).toBe(0);
  });
});

describe('daemon/service: redactSnapshot', () => {
  it('вычищает подставленное значение из outline обычного текстового поля', () => {
    const raw = snapshot('[0-2] textbox: API key = sk-live-секрет-токен');
    const secrets = new Map([['token', new Set(['sk-live-секрет-токен'])]]);
    const redacted = redactSnapshot(raw, secrets);
    expect(redacted.outline).not.toContain('sk-live-секрет-токен');
    expect(redacted.outline).toContain('%token%');
  });

  it('без секретов на сессии возвращает тот же объект без изменений', () => {
    const raw = snapshot('[0-1] textbox: Город = Тбилиси');
    const redacted = redactSnapshot(raw, new Map());
    expect(redacted).toBe(raw);
  });

  it('редактирует значение и в снапшоте следующего вызова на той же сессии, если оно уже было зарегистрировано раньше', () => {
    const session = { secrets: new Map<string, Set<string>>() };
    registerSecrets(session, { token: 'sk-live-секрет-токен' });

    // Снапшот, снятый следующим browser_snapshot/действием без своих
    // variables — значение всё ещё в DOM с прошлого действия, и всё ещё
    // должно вычищаться.
    const nextCallSnapshot = snapshot('[0-2] textbox: API key = sk-live-секрет-токен');
    const redacted = redactSnapshot(nextCallSnapshot, session.secrets);
    expect(redacted.outline).not.toContain('sk-live-секрет-токен');
  });

  it('переиспользование имени переменной: оба значения редактируются в снапшоте, даже если каждое попало в своё поле', () => {
    const session = { secrets: new Map<string, Set<string>>() };
    registerSecrets(session, { token: 'AAAA-секрет' });
    registerSecrets(session, { token: 'BBBB-секрет' });

    const raw = snapshot('[0-1] textbox: Поле A = AAAA-секрет\n[0-2] textbox: Поле B = BBBB-секрет');
    const redacted = redactSnapshot(raw, session.secrets);
    expect(redacted.outline).not.toContain('AAAA-секрет');
    expect(redacted.outline).not.toContain('BBBB-секрет');
    expect(redacted.outline).toBe('[0-1] textbox: Поле A = %token%\n[0-2] textbox: Поле B = %token%');
  });

  it('короткое числовое значение переменной не портит адрес соседнего элемента', () => {
    const raw = snapshot('[0-1004] button: Add\n[0-2] textbox: Qty = 100');
    const secrets = new Map([['qty', new Set(['100'])]]);
    const redacted = redactSnapshot(raw, secrets);
    expect(redacted.outline).toBe('[0-1004] button: Add\n[0-2] textbox: Qty = %qty%');
  });
});

describe('daemon/service: redactHarvestError', () => {
  it('вычищает секрет из текста ошибки, сохраняя код и detail', () => {
    const secrets = new Map([['token', new Set(['sk-live-секрет-токен'])]]);
    const original = new HarvestError(
      'invalid_request',
      'Действие selectOptionFromDropdown над 0-2 не удалось: No option matched "sk-live-секрет-токен"',
      { foo: 'bar' },
    );
    const redacted = redactHarvestError(original, secrets);
    expect(redacted.code).toBe('invalid_request');
    expect(redacted.detail).toEqual({ foo: 'bar' });
    expect(redacted.message).not.toContain('sk-live-секрет-токен');
    expect(redacted.message).toContain('%token%');
  });

  it('без секретов на сессии возвращает ту же ошибку без изменений', () => {
    const original = new HarvestError('invalid_request', 'что-то пошло не так');
    expect(redactHarvestError(original, new Map())).toBe(original);
  });
});
