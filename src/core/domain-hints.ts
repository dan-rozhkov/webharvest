/** Память о том, что домен уже показал: без браузера контент не отдаётся.
 *  Не источник истины — только memo результата, к которому уже пришёл
 *  shouldEscalate; запись стирается по TTL, чтобы домен получал новый шанс
 *  на дешёвый HTTP-путь (сайты меняют защиту). */
export class DomainHints {
  private readonly map = new Map<string, number>();

  constructor(private readonly ttlMs: number = 24 * 60 * 60_000) {}

  needsBrowser(host: string): boolean {
    const until = this.map.get(host);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.map.delete(host);
      return false;
    }
    return true;
  }

  markNeedsBrowser(host: string): void {
    this.map.set(host, Date.now() + this.ttlMs);
  }
}
