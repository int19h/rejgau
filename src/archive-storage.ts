export function initializeArchiveStorage(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS pending (n INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, line TEXT NOT NULL, at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY, json TEXT NOT NULL, type INTEGER NOT NULL, parent_id TEXT, flags INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 0, last_message_id TEXT,
    cursor TEXT, cursor_kind TEXT, rest_next_at INTEGER NOT NULL DEFAULT 0, rest_failures INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0)`);
  const columns = sql.exec<{ name: string }>(`PRAGMA table_info(channels)`).toArray();
  if (!columns.some((column) => column.name === "missing")) {
    sql.exec(`ALTER TABLE channels ADD COLUMN missing INTEGER NOT NULL DEFAULT 0`);
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS media (
    key TEXT PRIMARY KEY, url TEXT, channel_id TEXT, message_id TEXT, month TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS media_due ON media(status, next_at)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS members_pending ON members(done)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS channels_due ON channels(selected, rest_next_at) WHERE cursor IS NOT NULL`);
  sql.exec(`CREATE TABLE IF NOT EXISTS blocked_paths (path TEXT PRIMARY KEY, reason TEXT NOT NULL, retry_at INTEGER NOT NULL)`);
}

export type PendingRow = { n: number; path: string; line: string };
export interface PendingBatch {
  byPath: Map<string, PendingRow[]>;
  bytes: number;
  oversized: Pick<PendingRow, "n" | "path">[];
}

/** Read only the rows that fit the batch. Preserve oversized rows for the operator. */
export function readPendingBatch(sql: SqlStorage, maxBytes: number, maxPaths: number, now = Date.now(), through = Number.MAX_SAFE_INTEGER): PendingBatch {
  const batch: PendingBatch = { byPath: new Map(), bytes: 0, oversized: [] };
  const encoder = new TextEncoder();
  const rows = sql.exec<PendingRow>(`SELECT n, path, line FROM pending
    WHERE n <= ? AND path NOT IN (SELECT path FROM blocked_paths WHERE retry_at > ?)
    ORDER BY n`, through, now);
  for (const row of rows) {
    const size = encoder.encode(row.line).byteLength + 1;
    if (size > maxBytes) {
      batch.oversized.push({ n: row.n, path: row.path });
      // Bound both diagnostics and rows that do not fit the batch.
      if (batch.oversized.length >= maxPaths) break;
      continue;
    }
    if (!batch.byPath.has(row.path) && batch.byPath.size >= maxPaths) break;
    if (batch.bytes + size > maxBytes) break;
    if (!batch.byPath.has(row.path)) batch.byPath.set(row.path, []);
    batch.byPath.get(row.path)!.push(row);
    batch.bytes += size;
  }
  return batch;
}
