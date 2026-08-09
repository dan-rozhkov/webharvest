import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { normalizeUrl } from './url.js';

export class Cache {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_expires ON entries(expires_at);
    `);
  }

  get(key: string): string | null {
    const row = this.db
      .prepare('SELECT value, expires_at FROM entries WHERE key = ?')
      .get(key) as { value: string; expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.delete(key);
      return null;
    }
    return row.value;
  }

  set(key: string, value: string, ttlMs: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO entries (key, value, created_at, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           created_at = excluded.created_at, expires_at = excluded.expires_at`,
      )
      .run(key, value, now, now + ttlMs);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM entries WHERE key = ?').run(key);
  }

  purgeExpired(): number {
    return this.db.prepare('DELETE FROM entries WHERE expires_at <= ?').run(Date.now()).changes;
  }

  close(): void {
    this.db.close();
  }
}

export function scrapeKey(url: string, opts: { includeLinks: boolean }): string {
  const normalized = normalizeUrl(url);
  return createHash('sha256')
    .update(`scrape:${normalized}:${opts.includeLinks}`)
    .digest('hex');
}
