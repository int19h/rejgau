// GuildArchive: one Durable Object per archived guild.
//
// Receives that guild's Gateway events (in order, at least once) from GatewaySession, decides what
// is archived, buffers raw log lines in SQLite, fetches media into GitHub release assets, performs
// REST catch-up/backfill, and periodically appends the buffered lines to the day files on the
// archive branch.
//
// The bot is append-only: it only ever appends to raw/YYYY/MM/DD/<channel id or "guild">.jsonl
// (plus writing archive.json once). Everything else (indexes, views) is derived from raw/ later, so the admin's manual history
// rewrites never have to be reconciled with bot-owned state files.

import { DurableObject } from "cloudflare:workers";
import { canView, isAdministrator, isArchived, isThread, lineScope, publishedChannelIds, type ChannelInfo, type PermissionContext } from "./channels";
import { parseConfig, type Config, type GuildConfig } from "./config";
import { discordGet, DiscordError } from "./discord";
import type { Env, OutboxEvent } from "./env";
import { ConflictError, GitHub, GitHubAuthError, GitHubError } from "./github";
import { emojiRef, guildIconRef, mediaInMessage, type MediaRef } from "./media";
import { MEMBER_FIELDS, publicSessionId, sanitize } from "./sanitize";
import { dayPath, errorMessage, joinPath, log, maxSnowflake, monthTag, rawLine, snowflakeTime } from "./util";

/** Fields of GUILD_CREATE/GUILD_UPDATE worth keeping. An allowlist, so that new Discord fields
 * (and channel-bearing ones like stage_instances or guild_scheduled_events) never leak by default. */
const GUILD_FIELDS = [
  "id", "name", "icon", "banner", "splash", "description", "features", "owner_id", "vanity_url_code",
  "preferred_locale", "premium_tier", "roles", "emojis", "stickers", "nsfw_level",
];

/** Events that concern the guild as a whole and are always archived. */
const GUILD_EVENTS = new Set([
  "GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE", "GUILD_ROLE_DELETE", "GUILD_EMOJIS_UPDATE", "GUILD_STICKERS_UPDATE",
]);

const CHANNEL_EVENTS = new Set(["CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE", "THREAD_CREATE", "THREAD_UPDATE", "THREAD_DELETE"]);

/**
 * How often role permissions and the bot's own roles are re-read over REST: a safety net, since
 * GUILD_CREATE, role events and the bot's own GUILD_MEMBER_UPDATE normally keep them current.
 */
const PERMISSION_REFRESH_MS = 60 * 60_000;
/** After a failed refresh (with permissions already known), wait this long before trying again. */
const PERMISSION_RETRY_MS = 5 * 60_000;
/** After permissions were refused for good (and aren't known), drop batches this long before retrying. */
const PERMISSION_FAILED_WAIT_MS = 10 * 60_000;

const MAX_FLUSH_PATHS = 40;
const MAX_FLUSH_BYTES = 8 * 1024 * 1024;
const REST_PAGES_PER_ALARM = 10;
const MEDIA_MAX_ATTEMPTS = 4;
const RELEASE_ASSET_LIMIT = 1000;
const DISPATCH_INTERVAL_MS = 10 * 60_000;
/** Channel types with no message history endpoint of their own (category, forum, media). */
const NO_HISTORY_TYPES = new Set([4, 15, 16]);

/** What GuildArchive.ingest reports back to the pump. */
export interface IngestResult {
  /** Number of leading events that were handled (archived, skipped or dropped). */
  handled: number;
  /** Set when the next event failed. */
  failed?: { retryable: boolean; error: string };
}

/** Whether retrying could help: Discord/GitHub 5xx or 429, or a network-level failure. */
function isTransient(e: unknown): boolean {
  if (e instanceof DiscordError || e instanceof GitHubError) return e.status >= 500 || e.status === 429 || (e instanceof GitHubError && e.retryAfterMs !== null);
  return true; // network errors and anything unexpected: retry (the pump caps it)
}

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
  rest_next_at: number;
  rest_failures: number;
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
  /** Channel IDs Discord says we can't see (403/404); not retried until the DO restarts. */
  private unresolvable = new Set<string>();
  /** Serializes ingest calls: a restarted GatewaySession may resend a batch while one is in flight. */
  private ingestChain: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS pending (n INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, line TEXT NOT NULL, at INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, json TEXT NOT NULL, type INTEGER NOT NULL, parent_id TEXT, flags INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 0, last_message_id TEXT,
        cursor TEXT, cursor_kind TEXT, rest_next_at INTEGER NOT NULL DEFAULT 0, rest_failures INTEGER NOT NULL DEFAULT 0)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS media (
        key TEXT PRIMARY KEY, url TEXT, channel_id TEXT, message_id TEXT, month TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)`);
      // Authors of backfilled messages whose server membership still needs a MEMBER_SNAPSHOT.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0)`);
      for (const r of this.sql.exec<ChannelRow>(`SELECT * FROM channels`)) this.channels.set(r.id, toInfo(r));
      this.applyVisibility();
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

  /** Records which guild this object archives (its ID isn't derivable from the object ID). */
  private adopt(guildId: string): void {
    if (!this.get("guildId")) this.set("guildId", guildId);
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

  /**
   * Buffers one raw log line, filed under the day of `fileAt` (default: `at`), in the file of the
   * channel or thread it concerns, or guild.jsonl for server-wide records.
   */
  private emit(guild: GuildConfig, line: { at: number; src: string; sid?: string; s?: number; t: string }, dJson: string, fileAt = line.at): void {
    const parsed = JSON.parse(dJson);
    const path = joinPath(guild.path, `raw/${dayPath(fileAt)}/${lineScope(line.t, parsed)}.jsonl`);
    // Every line passes through the privacy filter (see sanitize.ts), and session IDs are replaced
    // by an opaque stand-in.
    const publicLine = { ...line, sid: line.sid === undefined ? undefined : publicSessionId(line.sid) };
    const d = JSON.stringify(sanitize(parsed));
    this.sql.exec(`INSERT INTO pending (path, line, at) VALUES (?, ?, ?)`, path, rawLine(publicLine, d), Date.now());
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
    const info: ChannelInfo = { id: ch.id, type: merged.type ?? 0, parentId: merged.parent_id ?? null, flags: merged.flags ?? 0, deleted: false };
    info.hidden = this.isHidden(info, merged, this.permissions());
    this.channels.set(ch.id, info);
  }

  // --- what the bot can view ---

  /** The bot's permission context, or null while it isn't known (then every channel counts as hidden). */
  private permissions(): PermissionContext | null {
    const guildId = this.get("guildId");
    const userId = this.get("botUserId");
    const roles = this.get("permRoles");
    const memberRoles = this.get("botRoles");
    if (!guildId || !userId || !roles || !memberRoles) return null;
    return { guildId, userId, roles: JSON.parse(roles), memberRoles: JSON.parse(memberRoles) };
  }

  /** Threads follow their parent (see isArchived), so only channels are evaluated. Fails closed. */
  private isHidden(info: ChannelInfo, json: Record<string, any>, p: PermissionContext | null): boolean {
    if (isThread(info)) return false;
    return !p || !canView(json.permission_overwrites, p);
  }

  private applyVisibility(): void {
    const p = this.permissions();
    for (const r of this.sql.exec<ChannelRow>(`SELECT * FROM channels`)) {
      const info = this.channels.get(r.id);
      if (info) info.hidden = this.isHidden(info, JSON.parse(r.json), p);
    }
  }

  /**
   * Records role permissions and/or the bot's roles (either may be omitted). Returns whether
   * anything changed, in which case visibility has been re-evaluated (the caller reconciles).
   */
  private setPermissions(roles: { id?: string; permissions?: string }[] | undefined, memberRoles: string[] | undefined): boolean {
    const before = `${this.get("permRoles")}|${this.get("botRoles")}`;
    if (Array.isArray(roles)) {
      const map = Object.fromEntries(roles.filter((r) => r?.id).map((r) => [r.id!, String(r.permissions ?? "0")]));
      this.set("permRoles", JSON.stringify(map));
    }
    if (Array.isArray(memberRoles)) this.set("botRoles", JSON.stringify(memberRoles));
    if (Array.isArray(roles) && Array.isArray(memberRoles)) {
      this.set("permAt", String(Date.now()));
      this.set("permissionsError", null);
      this.set("permFailedAt", null);
    }
    const changed = before !== `${this.get("permRoles")}|${this.get("botRoles")}`;
    if (changed) this.applyVisibility();
    return changed;
  }

  /**
   * Makes sure the bot's permissions are known and at most PERMISSION_REFRESH_MS old, reading them
   * over REST. Returns whether they changed. Failures throw (transient ones are retried).
   */
  private async refreshPermissions(guildId: string, force = false): Promise<boolean> {
    const age = Date.now() - Number(this.get("permAt") ?? "0");
    if (!force && this.permissions() && age < PERMISSION_REFRESH_MS) return false;
    const token = this.env.DISCORD_TOKEN;
    let userId = this.get("botUserId");
    if (!userId) {
      userId = (await discordGet<{ id: string }>(token, "/users/@me")).id;
      this.set("botUserId", userId);
    }
    const roles = await discordGet<{ id: string; permissions: string }[]>(token, `/guilds/${guildId}/roles`);
    const me = await discordGet<{ roles?: string[] }>(token, `/guilds/${guildId}/members/${userId}`);
    return this.setPermissions(roles, me.roles ?? []);
  }

  /**
   * refreshPermissions, but while permissions are known a failure keeps them (it's logged and the
   * refresh retried later) instead of holding up or failing events. Without them it throws.
   */
  private async ensurePermissions(guildId: string, force = false): Promise<boolean> {
    if (!force && this.permissions() && Date.now() < Number(this.get("permRetryAt") ?? "0")) return false;
    try {
      return await this.refreshPermissions(guildId, force);
    } catch (e) {
      if (!this.permissions()) throw e;
      log("permission_refresh_failed", { error: errorMessage(e) });
      this.set("permRetryAt", String(Date.now() + PERMISSION_RETRY_MS));
      return false;
    }
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
   * a REST cursor: "0" (full history) when backfilling, otherwise none. Changes caused by an event
   * carry its time (`at`), so they file and sort with it.
   */
  private reconcile(guild: GuildConfig, opts: { at?: number; backfillThreads?: boolean; liveCreated?: string } = {}): void {
    // Until the bot's permissions are known every channel counts as hidden; don't let that unselect anything.
    if (!this.permissions()) return;
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
        this.synthetic(guild, "CHANNEL_SELECTED", { channel: JSON.parse(row.json), ancestors: chain }, opts.at);
        const isThread = info.type === 10 || info.type === 11 || info.type === 12;
        const backfill = id !== opts.liveCreated && !NO_HISTORY_TYPES.has(info.type) && (guild.backfill || (isThread && opts.backfillThreads));
        this.sql.exec(`UPDATE channels SET selected = 1, cursor = ?, cursor_kind = ? WHERE id = ?`, backfill ? "0" : null, backfill ? "backfill" : null, id);
      } else {
        this.synthetic(guild, "CHANNEL_UNSELECTED", { id }, opts.at);
        this.sql.exec(`UPDATE channels SET selected = 0, cursor = NULL, cursor_kind = NULL WHERE id = ?`, id);
      }
    }
  }

  private isSelected(id: string): boolean {
    return this.channelRow(id)?.selected === 1;
  }

  /**
   * Makes sure a channel and its whole parent chain are known, fetching what's missing (e.g. an old
   * thread that got unarchived). Returns true if anything new was learned. Only "no access" is
   * final; other failures throw, so the event is retried rather than dropped.
   */
  private async resolveChannel(id: string): Promise<boolean> {
    let learned = false;
    for (let cur: string | null = id, depth = 0; cur && depth < 4; depth++) {
      const known = this.channels.get(cur);
      if (known) {
        cur = known.parentId;
        continue;
      }
      const want: string = cur;
      if (this.unresolvable.has(want)) return learned;
      let ch: Record<string, any>;
      try {
        ch = await discordGet<Record<string, any>>(this.env.DISCORD_TOKEN, `/channels/${want}`);
      } catch (e) {
        if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) {
          this.unresolvable.add(want);
          return learned;
        }
        throw e;
      }
      this.upsertChannel(ch);
      learned = true;
      cur = ch.parent_id ?? null;
    }
    return learned;
  }

  /**
   * Loads the guild and its channel tree over REST. Used when events arrive before any
   * GUILD_CREATE, e.g. for a guild newly added to the config while the session merely resumed.
   */
  private async bootstrap(guild: GuildConfig, guildId: string): Promise<void> {
    const token = this.env.DISCORD_TOKEN;
    const g = await discordGet<Record<string, any>>(token, `/guilds/${guildId}`);
    const channels = await discordGet<Record<string, any>[]>(token, `/guilds/${guildId}/channels`);
    const active = await discordGet<{ threads: Record<string, any>[] }>(token, `/guilds/${guildId}/threads/active`);
    this.applyGuildCreate(guild, { ...g, channels, threads: active.threads ?? [] }, { at: Date.now(), src: "rest" });
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

  /**
   * Called by GatewaySession with this guild's events, in order. Never throws for a bad event:
   * reports how many were handled and, if one failed, whether retrying could help. (Error classes
   * don't survive RPC, so the result is the reliable channel.)
   */
  ingest(guildId: string, events: OutboxEvent[]): Promise<IngestResult> {
    const run = this.ingestChain.then(() => this.ingestSerial(guildId, events));
    this.ingestChain = run.then(() => {}, () => {});
    return run;
  }

  private async ingestSerial(guildId: string, events: OutboxEvent[]): Promise<IngestResult> {
    this.adopt(guildId);
    const conf = this.guildConfig();
    if (!conf) return { handled: events.length }; // guild removed from config: drop
    const { guild } = conf;
    // Permissions first, so a config change below is evaluated against them.
    if (!this.permissions() && Date.now() - Number(this.get("permFailedAt") ?? "0") < PERMISSION_FAILED_WAIT_MS) {
      return { handled: events.length }; // refused for good recently (see below): fail closed
    }
    try {
      if ((await this.ensurePermissions(guildId)) && this.get("initialized")) this.reconcile(guild);
    } catch (e) {
      log("permissions_unknown", { error: errorMessage(e) });
      if (isTransient(e)) {
        // Not any event's fault: have the whole batch retried.
        return { handled: 0, failed: { retryable: true, error: `permissions unknown: ${errorMessage(e).slice(0, 400)}` } };
      }
      // Refused for good (e.g. the bot isn't in this guild): like a refused bootstrap, drop the batch
      // rather than hold up the pump (and every other guild), report it, and try again later.
      this.set("permissionsError", errorMessage(e).slice(0, 300));
      this.set("permFailedAt", String(Date.now()));
      return { handled: events.length };
    }
    this.checkConfigChange(guild);
    let handled = 0;
    try {
      for (const ev of events) {
        const marker = ev.t.startsWith("SESSION_");
        // Replayed after a resume or pump retry (read fresh each time: calls may have overlapped).
        if (!marker && ev.sid === this.get("lastSid") && ev.s <= Number(this.get("lastS") ?? "-1")) {
          handled++;
          continue;
        }
        if (!this.get("initialized") && ev.t !== "GUILD_CREATE" && !marker && !(await this.tryBootstrap(guild, guildId))) {
          handled++; // can't know the channel tree: fail closed and drop the event
          continue;
        }
        await this.handle(guild, ev);
        if (!marker) {
          this.set("lastSid", ev.sid);
          this.set("lastS", String(ev.s));
        }
        handled++;
      }
    } catch (e) {
      log("ingest_error", { handled, error: errorMessage(e) });
      return { handled, failed: { retryable: isTransient(e), error: errorMessage(e).slice(0, 500) } };
    } finally {
      await this.scheduleAlarm();
    }
    return { handled };
  }

  /**
   * Bootstraps unless it recently failed for good (e.g. the bot is no longer in the guild), which
   * is recorded in /status. Returns whether the channel tree is now known. Transient errors throw.
   */
  private async tryBootstrap(guild: GuildConfig, guildId: string): Promise<boolean> {
    const failedAt = Number(this.get("bootstrapFailedAt") ?? "0");
    if (Date.now() - failedAt < 10 * 60_000) return false;
    try {
      await this.bootstrap(guild, guildId);
      this.set("bootstrapError", null);
      this.set("bootstrapFailedAt", null);
      return true;
    } catch (e) {
      if (isTransient(e)) throw e;
      this.set("bootstrapError", errorMessage(e).slice(0, 300));
      this.set("bootstrapFailedAt", String(Date.now()));
      return false;
    }
  }

  /** Records config changes that affect this guild and reconciles channel selection. */
  private checkConfigChange(guild: GuildConfig): void {
    const sig = JSON.stringify({ repo: guild.repo, branch: guild.branch, path: guild.path, channels: guild.channels, exclude: guild.exclude, backfill: guild.backfill, privateThreads: guild.privateThreads });
    if (sig === this.get("configSig")) return;
    this.set("configSig", sig);
    // Excluded channel IDs are left out: they'd only reveal channels that aren't archived.
    this.synthetic(guild, "CONFIG", { channels: guild.channels, excluded: guild.exclude.length, backfill: guild.backfill, private_threads: guild.privateThreads });
    if (this.get("initialized")) this.reconcile(guild);
  }

  private async handle(guild: GuildConfig, ev: OutboxEvent): Promise<void> {
    const gw = { at: ev.at, src: "gw", sid: ev.sid, s: ev.s, t: ev.t };
    const d = JSON.parse(ev.d);
    switch (ev.t) {
      case "SESSION_START":
      case "SESSION_RESUMED":
        this.emit(guild, { at: ev.at, src: "rejgau", t: ev.t }, JSON.stringify({ session_id: publicSessionId(ev.sid) }));
        return;

      case "GUILD_CREATE":
        if (d.unavailable) return; // an outage placeholder, not a snapshot
        this.applyGuildCreate(guild, d, { at: ev.at, src: "rejgau", sid: ev.sid, s: ev.s });
        return;

      case "GUILD_UPDATE":
        this.emit(guild, gw, JSON.stringify(pick(d, GUILD_FIELDS)));
        if (d.icon) this.enqueueMedia([guildIconRef(d.id, d.icon)], monthTag(ev.at));
        return;

      case "GUILD_DELETE":
        if (!d.unavailable) this.emit(guild, gw, ev.d); // bot removed; outages are ignored
        return;

      case "THREAD_LIST_SYNC": {
        for (const th of d.threads ?? []) this.upsertChannel(th);
        this.reconcile(guild, { at: ev.at });
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
        this.reconcile(guild, { at: ev.at });
        return;
      }
      this.upsertChannel(d);
      // Brand-new threads/channels have no history worth fetching. (THREAD_CREATE is also sent when
      // the bot is added to an existing private thread; then `newly_created` is absent.)
      const live = ev.t === "CHANNEL_CREATE" || (ev.t === "THREAD_CREATE" && d.newly_created);
      this.reconcile(guild, { at: ev.at, liveCreated: live ? d.id : undefined });
      // An update that hides the channel from the bot isn't logged: it may carry a new name or topic.
      const hiddenNow = !!this.channels.get(d.id)?.hidden;
      if (publishedChannelIds(this.channels, guild).has(d.id) || (publishedBefore && !hiddenNow)) this.emit(guild, gw, ev.d);
      return;
    }

    if (GUILD_EVENTS.has(ev.t)) {
      this.emit(guild, gw, ev.d);
      if (ev.t.startsWith("GUILD_ROLE_") && this.updateRole(ev.t, d)) this.reconcile(guild, { at: ev.at });
      return;
    }

    if (ev.t === "GUILD_MEMBER_UPDATE") {
      // Only the bot's own membership matters (its roles decide what it can view); not archived.
      if (d.user?.id && d.user.id === this.get("botUserId") && this.setPermissions(undefined, d.roles)) this.reconcile(guild, { at: ev.at });
      return;
    }

    // Everything else is channel-scoped: messages, reactions, polls, pins, …
    const channelId: string | undefined = d.channel_id;
    if (!channelId) return;
    if (this.channels.get(channelId)?.hidden && Date.now() - Number(this.get("permForcedAt") ?? "0") > 60_000) {
      // Discord only sends events from channels the bot can view: the stored permissions are stale.
      this.set("permForcedAt", String(Date.now()));
      if (await this.ensurePermissions(this.get("guildId")!, true)) this.reconcile(guild, { at: ev.at });
    }
    if (await this.resolveChannel(channelId)) this.reconcile(guild, { at: ev.at }); // newly learned channels may be selected
    if (!this.isSelected(channelId)) return;
    this.emit(guild, gw, ev.d);

    const guildId = this.get("guildId")!;
    if (ev.t === "MESSAGE_CREATE" || ev.t === "MESSAGE_UPDATE") {
      this.enqueueMedia(mediaInMessage(d, guildId), monthTag(d.id ? snowflakeTime(d.id) : ev.at));
      if (ev.t === "MESSAGE_CREATE") this.noteMessage(channelId, d.id);
    } else if (ev.t === "MESSAGE_REACTION_ADD" && d.emoji?.id) {
      this.enqueueMedia([emojiRef(d.emoji.id, !!d.emoji.animated)], monthTag(ev.at));
    }
  }

  /** Applies a role event to the stored role permissions. Returns whether they changed. */
  private updateRole(t: string, d: any): boolean {
    const roles: Record<string, string> = JSON.parse(this.get("permRoles") ?? "{}");
    if (t === "GUILD_ROLE_DELETE") delete roles[d.role_id];
    else if (d.role?.id) roles[d.role.id] = String(d.role.permissions ?? "0");
    return this.setPermissions(Object.entries(roles).map(([id, permissions]) => ({ id, permissions })), undefined);
  }

  /** Records a guild snapshot and syncs the channel tree from a GUILD_CREATE-shaped object. */
  private applyGuildCreate(guild: GuildConfig, d: Record<string, any>, line: { at: number; src: string; sid?: string; s?: number }): void {
    const initialized = this.get("initialized") === "1";
    this.emit(guild, { ...line, t: "GUILD_SNAPSHOT" }, JSON.stringify(pick(d, GUILD_FIELDS)));
    if (d.icon) this.enqueueMedia([guildIconRef(d.id, d.icon)], monthTag(line.at));
    const botId = this.get("botUserId");
    const me = (d.members ?? []).find((m: any) => botId && m?.user?.id === botId);
    this.setPermissions(d.roles, me?.roles);
    const known = new Set(this.channels.keys());
    for (const ch of d.channels ?? []) this.upsertChannel({ ...ch, guild_id: d.id });
    for (const th of d.threads ?? []) this.upsertChannel({ ...th, guild_id: d.id });
    if (!initialized) {
      // First sight: live messages start from each channel's current last message.
      for (const ch of [...(d.channels ?? []), ...(d.threads ?? [])]) {
        if (ch.last_message_id) this.sql.exec(`UPDATE channels SET last_message_id = ? WHERE id = ? AND last_message_id IS NULL`, ch.last_message_id, ch.id);
      }
    }
    // Threads first seen after a gap may have been created during it: fetch their history.
    this.reconcile(guild, { at: line.at, backfillThreads: initialized });
    if (initialized) {
      // A new session means events may have been missed: catch up every selected channel. A
      // channel with no known message starts from its own ID (messages always sort after it).
      const ids: string[] = [];
      for (const r of this.sql.exec<ChannelRow>(`SELECT * FROM channels WHERE selected = 1 AND deleted = 0 AND cursor IS NULL`)) {
        if (NO_HISTORY_TYPES.has(r.type)) continue;
        this.sql.exec(`UPDATE channels SET cursor = ?, cursor_kind = 'catchup' WHERE id = ?`, r.last_message_id ?? r.id, r.id);
        ids.push(r.id);
      }
      const newThreads = [...this.channels.keys()].filter((id) => !known.has(id) && this.isSelected(id));
      if (ids.length || newThreads.length) this.synthetic(guild, "CATCHUP_BEGIN", { channels: ids, new_threads: newThreads });
    }
    this.set("initialized", "1");
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
      if (this.sql.exec(`SELECT 1 FROM channels WHERE cursor IS NOT NULL AND selected = 1 LIMIT 1`).toArray().length) {
        const restAt = this.sql.exec<{ t: number }>(`SELECT MIN(rest_next_at) AS t FROM channels WHERE cursor IS NOT NULL AND selected = 1`).one().t;
        times.push(Math.max(now + 2000, restAt));
      }
      if (this.get("dispatchPending") === "1") times.push(Math.max(now + 1000, Number(this.get("lastDispatchAt") ?? "0") + DISPATCH_INTERVAL_MS));
      if (this.sql.exec(`SELECT 1 FROM members WHERE done = 0 LIMIT 1`).toArray().length) {
        times.push(Math.max(now + 2000, Number(this.get("memberRetryAt") ?? "0")));
      }
      const media = this.sql.exec<{ t: number | null }>(`SELECT MIN(next_at) AS t FROM media WHERE status = 'pending'`).one().t;
      if (media !== null) {
        const paced = Number(this.get("lastUploadAt") ?? "0") + conf.cfg.mediaSpacingMs;
        times.push(Math.max(now + 1000, media, paced, Number(this.get("githubBackoffUntil") ?? "0")));
      }
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
      await this.memberWork(conf.guild);
      await this.mediaWork(conf.cfg, conf.guild);
      const dirtySince = this.get("dirtySince");
      if (dirtySince) {
        const now = Date.now();
        const lastChange = Number(this.get("lastChangeAt") ?? dirtySince);
        const due = now - lastChange >= conf.cfg.flushIdleMs || now - Number(dirtySince) >= conf.cfg.flushMaxMs;
        if (due && now >= Number(this.get("retryAt") ?? "0")) await this.flush(conf.guild);
      }
      await this.dispatchWork(conf.guild);
    } catch (e) {
      // Recorded by the step that failed; swallow so the runtime doesn't retry on top of our own schedule.
      log("alarm_error", { error: errorMessage(e) });
    } finally {
      this.busy = false;
      await this.scheduleAlarm();
    }
  }

  /** Pages through REST history for channels with a cursor (backfill or catch-up). */
  private async restWork(guild: GuildConfig): Promise<void> {
    let pages = 0;
    while (pages < REST_PAGES_PER_ALARM) {
      const row = this.sql
        .exec<ChannelRow>(`SELECT * FROM channels WHERE cursor IS NOT NULL AND selected = 1 AND rest_next_at <= ? ORDER BY rest_next_at LIMIT 1`, Date.now())
        .toArray()[0];
      if (!row) return;
      pages++;
      let batch: Record<string, any>[];
      try {
        batch = await discordGet<Record<string, any>[]>(this.env.DISCORD_TOKEN, `/channels/${row.id}/messages?limit=100&after=${row.cursor}`);
      } catch (e) {
        if (!isTransient(e)) {
          // No access, wrong channel type, …: final for this channel. Retrying would only add to
          // Discord's invalid-request count.
          const status = e instanceof DiscordError ? e.status : undefined;
          this.synthetic(guild, row.cursor_kind === "catchup" ? "CATCHUP_END" : "BACKFILL_END", { channel_id: row.id, error: status ?? errorMessage(e).slice(0, 200) });
          this.sql.exec(`UPDATE channels SET cursor = NULL, cursor_kind = NULL, rest_failures = 0 WHERE id = ?`, row.id);
          continue;
        }
        // Transient (5xx, 429, network): back off this channel only; others proceed.
        const failures = row.rest_failures + 1;
        this.sql.exec(`UPDATE channels SET rest_failures = ?, rest_next_at = ? WHERE id = ?`, failures, Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** (failures - 1)), row.id);
        log("rest_error", { failures, error: errorMessage(e) });
        continue;
      }
      if (row.rest_failures) this.sql.exec(`UPDATE channels SET rest_failures = 0 WHERE id = ?`, row.id);
      // The channel may have been unselected while we waited.
      if (!this.isSelected(row.id) || this.channelRow(row.id)?.cursor !== row.cursor) continue;
      batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const now = Date.now();
      const guildId = this.get("guildId")!;
      for (const m of batch) {
        const created = snowflakeTime(m.id);
        this.emit(guild, { at: now, src: "rest", t: "MESSAGE_CREATE" }, JSON.stringify(m), created);
        this.enqueueMedia(mediaInMessage(m, guildId), monthTag(created));
        this.noteMessage(row.id, m.id);
        // REST messages carry no `member` (nickname, roles): snapshot each author's membership once.
        if (m.author?.id && !m.webhook_id) this.sql.exec(`INSERT OR IGNORE INTO members (user_id) VALUES (?)`, m.author.id);
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

  /** Tells the archive repo's Pages workflow about new commits, at most once per 10 minutes. */
  private async dispatchWork(guild: GuildConfig): Promise<void> {
    if (this.get("dispatchPending") !== "1") return;
    if (!guild.pages) {
      this.set("dispatchPending", null);
      return;
    }
    const now = Date.now();
    if (now < Number(this.get("lastDispatchAt") ?? "0") + DISPATCH_INTERVAL_MS) return;
    this.set("lastDispatchAt", String(now)); // also paces retries after a failure
    try {
      await this.gh(guild).dispatch("archive-updated");
      this.set("dispatchPending", null);
    } catch (e) {
      log("dispatch_error", { error: errorMessage(e) });
    }
  }

  /**
   * Logs the current server membership of backfilled authors as MEMBER_SNAPSHOT records (the
   * values at backfill time; Discord keeps no history). `member` is null for people who left.
   */
  private async memberWork(guild: GuildConfig): Promise<void> {
    const guildId = this.get("guildId")!;
    if (Date.now() < Number(this.get("memberRetryAt") ?? "0")) return;
    const rows = this.sql.exec<{ user_id: string }>(`SELECT user_id FROM members WHERE done = 0 LIMIT 20`).toArray();
    for (const { user_id } of rows) {
      let member: Record<string, unknown> | null;
      try {
        member = pick(await discordGet<Record<string, any>>(this.env.DISCORD_TOKEN, `/guilds/${guildId}/members/${user_id}`), MEMBER_FIELDS);
      } catch (e) {
        if (isTransient(e)) {
          this.set("memberRetryAt", String(Date.now() + 60_000)); // try again later
          return;
        }
        if (!(e instanceof DiscordError && e.status === 404 && /"code":\s*10007/.test(e.body))) {
          // Some other refusal (e.g. no access): we learned nothing, so record nothing.
          log("member_snapshot_skipped", { error: errorMessage(e) });
          this.sql.exec(`UPDATE members SET done = 1 WHERE user_id = ?`, user_id);
          continue;
        }
        member = null; // 404 Unknown Member: no longer in the server
      }
      this.synthetic(guild, "MEMBER_SNAPSHOT", { user_id, member });
      this.sql.exec(`UPDATE members SET done = 1 WHERE user_id = ?`, user_id);
    }
  }

  /** Downloads one pending media item and uploads it as a release asset, paced for GitHub's limits. */
  private async mediaWork(cfg: Config, guild: GuildConfig): Promise<void> {
    const now = Date.now();
    if (now < Number(this.get("githubBackoffUntil") ?? "0")) return;
    // Default spacing (8 s) keeps uploads under GitHub's 80/min and 500/h content-creation limits.
    if (now < Number(this.get("lastUploadAt") ?? "0") + cfg.mediaSpacingMs) return;
    const row = this.sql
      .exec<MediaRow>(`SELECT key, url, channel_id, message_id, month, attempts FROM media WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 1`, now)
      .toArray()[0];
    if (!row) return;
    try {
      const result = await this.storeMedia(cfg, guild, row);
      // Attachments carry their channel, so their records are filed (and removable) with it.
      this.synthetic(guild, result.ok ? "MEDIA_STORED" : "MEDIA_FAILED", { ...result.record, ...(row.channel_id ? { channel_id: row.channel_id } : {}) });
      this.sql.exec(`UPDATE media SET status = ? WHERE key = ?`, result.ok ? "done" : "failed", row.key);
    } catch (e) {
      if (e instanceof GitHubError && (e.retryAfterMs !== null || e instanceof GitHubAuthError)) {
        // Rate limited, or the App can't access the repo (a setup problem): back off globally
        // without charging the item an attempt, so fixing the setup loses nothing.
        const wait = e.retryAfterMs !== null ? Math.max(e.retryAfterMs, 60_000) : 5 * 60_000;
        this.set("githubBackoffUntil", String(Date.now() + wait));
        this.set("lastError", JSON.stringify({ at: new Date().toISOString(), error: errorMessage(e).slice(0, 500), status: e.status }));
        log("github_backoff", { waitMs: wait, error: errorMessage(e) });
        return;
      }
      const attempts = row.attempts + 1;
      log("media_error", { key: row.key, attempts, error: errorMessage(e) });
      if (attempts >= MEDIA_MAX_ATTEMPTS) {
        this.synthetic(guild, "MEDIA_FAILED", { key: row.key, reason: errorMessage(e).slice(0, 200), ...(row.channel_id ? { channel_id: row.channel_id } : {}) });
        this.sql.exec(`UPDATE media SET status = 'failed', attempts = ? WHERE key = ?`, attempts, row.key);
      } else {
        this.sql.exec(`UPDATE media SET attempts = ?, next_at = ? WHERE key = ?`, attempts, Date.now() + 60_000 * 2 ** attempts, row.key);
      }
    } finally {
      this.set("lastUploadAt", String(Date.now()));
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
        const archiveJsonKey = `archiveJson:${guild.repo}:${guild.branch}:${guild.path}`;
        const writeArchiveJson = !head || (!this.get(archiveJsonKey) && !(await gh.readFile(archiveJson, head)));
        if (writeArchiveJson) {
          files.push({ path: archiveJson, content: JSON.stringify({ format: 2, guild_id: this.get("guildId"), generator: "rejgau" }, null, 2) + "\n" });
        }
        try {
          sha = await gh.commit(guild.branch, head, files, `Archive ${taken} event${taken === 1 ? "" : "s"}`);
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          log("flush_conflict", { attempt });
        }
      }
      if (!sha) throw new Error("branch kept moving; will retry");
      this.set(`archiveJson:${guild.repo}:${guild.branch}:${guild.path}`, "1");
      const paths = [...byPath.keys()];
      this.sql.exec(`DELETE FROM pending WHERE n <= ? AND path IN (${paths.map(() => "?").join(",")})`, maxN, ...paths);
      const remaining = this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM pending`).one().c;
      this.set("dirtySince", remaining ? String(Date.now() - 3_600_000) : null); // leftovers: flush again soon
      this.set("retryAt", null);
      this.set("failures", null);
      this.set("lastCommit", JSON.stringify({ sha, at: new Date().toISOString(), lines: taken }));
      if (guild.pages) this.set("dispatchPending", "1");
      this.set("lastError", null);
      log("flush_ok", { sha, lines: taken, files: paths.length });
      return { committed: taken, sha };
    } catch (e) {
      const failures = Number(this.get("failures") ?? "0") + 1;
      this.set("failures", String(failures));
      const backoff = e instanceof GitHubError && e.retryAfterMs !== null ? Math.max(e.retryAfterMs, 60_000) : Math.min(15 * 60_000, 30_000 * 2 ** (failures - 1));
      this.set("retryAt", String(Date.now() + backoff));
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
      membersPending: count(`SELECT COUNT(*) AS c FROM members WHERE done = 0`),
      mediaDone: count(`SELECT COUNT(*) AS c FROM media WHERE status = 'done'`),
      mediaFailed: count(`SELECT COUNT(*) AS c FROM media WHERE status = 'failed'`),
      lastCommit: JSON.parse(this.get("lastCommit") ?? "null"),
      lastError: JSON.parse(this.get("lastError") ?? "null"),
      retryAt: this.get("retryAt") ? new Date(Number(this.get("retryAt"))).toISOString() : null,
      githubBackoffUntil: this.get("githubBackoffUntil") ? new Date(Number(this.get("githubBackoffUntil"))).toISOString() : null,
      bootstrapError: this.get("bootstrapError"),
      permissionsKnown: this.permissions() !== null,
      administrator: isAdministrator(this.permissions()),
      permissionsError: this.get("permissionsError"),
      hiddenChannels: [...this.channels.values()].filter((c) => c.hidden && !c.deleted && c.type !== 4).length,
    };
  }

  /** Commits everything buffered now (ignoring the flush schedule). */
  async flushNow(guildId: string): Promise<{ committed?: number; error?: string }> {
    this.adopt(guildId);
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

  /**
   * Forgets everything about this guild (buffer, channel state, cursors, media queue), so the next
   * event bootstraps and backfills from scratch. For test setups; already-uploaded media is reused.
   */
  reset(): Promise<void> {
    // On the ingest chain, so no ingest runs before or during the wipe.
    const run = this.ingestChain.then(async () => {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      // abort() discards writes not yet confirmed on disk, so wait for the wipe before restarting.
      await this.ctx.storage.sync();
      this.ctx.abort("reset", { retryAlarm: false }); // restart with fresh tables
    });
    this.ingestChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Starts archiving without waiting for an event (e.g. right after a reset): records the config,
   * loads the channel tree over REST and queues the backfill.
   */
  start(guildId: string): Promise<{ started: boolean; error?: string }> {
    const run = this.ingestChain.then(async () => {
      this.adopt(guildId);
      const conf = this.guildConfig();
      if (!conf) return { started: false, error: "guild not configured" };
      try {
        if ((await this.ensurePermissions(guildId, true)) && this.get("initialized")) this.reconcile(conf.guild);
        this.checkConfigChange(conf.guild);
        if (!this.get("initialized") && !(await this.tryBootstrap(conf.guild, guildId))) {
          return { started: false, error: this.get("bootstrapError") ?? "bootstrap failed recently; the next event retries" };
        }
        return { started: true };
      } catch (e) {
        return { started: false, error: `${errorMessage(e)}; the next event retries` };
      } finally {
        await this.scheduleAlarm();
      }
    });
    this.ingestChain = run.then(() => {}, () => {});
    return run;
  }

  /** Puts failed media back in the queue (e.g. after fixing the GitHub setup). */
  async retryFailedMedia(): Promise<{ requeued: number }> {
    const n = this.sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM media WHERE status = 'failed'`).one().c;
    this.sql.exec(`UPDATE media SET status = 'pending', attempts = 0, next_at = 0 WHERE status = 'failed'`);
    this.set("githubBackoffUntil", null);
    await this.scheduleAlarm();
    return { requeued: n };
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
  membersPending: number;
  mediaDone: number;
  mediaFailed: number;
  lastCommit: { sha: string; at: string; lines: number } | null;
  lastError: { at: string; error: string; status?: number } | null;
  retryAt: string | null;
  githubBackoffUntil: string | null;
  bootstrapError: string | null;
  /** Whether the bot's permissions are known (until they are, no channel is archived). */
  permissionsKnown: boolean;
  /** The bot has Administrator, so it can view every channel and denies don't keep any out. */
  administrator: boolean;
  /** Why the bot's permissions couldn't be read (e.g. it isn't in the guild); retried every 10 minutes. */
  permissionsError: string | null;
  /** Channels (not threads) the bot can't view, which are never archived. */
  hiddenChannels: number;
}

function toInfo(r: ChannelRow): ChannelInfo {
  return { id: r.id, type: r.type, parentId: r.parent_id, flags: r.flags, deleted: r.deleted === 1 };
}
