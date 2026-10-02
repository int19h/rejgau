export interface DiscordLimitObservation {
  path: string;
  bucket?: string | null;
  global?: boolean;
  retryAt?: number;
  remaining?: number | null;
  resetAt?: number;
}

/** Keeps the major resource ID while grouping message and member IDs. */
export function discordRoute(path: string): { route: string; major: string } {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > 2048) {
    throw new TypeError("Discord path must be a relative API path");
  }
  const parts = path.split("?", 1)[0].split("/");
  const hasMajor = (parts[1] === "channels" || parts[1] === "guilds") && /^\d{1,20}$/.test(parts[2] ?? "");
  const major = hasMajor ? `${parts[1]}:${parts[2]}` : "none";
  const route = `GET ${parts.map((part, i) => /^\d+$/.test(part) && !(hasMajor && i === 2) ? ":id" : part).join("/")}`;
  return { route, major };
}

/** Shares server cooldowns across all guilds that use this bot. */
export class DiscordCooldowns {
  private lastPruneAt = 0;

  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS discord_cooldown (key TEXT PRIMARY KEY, until_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS discord_bucket (route TEXT PRIMARY KEY, bucket TEXT NOT NULL, major TEXT NOT NULL, seen_at INTEGER NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS discord_cooldown_until ON discord_cooldown(until_at)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS discord_bucket_seen ON discord_bucket(seen_at)`);
    this.prune(Date.now());
  }

  /** Old aliases expire only after their active cooldowns end. */
  private prune(now: number): void {
    if (now - this.lastPruneAt < 60_000) return;
    this.lastPruneAt = now;
    this.sql.exec(`DELETE FROM discord_cooldown WHERE until_at <= ?`, now);
    this.sql.exec(`DELETE FROM discord_bucket WHERE seen_at < ?
      AND NOT EXISTS (SELECT 1 FROM discord_cooldown c WHERE c.key = 'route:' || discord_bucket.route
        OR c.key = 'bucket:' || discord_bucket.major || ':' || discord_bucket.bucket)`, now - 86_400_000);
  }

  private deadline(key: string): number {
    return this.sql.exec<{ until_at: number }>(`SELECT until_at FROM discord_cooldown WHERE key = ?`, key).toArray()[0]?.until_at ?? 0;
  }

  private extend(key: string, until: number): void {
    if (!Number.isSafeInteger(until) || until < 0 || until > 8.64e15) throw new TypeError("Discord retry deadline must be a finite timestamp");
    this.sql.exec(`INSERT INTO discord_cooldown (key, until_at) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET until_at = MAX(until_at, excluded.until_at)`, key, until);
  }

  private bucket(route: string, major: string): string | null {
    const hash = this.sql.exec<{ bucket: string }>(`SELECT bucket FROM discord_bucket WHERE route = ?`, route).toArray()[0]?.bucket;
    return hash ? `bucket:${major}:${hash}` : null;
  }

  deadlineFor(path: string): number {
    this.prune(Date.now());
    const { route, major } = discordRoute(path);
    const bucket = this.bucket(route, major);
    return Math.max(this.deadline("global"), this.deadline(`route:${route}`), bucket ? this.deadline(bucket) : 0);
  }

  observe(input: DiscordLimitObservation): number {
    this.prune(Date.now());
    const { route, major } = discordRoute(input.path);
    if (input.bucket) {
      if (input.bucket.length > 256) throw new TypeError("Discord bucket ID is too long");
      this.sql.exec(`INSERT INTO discord_bucket (route, bucket, major, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(route) DO UPDATE SET bucket = excluded.bucket, major = excluded.major, seen_at = excluded.seen_at`, route, input.bucket, major, Date.now());
    }
    if (input.global === true && input.retryAt !== undefined) this.extend("global", input.retryAt);
    else {
      const until = Math.max(input.retryAt ?? 0, input.remaining === 0 ? input.resetAt ?? 0 : 0);
      if (until) {
        this.extend(`route:${route}`, until);
        const bucket = this.bucket(route, major);
        if (bucket) this.extend(bucket, until);
      }
    }
    return this.deadlineFor(input.path);
  }
}
