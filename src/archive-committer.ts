import type { GuildConfig } from "./config";
import { ConflictError, GitHub, GitHubError } from "./github";
import { BodyTooLargeError } from "./http";
import { readPendingBatch } from "./archive-storage";
import { errorMessage, joinPath, log } from "./util";

export const MAX_FLUSH_PATHS = 40;
export const MAX_FLUSH_BYTES = 4 * 1024 * 1024;
export const MAX_COMMIT_BYTES = 8 * 1024 * 1024;
const BLOCKED_PATH_RETRY_MS = 15 * 60_000;

interface CommitContext {
  sql: SqlStorage;
  get(key: string): string | null;
  set(key: string, value: string | null): void;
  github(guild: GuildConfig): GitHub;
}

/** Bounded archive commits that preserve every uncommitted row. */
export class ArchiveCommitter {
  constructor(private readonly context: CommitContext) {}

  /** Appends buffered lines to their day files in one commit. */
  async flush(guild: GuildConfig, through = Number.MAX_SAFE_INTEGER): Promise<{ committed: number; sha?: string }> {
    const batch = readPendingBatch(this.context.sql, MAX_FLUSH_BYTES, MAX_FLUSH_PATHS, Date.now(), through);
    const block = (path: string, reason: string) => {
      this.context.sql.exec(`INSERT INTO blocked_paths (path, reason, retry_at) VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET reason = excluded.reason, retry_at = excluded.retry_at`,
      path, reason, Date.now() + BLOCKED_PATH_RETRY_MS);
      log("flush_path_blocked", { path, reason });
    };
    for (const row of batch.oversized) {
      block(row.path, `Pending line ${row.n} exceeds ${MAX_FLUSH_BYTES} UTF-8 bytes. Export and split this record before retrying.`);
      batch.byPath.delete(row.path);
    }
    if (!batch.byPath.size) {
      if (!this.context.sql.exec(`SELECT 1 FROM pending LIMIT 1`).toArray().length) this.context.set("dirtySince", null);
      return { committed: 0 };
    }
    const gh = this.context.github(guild);
    const encoder = new TextEncoder();
    try {
      let sha: string | undefined;
      let committedRows: { n: number; path: string }[] = [];
      for (let attempt = 0; attempt < 4 && !sha; attempt++) {
        const head = await gh.branchHead(guild.branch);
        const files: { path: string; content: string }[] = [];
        committedRows = [];
        let bytes = 0;
        for (const [path, rows] of batch.byPath) {
          let existing: string | null;
          try { existing = head ? await gh.readFile(path, head, MAX_COMMIT_BYTES - 4096) : null; }
          catch (error) {
            if (!(error instanceof BodyTooLargeError)) throw error;
            block(path, `Existing file exceeds ${MAX_COMMIT_BYTES - 4096} UTF-8 bytes. Split this archive file before retrying.`);
            continue;
          }
          if (existing && !existing.endsWith("\n")) existing += "\n";
          const base = existing ?? "";
          const baseBytes = encoder.encode(base).byteLength;
          const lines: string[] = [];
          let addedBytes = 0;
          for (const row of rows) {
            const size = encoder.encode(row.line).byteLength + 1;
            if (bytes + baseBytes + addedBytes + size > MAX_COMMIT_BYTES - 4096) break;
            lines.push(row.line);
            addedBytes += size;
            committedRows.push(row);
          }
          if (!lines.length) {
            if (!files.length) block(path, `Existing file plus its next line exceeds ${MAX_COMMIT_BYTES - 4096} UTF-8 bytes. Split this archive file before retrying.`);
            continue;
          }
          files.push({ path, content: base + lines.join("\n") + "\n" });
          bytes += baseBytes + addedBytes;
        }
        if (!committedRows.length) return { committed: 0 };
        const archiveJson = joinPath(guild.path, "archive.json");
        const archiveJsonKey = `archiveJson:${guild.repo}:${guild.branch}:${guild.path}`;
        if (!head || (!this.context.get(archiveJsonKey) && !(await gh.readFile(archiveJson, head, 4096)))) {
          files.push({ path: archiveJson, content: JSON.stringify({ format: 2, guild_id: this.context.get("guildId"), generator: "rejgau" }, null, 2) + "\n" });
        }
        try {
          sha = await gh.commit(guild.branch, head, files, `Archive ${committedRows.length} events`);
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          log("flush_conflict", { attempt });
        }
      }
      if (!sha) throw new Error("branch kept moving; will retry");
      this.context.set(`archiveJson:${guild.repo}:${guild.branch}:${guild.path}`, "1");
      // Delete exact rows. A skipped oversized row can share a committed path.
      for (let i = 0; i < committedRows.length; i += 50) {
        const ids = committedRows.slice(i, i + 50).map((row) => row.n);
        this.context.sql.exec(`DELETE FROM pending WHERE n IN (${ids.map(() => "?").join(",")})`, ...ids);
      }
      for (const path of new Set(committedRows.map((row) => row.path))) this.context.sql.exec(`DELETE FROM blocked_paths WHERE path = ?`, path);
      const remaining = this.context.sql.exec(`SELECT 1 FROM pending LIMIT 1`).toArray().length > 0;
      this.context.set("dirtySince", remaining ? String(Date.now() - 3_600_000) : null);
      this.context.set("retryAt", null);
      this.context.set("failures", null);
      this.context.set("lastCommit", JSON.stringify({ sha, at: new Date().toISOString(), lines: committedRows.length }));
      if (guild.pages) this.context.set("dispatchPending", "1");
      this.context.set("lastError", null);
      log("flush_ok", { sha, lines: committedRows.length });
      return { committed: committedRows.length, sha };
    } catch (e) {
      const failures = Number(this.context.get("failures") ?? "0") + 1;
      this.context.set("failures", String(failures));
      const backoff = e instanceof GitHubError && e.retryAfterMs !== null ? Math.max(e.retryAfterMs, 60_000) : Math.min(15 * 60_000, 30_000 * 2 ** (failures - 1));
      this.context.set("retryAt", String(Date.now() + backoff));
      this.context.set("lastError", JSON.stringify({ at: new Date().toISOString(), error: errorMessage(e).slice(0, 500), status: e instanceof GitHubError ? e.status : undefined }));
      log("flush_error", { failures, error: errorMessage(e) });
      throw e;
    }
  }

}
