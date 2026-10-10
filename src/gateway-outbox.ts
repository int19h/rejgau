import type { OutboxEvent } from "./env";

export type DeliveryRow = { n: number; guild: string; sid: string; s: number; t: string; d: string; at: number };

export interface DeliveryFailure {
  retryable: boolean;
  error: string;
  retryAt?: number;
}

export interface DeadLetterSummary {
  id: number;
  guild: string;
  eventType: string;
  sequence: number;
  receivedAt: number;
  error: string | null;
  canRetry: boolean;
}

export type DeadLetterRetry =
  | { requeued: true; id: number; guild: string }
  | { requeued: false; reason: "not_found" | "legacy" | "not_head"; error: string };

const BATCH = 100;
const MAX_RETRY_DELAY = 300_000;

/** Stores delivery order and retry deadlines separately for each guild. */
export class GatewayOutbox {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS outbox (n INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT NOT NULL, sid TEXT NOT NULL, s INTEGER NOT NULL, t TEXT NOT NULL, d TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dead (n INTEGER PRIMARY KEY, guild TEXT NOT NULL, sid TEXT NOT NULL, s INTEGER NOT NULL, t TEXT NOT NULL, d TEXT NOT NULL, at INTEGER NOT NULL, error TEXT, recoverable INTEGER NOT NULL DEFAULT 0)`);
    const columns = this.sql.exec<{ name: string }>(`PRAGMA table_info(dead)`).toArray();
    if (!columns.some((c) => c.name === "recoverable")) this.sql.exec(`ALTER TABLE dead ADD COLUMN recoverable INTEGER NOT NULL DEFAULT 0`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS delivery_retry (guild TEXT PRIMARY KEY, n INTEGER NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, error TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS outbox_guild_n ON outbox(guild, n)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS dead_guild_recoverable ON dead(guild, recoverable, n)`);
  }

  enqueue(guild: string, event: OutboxEvent): void {
    this.sql.exec(`INSERT INTO outbox (guild, sid, s, t, d, at) VALUES (?, ?, ?, ?, ?, ?)`, guild, event.sid, event.s, event.t, event.d, event.at);
  }

  private heads(active: ReadonlySet<string>): { guild: string; n: number; next_at: number }[] {
    const excluded = [...active];
    const filter = excluded.length ? `AND o.guild NOT IN (${excluded.map(() => "?").join(",")})` : "";
    return this.sql.exec<{ guild: string; n: number; next_at: number }>(
      `SELECT o.guild, MIN(o.n) AS n, COALESCE(r.next_at, 0) AS next_at
       FROM outbox o LEFT JOIN delivery_retry r ON r.guild = o.guild
       WHERE NOT EXISTS (SELECT 1 FROM dead d WHERE d.guild = o.guild AND d.recoverable = 1) ${filter}
       GROUP BY o.guild ORDER BY n`, ...excluded,
    ).toArray();
  }

  dueGuilds(now: number, active: ReadonlySet<string>, limit: number): string[] {
    return this.heads(active).filter((r) => r.next_at <= now).slice(0, limit).map((r) => r.guild);
  }

  nextDeadline(active: ReadonlySet<string>): number | null {
    const heads = this.heads(active);
    return heads.length ? Math.min(...heads.map((r) => r.next_at)) : null;
  }

  batch(guild: string): DeliveryRow[] {
    const rows = this.sql.exec<DeliveryRow>(`SELECT * FROM outbox WHERE guild = ? ORDER BY n LIMIT ?`, guild, BATCH).toArray();
    // The archive keeps one session watermark. A lost reply must remain safe to retry.
    const boundary = rows.findIndex((row) => row.sid !== rows[0].sid);
    return boundary < 0 ? rows : rows.slice(0, boundary);
  }

  accept(guild: string, rows: DeliveryRow[], handled: number): void {
    if (handled) this.sql.exec(`DELETE FROM outbox WHERE guild = ? AND n <= ?`, guild, rows[handled - 1].n);
    this.sql.exec(`DELETE FROM delivery_retry WHERE guild = ?`, guild);
  }

  fail(row: DeliveryRow, failure: DeliveryFailure, now: number): void {
    const error = failure.error.slice(0, 500);
    if (!failure.retryable) {
      this.storage.transactionSync(() => {
        this.sql.exec(`INSERT OR REPLACE INTO dead (n, guild, sid, s, t, d, at, error, recoverable) SELECT n, guild, sid, s, t, d, at, ?, 1 FROM outbox WHERE n = ?`, error, row.n);
        this.sql.exec(`DELETE FROM outbox WHERE n = ?`, row.n);
        this.sql.exec(`DELETE FROM delivery_retry WHERE guild = ?`, row.guild);
      });
      return;
    }
    const old = this.sql.exec<{ n: number; attempts: number; next_at: number }>(`SELECT n, attempts, next_at FROM delivery_retry WHERE guild = ?`, row.guild).toArray()[0];
    const previous = old?.n === row.n ? old.attempts : 0;
    const deferred = Number.isSafeInteger(failure.retryAt) && failure.retryAt! > now && failure.retryAt! <= 8.64e15;
    const attempts = deferred ? previous : Math.min(previous + 1, Number.MAX_SAFE_INTEGER);
    const delay = deferred ? failure.retryAt! - now : Math.min(MAX_RETRY_DELAY, 5000 * 2 ** Math.min(attempts - 1, 16));
    const next = Math.max(now + delay, old?.n === row.n ? old.next_at : 0);
    this.sql.exec(`INSERT INTO delivery_retry (guild, n, attempts, next_at, error) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild) DO UPDATE SET n = excluded.n, attempts = excluded.attempts, next_at = excluded.next_at, error = excluded.error`, row.guild, row.n, attempts, next, error);
  }

  counts(): { outbox: number; deadLetters: number; retryGuilds: number; blockedGuilds: number } {
    const count = (query: string) => this.sql.exec<{ n: number }>(query).one().n;
    return {
      outbox: count(`SELECT COUNT(*) AS n FROM outbox`),
      deadLetters: count(`SELECT COUNT(*) AS n FROM dead`),
      retryGuilds: count(`SELECT COUNT(*) AS n FROM delivery_retry`),
      blockedGuilds: count(`SELECT COUNT(DISTINCT guild) AS n FROM dead WHERE recoverable = 1`),
    };
  }

  list({ guild, after = 0, limit = 25 }: { guild?: string; after?: number; limit?: number } = {}): { items: DeadLetterSummary[]; next: number | null } {
    if (guild !== undefined && (typeof guild !== "string" || !/^\d{1,20}$/.test(guild))) throw new TypeError("guild must be an ID string");
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("after and limit are outside their allowed ranges");
    const rows = this.sql.exec<{ n: number; guild: string; t: string; s: number; at: number; error: string | null; recoverable: number }>(
      `SELECT n, guild, t, s, at, error, recoverable FROM dead WHERE n > ? ${guild === undefined ? "" : "AND guild = ?"} ORDER BY n LIMIT ?`,
      after, ...(guild === undefined ? [] : [guild]), limit + 1,
    ).toArray();
    const items = rows.slice(0, limit).map((r) => ({ id: r.n, guild: r.guild, eventType: r.t, sequence: r.s, receivedAt: r.at, error: r.error, canRetry: r.recoverable === 1 }));
    return { items, next: rows.length > limit ? items.at(-1)!.id : null };
  }

  retry({ id, guild }: { id: number; guild: string }): DeadLetterRetry {
    if (!Number.isSafeInteger(id) || id < 1 || typeof guild !== "string" || !/^\d{1,20}$/.test(guild)) throw new TypeError("id and guild must identify one dead letter");
    return this.storage.transactionSync(() => {
      const row = this.sql.exec<{ recoverable: number }>(`SELECT recoverable FROM dead WHERE n = ? AND guild = ?`, id, guild).toArray()[0];
      if (!row) return { requeued: false, reason: "not_found", error: "The dead letter does not exist for this guild." };
      if (!row.recoverable) return { requeued: false, reason: "legacy", error: "Legacy events cannot replay automatically. Later events already advanced the archive state." };
      if (this.sql.exec(`SELECT 1 FROM dead WHERE guild = ? AND recoverable = 1 AND n < ? LIMIT 1`, guild, id).toArray().length) {
        return { requeued: false, reason: "not_head", error: "Retry the first quarantined event for this guild." };
      }
      this.sql.exec(`INSERT INTO outbox (n, guild, sid, s, t, d, at) SELECT n, guild, sid, s, t, d, at FROM dead WHERE n = ? AND guild = ?`, id, guild);
      this.sql.exec(`DELETE FROM dead WHERE n = ? AND guild = ?`, id, guild);
      this.sql.exec(`DELETE FROM delivery_retry WHERE guild = ?`, guild);
      return { requeued: true, id, guild };
    });
  }
}
