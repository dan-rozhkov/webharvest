export type ErrorCode =
  | 'invalid_url'
  | 'invalid_query'
  | 'blocked'
  | 'timeout'
  | 'not_html'
  | 'too_large'
  | 'network'
  | 'daemon_down'
  | 'search_unavailable'
  // Origin server answered (we got a real HTTP response, so this is neither
  // `network` nor `timeout`) but with an error status — 404, 410, 451, 500,
  // etc. Distinct from `blocked`: that's specifically an anti-bot challenge
  // recognized by signature, this is "the site itself says this failed".
  // The actual status lives in `detail.status` so the agent can tell a
  // missing page (404) from a broken one (500) without us maintaining a
  // second full status-code taxonomy.
  | 'upstream_error'
  | 'invalid_request'
  | 'not_found'
  // Пул сессий browser use заполнен (maxSessions), и все существующие
  // сессии сейчас заняты выполнением своего собственного действия — честный
  // отказ вместо того, чтобы либо вытеснить чужую активную сессию
  // (session-pool.ts, evictOldest), либо молча завести шестую сессию сверх
  // лимита. Агенту стоит закрыть неиспользуемую сессию или повторить запрос
  // чуть позже — не то же самое, что 'invalid_request' (ошибка не в
  // аргументах вызова) и не то же, что 'timeout' (никто никуда не завис).
  | 'busy'
  | 'internal';

export class HarvestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HarvestError';
  }

  toJSON(): { code: ErrorCode; message: string; detail?: Record<string, unknown> } {
    return { code: this.code, message: this.message, detail: this.detail };
  }

  static is(e: unknown): e is HarvestError {
    return e instanceof HarvestError;
  }
}
