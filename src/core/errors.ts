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
