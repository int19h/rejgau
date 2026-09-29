// GuildArchive: one Durable Object per archived guild.
//
// Receives that guild's Gateway events (in order, at least once) from GatewaySession, decides what
// is archived, buffers raw log lines in SQLite, fetches media into GitHub release assets, performs
// REST catch-up/backfill, and periodically appends the buffered lines to the day files on the
// archive branch.
//
// The bot is append-only: it only ever appends to raw/YYYY/MM/DD.jsonl (plus writing archive.json
// once). Everything else (indexes, views) is derived from raw/ later, so the admin's manual history
// rewrites never have to be reconciled with bot-owned state files.

import { DurableObject } from "cloudflare:workers";
import { isArchived, publishedChannelIds, type ChannelInfo } from "./channels";
import { parseConfig, type Config, type GuildConfig } from "./config";
import { discordGet, DiscordError } from "./discord";
import type { Env, OutboxEvent } from "./env";
import { ConflictError, GitHub, GitHubError } from "./github";
import { emojiRef, guildIconRef, mediaInMessage, type MediaRef } from "./media";
import { dayPath, errorMessage, joinPath, log, maxSnowflake, monthTag, rawLine, snowflakeTime } from "./util";

/** Fields of GUILD_CREATE/GUILD_UPDATE worth keeping. An allowlist, so that new Discord fields
 * (and channel-bearing ones like stage_instances or guild_scheduled_events) never leak by default. */
const GUILD_FIELDS = [
  "id", "name", "icon", "banner", "splash", "description", "features", "owner_id", "vanity_url_code",
  "preferred_locale", "premium_tier", "roles", "emojis", "stickers", "nsfw_level", "system_channel_id",
  "rules_channel_id", "afk_channel_id",
];

/** Events that concern the guild as a whole and are always archived. */
const GUILD_EVENTS = new Set([
  "GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE", "GUILD_ROLE_DELETE", "GUILD_EMOJIS_UPDATE", "GUILD_STICKERS_UPDATE",
]);

const CHANNEL_EVENTS = new Set(["CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE", "THREAD_CREATE", "THREAD_UPDATE", "THREAD_DELETE"]);

const MAX_FLUSH_PATHS = 40;
const MAX_FLUSH_BYTES = 8 * 1024 * 1024;
const REST_PAGES_PER_ALARM = 10;
const MEDIA_PER_ALARM = 3;
const MEDIA_MAX_ATTEMPTS = 4;
const RELEASE_ASSET_LIMIT = 1000;

type ChannelRow = {
  id: string;
  json: string;
  type: number;
  parent_id: string | null;
  flags: number;
  deleted: number;
  selected: number;
  last_message_id: string | null;
  cursor: string | null;
  cursor_kind: string | null;
};

type MediaRow = {
  key: string;
  url: string | null;
  channel_id: string | null;
  message_id: string | null;
  month: string;
  attempts: number;
};

function pick(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}


export class GuildArchive extends DurableObject<Env> {
  private sql: SqlStorage;
  private channels = new Map<string, ChannelInfo>();
  private busy = false;
  private github: GitHub | null = null;
  /** Channel IDs that REST lookup failed for; not retried until the DO restarts. */
  private unresolvable = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS pending (n INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, line TEXT NOT NULL, at INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, json TEXT NOT NULL, type INTEGER NOT NULL, parent_id TEXT, flags INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 0, last_message_id TEXT,
        cursor TEXT, cursor_kind TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS media (
        key TEXT PRIMARY KEY, url TEXT, channel_id TEXT, message_id TEXT, month TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)`);
      for (const r of this.sql.exec<ChannelRow>(`SELECT * FROM channels`)) this.channels.set(r.id, toInfo(r));
    });
  }

  // --- kv helpers ---

  private get(k: string): string | null {
    const row = this.sql.exec<{ v: string }>(`SELECT v FROM kv WHERE k = ?`, k).toArray()[0];
    return row ? row.v : null;
  }
  private set(k: string, v: string | null): void {
    if (v === null) this.sql.exec(`DELETE FROM kv WHERE k = ?`, k);
    else this.sql.exec(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }

  private guildConfig(): { cfg: Config; guild: GuildConfig } | null {
    const guildId = this.get("guildId");
    if (!guildId) return null;
    const cfg = parseConfig(this.env.REJGAU_CONFIG);
    const guild = cfg.guilds.get(guildId);
    return guild ? { cfg, guild } : null;
  }

  private gh(guild: GuildConfig): GitHub {
    if (!this.github || this.github.repo !== guild.repo) {
      if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_PRIVATE_KEY) throw new Error("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set");
      this.github = new GitHub(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY, guild.repo);
    }
    return this.github;
  }

  // --- raw lines ---

  /** Buffers one raw log line, filed under the day of `fileAt` (default: `at`). */
  private emit(guild: GuildConfig, line: { at: number; src: string; sid?: string; s?: number; t: string }, dJson: string, fileAt = line.at): void {
    const path = joinPath(guild.path, `raw/${dayPath(fileAt)}.jsonl`);
    this.sql.exec(`INSERT INTO pending (path, line, at) VALUES (?, ?, ?)`, path, rawLine(line, dJson), Date.now());
    if (!this.get("dirtySince")) this.set("dirtySince", String(Date.now()));
    this.set("lastChangeAt", String(Date.now()));
  }

  private synthetic(guild: GuildConfig, t: string, d: unknown, at = Date.now()): void {
    this.emit(guild, { at, src: "rejgau", t }, JSON.stringify(d));
  }

  // --- channels ---

  private upsertChannel(ch: Record<string, any>): void {
    const existing = this.sql.exec<ChannelRow>(`SELECT * FROM channels WHERE id = ?`, ch.id).toArray()[0];
    const merged = existing ? { ...JSON.parse(existing.json), ...ch } : ch;
    this.sql.exec(
      `INSERT INTO channels (id, json, type, parent_id, flags, deleted) VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, type = excluded.type, parent_id = excluded.parent_id, flags = excluded.flags, deleted = 0`,
      ch.id, JSON.stringify(merged), merged.type ?? 0, merged.parent_id ?? null, merged.flags ?? 0,
    );
    this.channels.set(ch.id, { id: ch.id, type: merged.type ?? 0, parentId: merged.parent_id ?? null, flags: merged.flags ?? 0, deleted: false });
  }

  private markDeleted(id: string): void {
    this.sql.exec(`UPDATE channels SET deleted = 1 WHERE id = ?`, id);
    const info = this.channels.get(id);
    if (info) info.deleted = true;
  }

  private channelRow(id: string): ChannelRow | undefined {
    return this.sql.exec<ChannelRow>(`SELECT * FROM channels WHERE id = ?`, id).toArray()[0];
  }

  /**
   * Re-evaluates which channels are selected, recording each change. Newly selected channels get
   * a REST cursor: "0" (full history) when backfilling, otherwise none.
   */
  private reconcile(guild: GuildConfig, opts: { backfillThreads?: boolean; liveCreated?: string } = {}): void {
    for (const [id, info] of this.channels) {
      if (info.deleted) continue;
      const now = isArchived(id, this.channels, guild) ? 1 : 0;
      const row = this.channelRow(id)!;
      if (now === row.selected) continue;
      if (now) {
        const chain: unknown[] = [];
        for (let cur = info.parentId; cur; cur = this.channels.get(cur)?.parentId ?? null) {
          const r = this.channelRow(cur);
          if (r) chain.push(JSON.parse(r.json));
          if (chain.length > 3) break;
        }
        this.synthetic(guild, "CHANNEL_SELECTED", { channel: JSON.parse(row.json), ancestors: chain });
        const isThread = info.type === 10 || info.type === 11 || info.type === 12;
        const backfill = id !== opts.liveCreated && (guild.backfill || (isThread && opts.backfillThreads));
        this.sql.exec(`UPDATE channels SET selected = 1, cursor = ?, cursor_kind = ? WHERE id = ?`, backfill ? "0" : null, backfill ? "backfill" : null, id);
      } else {
        this.synthetic(guild, "CHANNEL_UNSELECTED", { id });
        this.sql.exec(`UPDATE channels SET selected = 0, cursor = NULL, cursor_kind = NULL WHERE id = ?`, id);
      }
    }
  }

  private isSelected(id: string): boolean {
    return this.channelRow(id)?.selected === 1;
  }

  /** Looks up a channel we haven't seen (e.g. an old thread that got unarchived). */
  private async resolveChannel(id: string): Promise<boolean> {
    if (this.channels.has(id)) return true;
    if (this.unresolvable.has(id)) return false;
    try {
      const ch = await discordGet<Record<string, any>>(this.env.DISCORD_TOKEN, `/channels/${id}`);
      this.upsertChannel(ch);
      return true;
    } catch (e) {
      this.unresolvable.add(id);
      log("channel_unresolvable", { error: errorMessage(e) });
      return false;
    }
  }

  // --- media ---

  private enqueueMedia(refs: MediaRef[], month: string): void {
    for (const r of refs) {
      this.sql.exec(
        `INSERT OR IGNORE INTO media (key, url, channel_id, message_id, month, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        r.key, r.url, r.channelId ?? null, r.messageId ?? null, month,
      );
    }
  }

  // --- ingest ---

  /** Called by GatewaySession with this guild's events, in order. */
  async ingest(guildId: string, events: OutboxEvent[]): Promise<void> {
    if (!this.get("guildId")) this.set("guildId", guildId);
    const conf = this.guildConfig();
    if (!conf) return; // guild removed from config: drop
    const { guild } = conf;
    this.checkConfigChange(guild);
    const lastSid = this.get("lastSid");
    let lastS = Number(this.get("lastS") ?? "-1");
    for (const ev of events) {
      if (ev.sid === lastSid && ev.s <= lastS) continue; // replayed after a resume or pump retry
      await this.handle(guild, ev);
      this.set("lastSid", ev.sid);
      this.set("lastS", String(ev.s));
      lastS = ev.s;
    }
    await this.scheduleAlarm();
  }

  /** Records config changes that affect this guild and reconciles channel selection. */
  private checkConfigChange(guild: GuildConfig): void {
    const sig = JSON.stringify({ repo: guild.repo, branch: guild.branch, path: guild.path, channels: guild.channels, exclude: guild.exclude, backfill: guild.backfill });
    if (sig === this.get("configSig")) return;
    this.set("configSig", sig);
    this.synthetic(guild, "CONFIG", { channels: guild.channels, exclude: guild.exclude, backfill: guild.backfill });
    if (this.get("initialized")) this.reconcile(guild);
  }

  private async handle(guild: GuildConfig, ev: OutboxEvent): Promise<void> {
    const gw = { at: ev.at, src: "gw", sid: ev.sid, s: ev.s, t: ev.t };
    const d = JSON.parse(ev.d);
    switch (ev.t) {
      case "SESSION_START":
      case "SESSION_RESUMED":
        this.emit(guild, { at: ev.at, src: "rejgau", t: ev.t }, ev.d);
        return;

      case "GUILD_CREATE": {
        const initialized = this.get("initialized") === "1";
        const snapshot = pick(d, GUILD_FIELDS);
        this.emit(guild, { at: ev.at, src: "rejgau", sid: ev.sid, s: ev.s, t: "GUILD_SNAPSHOT" }, JSON.stringify(snapshot));
        if (d.icon) this.enqueueMedia([guildIconRef(d.id, d.icon)], monthTag(ev.at));
        const known = new Set(this.channels.keys());
        for (const ch of d.channels ?? []) this.upsertChannel({ ...ch, guild_id: d.id });
        for (const th of d.threads ?? []) this.upsertChannel({ ...th, guild_id: d.id });
        // Threads first seen after a gap may have been created during it: fetch their history.
        this.reconcile(guild, { backfillThreads: initialized });
        if (initialized) {
          // A new session means events may have been missed: catch up every selected channel.
          const ids: string[] = [];
          for (const r of this.sql.exec<ChannelRow>(`SELECT * FROM channels WHERE selected = 1 AND deleted = 0 AND cursor IS NULL AND last_message_id IS NOT NULL`)) {
            this.sql.exec(`UPDATE channels SET cursor = ?, cursor_kind = 'catchup' WHERE id = ?`, r.last_message_id, r.id);
            ids.push(r.id);
          }
          if (ids.length) this.synthetic(guild, "CATCHUP_BEGIN", { channels: ids, new_threads: [...this.channels.keys()].filter((id) => !known.has(id) && this.isSelected(id)) });
        } else {
          // First sight: live messages start from each channel's current last message.
          for (const ch of [...(d.channels ?? []), ...(d.threads ?? [])]) {
            if (ch.last_message_id) this.sql.exec(`UPDATE channels SET last_message_id = ? WHERE id = ? AND last_message_id IS NULL`, ch.last_message_id, ch.id);
          }
        }
        this.set("initialized", "1");
        return;
      }

      case "GUILD_UPDATE":
        this.emit(guild, gw, JSON.stringify(pick(d, GUILD_FIELDS)));
        if (d.icon) this.enqueueMedia([guildIconRef(d.id, d.icon)], monthTag(ev.at));
        return;

      case "GUILD_DELETE":
        if (!d.unavailable) this.emit(guild, gw, ev.d); // bot removed; outages are ignored
        return;

      case "THREAD_LIST_SYNC": {
        for (const th of d.threads ?? []) this.upsertChannel(th);
        this.reconcile(guild);
        const threads = (d.threads ?? []).filter((th: any) => this.isSelected(th.id));
        if (!threads.length) return;
        const ids = new Set(threads.map((th: any) => th.id));
        const published = publishedChannelIds(this.channels, guild);
        const filtered = {
          ...d,
          channel_ids: d.channel_ids?.filter((id: string) => published.has(id)),
          threads,
          members: (d.members ?? []).filter((m: any) => ids.has(m.id)),
        };
        this.emit(guild, gw, JSON.stringify(filtered));
        return;
      }

      case "THREAD_MEMBER_UPDATE":
      case "THREAD_MEMBERS_UPDATE":
        if (this.isSelected(d.id)) this.emit(guild, gw, ev.d);
        return;
    }

    if (CHANNEL_EVENTS.has(ev.t)) {
      const publishedBefore = publishedChannelIds(this.channels, guild).has(d.id);
      if (ev.t.endsWith("_DELETE")) {
        if (publishedBefore) this.emit(guild, gw, ev.d);
        this.markDeleted(d.id);
        this.reconcile(guild);
        return;
      }
      this.upsertChannel(d);
      // Brand-new threads/channels have no history worth fetching. (THREAD_CREATE is also sent when
      // the bot is added to an existing private thread; then `newly_created` is absent.)
      const live = ev.t === "CHANNEL_CREATE" || (ev.t === "THREAD_CREATE" && d.newly_created);
      this.reconcile(guild, { liveCreated: live ? d.id : undefined });
      if (publishedBefore || publishedChannelIds(this.channels, guild).has(d.id)) this.emit(guild, gw, ev.d);
      return;
    }

    if (GUILD_EVENTS.has(ev.t)) {
      this.emit(guild, gw, ev.d);
      return;
    }

    // Everything else is channel-scoped: messages, reactions, polls, pins, …
    const channelId: string | undefined = d.channel_id;
    if (!channelId) return;
    if (!(await this.resolveChannel(channelId))) return;
    if (!this.isSelected(channelId)) {
      this.reconcile(guild); // a freshly resolved thread may be selected
      if (!this.isSelected(channelId)) return;
    }
    this.emit(guild, gw, ev.d);

    const guildId = this.get("guildId")!;
    if (ev.t === "MESSAGE_CREATE" || ev.t === "MESSAGE_UPDATE") {
      this.enqueueMedia(mediaInMessage(d, guildId), monthTag(d.id ? snowflakeTime(d.id) : ev.at));
      if (ev.t === "MESSAGE_CREATE") this.noteMessage(channelId, d.id);
    } else if (ev.t === "MESSAGE_REACTION_ADD" && d.emoji?.id) {
      this.enqueueMedia([emojiRef(d.emoji.id, !!d.emoji.animated)], monthTag(ev.at));
    }
  }

  private noteMessage(channelId: string, messageId: string): void {
    const row = this.channelRow(channelId);
    if (!row) return;
    this.sql.exec(`UPDATE channels SET last_message_id = ? WHERE id = ?`, maxSnowflake(row.last_message_id, messageId), channelId);
  }

  // --- alarm-driven work ---

  private async scheduleAlarm(): Promise<void> {
    const conf = this.guildConfig();
    if (!conf) return;
    const now = Date.now();
    const times: number[] = [];
    const paused = this.get("paused") === "1";
    const retryAt = Number(this.get("retryAt") ?? "0");
    const dirtySince = this.get("dirtySince");
    if (dirtySince && !paused) {
      const lastChange = Number(this.get("lastChangeAt") ?? dirtySince);
      times.push(Math.max(retryAt, Math.min(lastChange + conf.cfg.flushIdleMs, Number(dirtySince) + conf.cfg.flushMaxMs)));
    }
    if (!paused) {
      if (this.sql.exec(`SELECT 1 FROM channels WHERE cursor IS NOT NULL AND selected = 1 LIMIT 1`).toArray().length) times.push(now + 2000);
      const media = this.sql.exec<{ t: number | null }>(`SELECT MIN(next_at) AS t FROM media WHERE status = 'pending'`).one().t;
      if (media !== null) times.push(Math.max(now + 1000, media));
    }
    if (!times.length) return;
    const next = Math.min(...times);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next || current < now - 60_000) await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    const conf = this.guildConfig();
    if (!conf || this.busy || this.get("paused") === "1") return;
    this.busy = true;
    try {
      await this.restWork(conf.guild);
      await this.mediaWork(conf.cfg, conf.guild);
      const dirtySince = this.get("dirtySince");
      if (dirtySince) {
        const now = Date.now();
        const lastChange = Number(this.get("lastChangeAt") ?? dirtySince);
        const due = now - lastChange >= conf.cfg.flushIdleMs || now - Number(dirtySince) >= conf.cfg.flushMaxMs;
        if (due && now >= Number(this.get("retryAt") ?? "0")) await this.flush(conf.guild);
      }
    } finally {
      this.busy = false;
      await this.scheduleAlarm();
    }
  }

  /** Pages through REST history for channels with a cursor (backfill or catch-up). */
  private async restWork(guild: GuildConfig): Promise<void> {
    let pages = 0;
    while (pages < REST_PAGES_PER_ALARM) {
      const row = this.sql.exec<ChannelRow>(`SELECT * FROM channels WHERE cursor IS NOT NULL AND selected = 1 LIMIT 1`).toArray()[0];
      if (!row) return;
      pages++;
      let batch: Record<string, any>[];
      try {
        batch = await discordGet<Record<string, any>[]>(this.env.DISCORD_TOKEN, `/channels/${row.id}/messages?limit=100&after=${row.cursor}`);
      } catch (e) {
        // No access (403/404) or similar: stop for this channel rather than retrying into an IP ban.
        const status = e instanceof DiscordError ? e.status : 0;
        this.synthetic(guild, row.cursor_kind === "catchup" ? "CATCHUP_END" : "BACKFILL_END", { channel_id: row.id, error: status || errorMessage(e) });
        this.sql.exec(`UPDATE channels SET cursor = NULL, cursor_kind = NULL WHERE id = ?`, row.id);
        continue;
      }
      batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const now = Date.now();
      const guildId = this.get("guildId")!;
      for (const m of batch) {
        const created = snowflakeTime(m.id);
        this.emit(guild, { at: now, src: "rest", t: "MESSAGE_CREATE" }, JSON.stringify(m), created);
        this.enqueueMedia(mediaInMessage(m, guildId), monthTag(created));
        this.noteMessage(row.id, m.id);
      }
      if (batch.length < 100) {
        this.synthetic(guild, row.cursor_kind === "catchup" ? "CATCHUP_END" : "BACKFILL_END", {
          channel_id: row.id,
          // Edits, deletes and reactions that happened while disconnected can't be recovered.
          ...(row.cursor_kind === "catchup" ? { note: "only new messages are recovered" } : {}),
        });
        this.sql.exec(`UPDATE channels SET cursor = NULL, cursor_kind = NULL WHERE id = ?`, row.id);
      } else {
        this.sql.exec(`UPDATE channels SET cursor = ? WHERE id = ?`, batch[batch.length - 1].id, row.id);
      }
    }
  }

  /** Downloads pending media and uploads it as release assets. */
  private async mediaWork(cfg: Config, guild: GuildConfig): Promise<void> {
    const rows = this.sql
      .exec<MediaRow>(`SELECT key, url, channel_id, message_id, month, attempts FROM media WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?`, Date.now(), MEDIA_PER_ALARM)
      .toArray();
    for (const row of rows) {
      try {
        const result = await this.storeMedia(cfg, guild, row);
        this.synthetic(guild, result.ok ? "MEDIA_STORED" : "MEDIA_FAILED", result.record);
        this.sql.exec(`UPDATE media SET status = ? WHERE key = ?`, result.ok ? "done" : "failed", row.key);
      } catch (e) {
        const attempts = row.attempts + 1;
        log("media_error", { key: row.key, attempts, error: errorMessage(e) });
        if (attempts >= MEDIA_MAX_ATTEMPTS) {
          this.synthetic(guild, "MEDIA_FAILED", { key: row.key, reason: errorMessage(e).slice(0, 200) });
          this.sql.exec(`UPDATE media SET status = 'failed', attempts = ? WHERE key = ?`, attempts, row.key);
        } else {
          this.sql.exec(`UPDATE media SET attempts = ?, next_at = ? WHERE key = ?`, attempts, Date.now() + 60_000 * 2 ** attempts, row.key);
        }
      }
    }
  }

  private async download(row: MediaRow): Promise<Response | null> {
    if (!row.url) return null;
    const res = await fetch(row.url);
    if (res.ok || !(res.status === 403 || res.status === 404) || !row.message_id || !row.channel_id) return res;
    // Signed attachment URLs expire; get fresh ones from the message.
    await res.body?.cancel();
    const msg = await discordGet<Record<string, any>>(this.env.DISCORD_TOKEN, `/channels/${row.channel_id}/messages/${row.message_id}`).catch(() => null);
    const fresh = msg && mediaInMessage(msg, this.get("guildId")!).find((r) => r.key === row.key);
    if (!fresh?.url) return new Response(null, { status: 404 });
    this.sql.exec(`UPDATE media SET url = ? WHERE key = ?`, fresh.url, row.key);
    return fetch(fresh.url);
  }

  private async storeMedia(cfg: Config, guild: GuildConfig, row: MediaRow): Promise<{ ok: boolean; record: Record<string, unknown> }> {
    const res = await this.download(row);
    if (!res) return { ok: false, record: { key: row.key, reason: "unsupported" } };
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 404 || res.status === 403 || res.status === 410) return { ok: false, record: { key: row.key, reason: `http_${res.status}` } };
      throw new Error(`download HTTP ${res.status}`);
    }
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    const declared = Number(res.headers.get("content-length") ?? "NaN");
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

    const gh = this.gh(guild);
    const release = await this.release(gh, row.month);
    let asset = await gh.uploadAsset(release.id, row.key, type, length, body);
    if (!asset) {
      // Already uploaded (e.g. the response to an earlier attempt was lost): reuse it.
      asset = (await gh.listAssets(release.id)).find((a) => a.name === row.key) ?? null;
      if (!asset) throw new Error("asset exists but could not be found");
      if (asset.state !== "uploaded") {
        // A leftover from an interrupted upload: remove it and retry later.
        await gh.deleteAsset(asset.id);
        throw new Error("removed incomplete asset from an interrupted upload");
      }
    } else {
      this.set(`releaseCount:${release.tag}`, String(release.count + 1));
    }
    return {
      ok: true,
      record: { key: row.key, release: release.tag, name: asset.name, url: asset.browser_download_url, size: asset.size, content_type: asset.content_type },
    };
  }

  /** The release that assets for `month` go into, rolling over to ".2", ".3", … when full. */
  private async release(gh: GitHub, month: string): Promise<{ id: number; tag: string; count: number }> {
    for (let n = 1; ; n++) {
      const tag = n === 1 ? `media-${month}` : `media-${month}.${n}`;
      const cachedId = this.get(`releaseId:${tag}`);
      const cachedCount = this.get(`releaseCount:${tag}`);
      if (cachedId && cachedCount !== null) {
        if (Number(cachedCount) < RELEASE_ASSET_LIMIT) return { id: Number(cachedId), tag, count: Number(cachedCount) };
        continue;
      }
      let rel = await gh.releaseByTag(tag);
      if (!rel) {
        // Tag the media-root commit explicitly first, so the release never points into archive history.
        const root = await gh.mediaRoot();
        await gh.ensureTag(tag, root);
        rel = await gh.createRelease(tag, root, `Archived Discord media for ${month}. Written by rejgau; see media records in the archive branch's raw logs.`);
      }
      const count = (await gh.listAssets(rel.id)).length;
      this.set(`releaseId:${tag}`, String(rel.id));
      this.set(`releaseCount:${tag}`, String(count));
      if (count < RELEASE_ASSET_LIMIT) return { id: rel.id, tag, count };
    }
  }

  /** Appends buffered lines to their day files in one commit. */
  private async flush(guild: GuildConfig): Promise<{ committed: number; sha?: string }> {
    const rows = this.sql.exec<{ n: number; path: string; line: string }>(`SELECT n, path, line FROM pending ORDER BY n`).toArray();
    if (!rows.length) {
      this.set("dirtySince", null);
      return { committed: 0 };
    }
    // Take lines in order until the path or byte budget is used up.
    const byPath = new Map<string, string[]>();
    let bytes = 0;
    let maxN = 0;
    for (const r of rows) {
      if (!byPath.has(r.path) && byPath.size >= MAX_FLUSH_PATHS) continue;
      if (bytes > MAX_FLUSH_BYTES) break;
      if (!byPath.has(r.path)) byPath.set(r.path, []);
      byPath.get(r.path)!.push(r.line);
      bytes += r.line.length;
      maxN = r.n;
    }
    const taken = [...byPath.values()].reduce((n, l) => n + l.length, 0);
    const gh = this.gh(guild);
    try {
      let sha: string | undefined;
      for (let attempt = 0; attempt < 4 && !sha; attempt++) {
        // Always build on the current tip: the admin may have rewritten history since last time.
        const head = await gh.branchHead(guild.branch);
        const files = [];
        for (const [path, lines] of byPath) {
          let existing = head ? await gh.readFile(path, head) : null;
          if (existing && !existing.endsWith("\n")) existing += "\n";
          files.push({ path, content: (existing ?? "") + lines.join("\n") + "\n" });
        }
        const archiveJson = joinPath(guild.path, "archive.json");
        if (!head || !(await gh.readFile(archiveJson, head))) {
          files.push({ path: archiveJson, content: JSON.stringify({ format: 1, guild_id: this.get("guildId"), generator: "rejgau" }, null, 2) + "\n" });
        }
        try {
          sha = await gh.commit(guild.branch, head, files, `Archive ${taken} event${taken === 1 ? "" : "s"}`);
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          log("flush_conflict", { attempt });
        }
      }
      if (!sha) throw new Error("branch kept moving; will retry");
      const paths = [...byPath.keys()];
      this.sql.exec(`DELETE FROM pending WHERE n <= ? AND path IN (${paths.map(() => "?").join(",")})`, maxN, ...paths);
      const remaining = this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM pending`).one().c;
      this.set("dirtySince", remaining ? String(Date.now() - 3_600_000) : null); // leftovers: flush again soon
      this.set("retryAt", null);
      this.set("failures", null);
      this.set("lastCommit", JSON.stringify({ sha, at: new Date().toISOString(), lines: taken }));
      this.set("lastError", null);
      log("flush_ok", { sha, lines: taken, files: paths.length });
      return { committed: taken, sha };
    } catch (e) {
      const failures = Number(this.get("failures") ?? "0") + 1;
      this.set("failures", String(failures));
      this.set("retryAt", String(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (failures - 1))));
      this.set("lastError", JSON.stringify({ at: new Date().toISOString(), error: errorMessage(e).slice(0, 500), status: e instanceof GitHubError ? e.status : undefined }));
      log("flush_error", { failures, error: errorMessage(e) });
      throw e;
    }
  }

  // --- admin RPC ---

  async status(): Promise<GuildStatus> {
    const count = (q: string) => this.sql.exec<{ c: number }>(q).one().c;
    return {
      paused: this.get("paused") === "1",
      pendingLines: count(`SELECT COUNT(*) AS c FROM pending`),
      selectedChannels: count(`SELECT COUNT(*) AS c FROM channels WHERE selected = 1 AND deleted = 0`),
      restCursors: count(`SELECT COUNT(*) AS c FROM channels WHERE cursor IS NOT NULL AND selected = 1`),
      mediaPending: count(`SELECT COUNT(*) AS c FROM media WHERE status = 'pending'`),
      mediaDone: count(`SELECT COUNT(*) AS c FROM media WHERE status = 'done'`),
      mediaFailed: count(`SELECT COUNT(*) AS c FROM media WHERE status = 'failed'`),
      lastCommit: JSON.parse(this.get("lastCommit") ?? "null"),
      lastError: JSON.parse(this.get("lastError") ?? "null"),
      retryAt: this.get("retryAt") ? new Date(Number(this.get("retryAt"))).toISOString() : null,
    };
  }

  /** Commits everything buffered now (ignoring the flush schedule). */
  async flushNow(): Promise<{ committed?: number; error?: string }> {
    const conf = this.guildConfig();
    if (!conf) return { error: "guild not configured" };
    if (this.busy) return { error: "busy; try again" };
    this.busy = true;
    try {
      this.set("retryAt", null);
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const r = await this.flush(conf.guild);
        total += r.committed;
        if (!r.committed || !this.sql.exec(`SELECT 1 FROM pending LIMIT 1`).toArray().length) break;
      }
      return { committed: total };
    } catch (e) {
      return { error: errorMessage(e) };
    } finally {
      this.busy = false;
      await this.scheduleAlarm();
    }
  }

  /** Stops committing (events keep being buffered), e.g. while the admin rewrites history. */
  async setPaused(paused: boolean): Promise<void> {
    this.set("paused", paused ? "1" : null);
    if (!paused) await this.scheduleAlarm();
  }
}

export interface GuildStatus {
  paused: boolean;
  pendingLines: number;
  selectedChannels: number;
  restCursors: number;
  mediaPending: number;
  mediaDone: number;
  mediaFailed: number;
  lastCommit: { sha: string; at: string; lines: number } | null;
  lastError: { at: string; error: string; status?: number } | null;
  retryAt: string | null;
}

function toInfo(r: ChannelRow): ChannelInfo {
  return { id: r.id, type: r.type, parentId: r.parent_id, flags: r.flags, deleted: r.deleted === 1 };
}
