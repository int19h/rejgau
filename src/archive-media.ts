import type { Config, GuildConfig } from "./config";
import { discordGet, DiscordError, DiscordRateLimitError } from "./discord";
import type { Env } from "./env";
import { GitHub, GitHubAuthError, GitHubError, type Asset } from "./github";
import { fetchWithDeadline } from "./http";
import { mediaInMessage, type MediaRef } from "./media";
import { errorMessage, log } from "./util";

const MEDIA_MAX_ATTEMPTS = 4;
const RELEASE_ASSET_LIMIT = 1000;
class ReleaseFullError extends Error {}

interface MediaContext {
  sql: SqlStorage;
  env: Env;
  get(key: string): string | null;
  set(key: string, value: string | null): void;
  github(guild: GuildConfig): GitHub;
  emit(guild: GuildConfig, type: string, data: unknown): void;
}

type MediaRow = {
  key: string;
  url: string | null;
  channel_id: string | null;
  message_id: string | null;
  month: string;
  attempts: number;
};

/** Durable media jobs, independent from log commit scheduling. */
export class ArchiveMediaQueue {
  constructor(private readonly context: MediaContext) {}

  enqueue(refs: MediaRef[], month: string): void {
    for (const r of refs) {
      this.context.sql.exec(
        `INSERT OR IGNORE INTO media (key, url, channel_id, message_id, month, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        r.key, r.url, r.channelId ?? null, r.messageId ?? null, month,
      );
    }
  }
  /** Downloads one pending media item and uploads it as a release asset, paced for GitHub's limits. */
  async work(cfg: Config, guild: GuildConfig): Promise<void> {
    const now = Date.now();
    if (now < Number(this.context.get("githubBackoffUntil") ?? "0")) return;
    // Default spacing (8 s) keeps uploads under GitHub's 80/min and 500/h content-creation limits.
    if (now < Number(this.context.get("lastUploadAt") ?? "0") + cfg.mediaSpacingMs) return;
    const row = this.context.sql
      .exec<MediaRow>(`SELECT key, url, channel_id, message_id, month, attempts FROM media WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 1`, now)
      .toArray()[0];
    if (!row) return;
    try {
      const result = await this.storeMedia(cfg, guild, row);
      // Attachments carry their channel, so their records are filed (and removable) with it.
      this.context.emit(guild, result.ok ? "MEDIA_STORED" : "MEDIA_FAILED", { ...result.record, ...(row.channel_id ? { channel_id: row.channel_id } : {}) });
      this.context.sql.exec(`UPDATE media SET status = ? WHERE key = ?`, result.ok ? "done" : "failed", row.key);
    } catch (e) {
      if (e instanceof ReleaseFullError) {
        this.context.sql.exec(`UPDATE media SET next_at = ? WHERE key = ?`, Date.now() + 1000, row.key);
        return;
      }
      if (e instanceof DiscordRateLimitError) {
        this.context.sql.exec(`UPDATE media SET next_at = ? WHERE key = ?`, e.retryAt, row.key);
        return;
      }
      if (e instanceof GitHubError && (e.retryAfterMs !== null || e instanceof GitHubAuthError)) {
        // Rate limited, or the App can't access the repo (a setup problem): back off globally
        // without charging the item an attempt, so fixing the setup loses nothing.
        const wait = e.retryAfterMs !== null ? Math.max(e.retryAfterMs, 60_000) : 5 * 60_000;
        this.context.set("githubBackoffUntil", String(Date.now() + wait));
        this.context.set("lastError", JSON.stringify({ at: new Date().toISOString(), error: errorMessage(e).slice(0, 500), status: e.status }));
        log("github_backoff", { waitMs: wait, error: errorMessage(e) });
        return;
      }
      const attempts = row.attempts + 1;
      log("media_error", { key: row.key, attempts, error: errorMessage(e) });
      if (attempts >= MEDIA_MAX_ATTEMPTS) {
        this.context.emit(guild, "MEDIA_FAILED", { key: row.key, reason: errorMessage(e).slice(0, 200), ...(row.channel_id ? { channel_id: row.channel_id } : {}) });
        this.context.sql.exec(`UPDATE media SET status = 'failed', attempts = ? WHERE key = ?`, attempts, row.key);
      } else {
        this.context.sql.exec(`UPDATE media SET attempts = ?, next_at = ? WHERE key = ?`, attempts, Date.now() + 60_000 * 2 ** attempts, row.key);
      }
    } finally {
      this.context.set("lastUploadAt", String(Date.now()));
    }
  }

  private async download(row: MediaRow): Promise<Response | null> {
    if (!row.url) return null;
    const res = await fetchWithDeadline(row.url);
    if (res.ok || !(res.status === 403 || res.status === 404) || !row.message_id || !row.channel_id) return res;
    // Signed attachment URLs expire; get fresh ones from the message.
    await res.body?.cancel();
    let msg: Record<string, any>;
    try {
      msg = await discordGet<Record<string, any>>(this.context.env, `/channels/${row.channel_id}/messages/${row.message_id}`);
    } catch (error) {
      if (error instanceof DiscordError && (error.status === 403 || error.status === 404)) return new Response(null, { status: error.status });
      throw error;
    }
    const fresh = msg && mediaInMessage(msg, this.context.get("guildId")!).find((r) => r.key === row.key);
    if (!fresh?.url) return new Response(null, { status: 404 });
    this.context.sql.exec(`UPDATE media SET url = ? WHERE key = ?`, fresh.url, row.key);
    return fetchWithDeadline(fresh.url);
  }

  private async storeMedia(cfg: Config, guild: GuildConfig, row: MediaRow): Promise<{ ok: boolean; record: Record<string, unknown> }> {
    if (!row.url) return { ok: false, record: { key: row.key, reason: "unsupported" } };
    const gh = this.context.github(guild);
    const release = await this.release(gh, row.month, row.key);
    if (release.asset) return { ok: true, record: this.assetRecord(release.tag, row.key, release.asset) };
    const res = await this.download(row);
    if (!res) return { ok: false, record: { key: row.key, reason: "unsupported" } };
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 404 || res.status === 403 || res.status === 410) return { ok: false, record: { key: row.key, reason: `http_${res.status}` } };
      throw new Error(`download HTTP ${res.status}`);
    }
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    // With Content-Encoding, fetch hands us decoded bytes but Content-Length counts encoded ones.
    const declared = res.headers.has("content-encoding") ? NaN : Number(res.headers.get("content-length") ?? "NaN");
    let body: ReadableStream | ArrayBuffer;
    let length: number;
    if (Number.isFinite(declared)) {
      if (declared > cfg.maxMediaBytes) {
        await res.body?.cancel();
        return { ok: false, record: { key: row.key, reason: "too_large", size: declared } };
      }
      body = res.body!;
      length = declared;
    } else {
      // Unknown length: buffer, but never more than the cap (or 32 MB, to stay well inside memory).
      const cap = Math.min(cfg.maxMediaBytes, 32 * 1024 * 1024);
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > cap) {
          await reader.cancel();
          return { ok: false, record: { key: row.key, reason: "too_large" } };
        }
        chunks.push(value);
      }
      const buf = new Uint8Array(total);
      let i = 0;
      for (const c of chunks) {
        buf.set(c, i);
        i += c.length;
      }
      body = buf.buffer;
      length = total;
    }

    let asset;
    try { asset = await gh.uploadAsset(release.id, row.key, type, length, body); }
    catch (error) {
      // Another writer can fill the release after the inventory read.
      if (error instanceof GitHubError && error.status === 422 && (await gh.listAssets(release.id)).length >= RELEASE_ASSET_LIMIT) {
        this.context.set(this.releaseKey(gh, "Count", release.tag), String(RELEASE_ASSET_LIMIT));
        throw new ReleaseFullError();
      }
      throw error;
    }
    if (!asset) {
      // Already uploaded (e.g. the response to an earlier attempt was lost): reuse it.
      const assets = await gh.listAssets(release.id);
      this.context.set(this.releaseKey(gh, "Count", release.tag), String(assets.length));
      asset = assets.find((a) => a.name === row.key) ?? null;
      if (!asset) throw new Error("asset exists but could not be found");
      if (asset.state !== "uploaded") {
        // A leftover from an interrupted upload: remove it and retry later.
        await gh.deleteAsset(asset.id);
        throw new Error("removed incomplete asset from an interrupted upload");
      }
    } else {
      this.context.set(this.releaseKey(gh, "Count", release.tag), String(release.count + 1));
    }
    return {
      ok: true,
      record: this.assetRecord(release.tag, row.key, asset),
    };
  }

  private assetRecord(tag: string, key: string, asset: Asset): Record<string, unknown> {
    return { key, release: tag, name: asset.name, url: asset.browser_download_url, size: asset.size, content_type: asset.content_type };
  }

  private releaseKey(gh: GitHub, kind: "Id" | "Count", tag: string): string {
    return `release${kind}:${gh.repo}:${tag}`;
  }

  /** Inventory the server before upload. Legacy cache keys do not prove repository ownership. */
  private async release(gh: GitHub, month: string, key: string): Promise<{ id: number; tag: string; count: number; asset?: Asset }> {
    for (let n = 1; ; n++) {
      const tag = n === 1 ? `media-${month}` : `media-${month}.${n}`;
      let rel = await gh.releaseByTag(tag);
      if (!rel) {
        const root = await gh.mediaRoot();
        await gh.ensureTag(tag, root);
        try {
          rel = await gh.createRelease(tag, root, `Archived Discord media for ${month}. Written by rejgau; see media records in the archive branch's raw logs.`);
        } catch (error) {
          if (!(error instanceof GitHubError) || error.status !== 422) throw error;
          rel = await gh.releaseByTag(tag);
          if (!rel) throw error;
        }
      }
      const assets = await gh.listAssets(rel.id);
      this.context.set(this.releaseKey(gh, "Id", tag), String(rel.id));
      this.context.set(this.releaseKey(gh, "Count", tag), String(assets.length));
      const existing = assets.find((asset) => asset.name === key);
      if (existing?.state === "uploaded") return { id: rel.id, tag, count: assets.length, asset: existing };
      if (existing) {
        await gh.deleteAsset(existing.id);
        return { id: rel.id, tag, count: assets.length - 1 };
      }
      if (assets.length < RELEASE_ASSET_LIMIT) return { id: rel.id, tag, count: assets.length };
    }
  }
}
