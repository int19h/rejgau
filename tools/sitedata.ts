// Turns folded archive state into the reader's data files. Pure: returns path → JSON value.

import { avatarRef, emojiRef, guildIconRef, mediaInMessage, type MediaRef } from "../src/media";
import { isPublished, previewText, referencedMessage, tallyCount, type ArchiveState, type MessageState } from "./fold";
import { normalizeText } from "../reader/src/text";

import { parseArchive, parseMonthFile, parseSearchRows, parseUsersFile, type Archive, type ChannelInfo, type MonthFile, type PublicationFile, type PublishedMessage, type SearchRow, type UserSnap, type UsersFile } from "../shared/publication";
export type { UserSnap } from "../shared/publication";

const DISCORD_EPOCH = 1420070400000n;
export const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
const monthOf = (id: string) => new Date(snowflakeTime(id)).toISOString().slice(0, 7);
const byId = (a: MessageState, b: MessageState) => (BigInt(a.m.id) < BigInt(b.m.id) ? -1 : BigInt(a.m.id) > BigInt(b.m.id) ? 1 : 0);

function snapUser(user: any, member: any | null | undefined, asof?: "backfill"): UserSnap | null {
  if (!user?.id) return null;
  const s: UserSnap = { id: user.id, username: user.username, global_name: user.global_name ?? null, avatar: user.avatar ?? null };
  if (user.bot) s.bot = true;
  if (user.system) s.system = true;
  const guildTag = user.primary_guild ?? user.clan;
  if (guildTag?.tag && guildTag.identity_enabled) s.tag = guildTag.tag;
  if (member) {
    if (member.nick) s.nick = member.nick;
    if (member.avatar) s.member_avatar = member.avatar;
    if (Array.isArray(member.roles) && member.roles.length) s.roles = member.roles;
    if (asof && (member.nick || member.roles?.length)) s.member_asof = asof;
  }
  return s;
}

/** Collects user snapshots for one output file, deduplicated by content. */
class SnapTable {
  readonly users: Record<string, UserSnap> = {};
  private byJson = new Map<string, string>();

  add(s: UserSnap | null): string | undefined {
    if (!s) return undefined;
    const json = JSON.stringify(s);
    let key = this.byJson.get(json);
    if (!key) {
      key = `${s.id}.${this.byJson.size}`;
      this.byJson.set(json, key);
      this.users[key] = s;
    }
    return key;
  }
}

/** All searchable text of a message (current version only). */
function searchText(m: any): string {
  const parts: string[] = [m.content ?? ""];
  for (const e of m.embeds ?? []) parts.push(e.title ?? "", e.description ?? "", e.author?.name ?? "", e.footer?.text ?? "", ...(e.fields ?? []).flatMap((f: any) => [f.name ?? "", f.value ?? ""]));
  for (const a of m.attachments ?? []) parts.push(a.filename ?? "");
  const walk = (c: any): void => {
    if (Array.isArray(c)) c.forEach(walk);
    else if (c && typeof c === "object") {
      if (typeof c.content === "string") parts.push(c.content);
      if (typeof c.label === "string") parts.push(c.label);
      walk(c.components);
      walk(c.accessory);
    }
  };
  walk(m.components);
  for (const s of m.message_snapshots ?? []) parts.push(searchText(s.message ?? {}));
  if (m.poll) parts.push(m.poll.question?.text ?? "", ...(m.poll.answers ?? []).map((a: any) => a.poll_media?.text ?? ""));
  return parts.filter(Boolean).join("\n");
}

const LINK = /https?:\/\/\S/;

/** Discord's `has:` categories for a message. */
function hasFlags(m: any): string[] {
  const has = new Set<string>();
  const bodies = [m, ...(m.message_snapshots ?? []).map((s: any) => s.message ?? {})];
  for (const b of bodies) {
    if (LINK.test(b.content ?? "")) has.add("link");
    if (b.embeds?.length) has.add("embed");
    for (const e of b.embeds ?? []) {
      if (e.url) has.add("link");
      if (e.type === "image" || e.type === "gifv") has.add("image");
      if (e.type === "video" || e.video) has.add("video");
    }
    for (const a of b.attachments ?? []) {
      has.add("file");
      const t = String(a.content_type ?? "");
      if (t.startsWith("image/")) has.add("image");
      else if (t.startsWith("video/")) has.add("video");
      else if (t.startsWith("audio/")) has.add("sound");
    }
    if (b.sticker_items?.length) has.add("sticker");
  }
  if (m.poll) has.add("poll");
  if (m.message_snapshots?.length) has.add("forward");
  return [...has];
}

interface Context {
  state: ArchiveState;
  guildId: string;
  /** thread id → number of archived messages in it */
  threadCounts: Map<string, number>;
}

function messageOut(ms: MessageState, ctx: Context, snaps: SnapTable, media: Set<string>): PublishedMessage {
  const { state } = ctx;
  const m = ms.m;
  const fallback = !m.member && m.author?.id ? state.memberSnapshots.get(m.author.id) : undefined;
  const out: PublishedMessage = {
    id: m.id,
    ts: m.timestamp ?? new Date(snowflakeTime(m.id)).toISOString(),
    type: m.type ?? 0,
    author: snaps.add(snapUser(m.author, m.member ?? fallback, m.member ? undefined : "backfill")),
    content: m.content ?? "",
  };
  const copy = ["flags", "edited_timestamp", "attachments", "embeds", "components", "sticker_items", "poll", "webhook_id", "application_id", "tts", "mention_everyone", "mention_roles", "message_snapshots", "call", "role_subscription_data", "activity"];
  for (const k of copy) {
    const v = m[k];
    if (v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0)) continue;
    Object.assign(out, { [k]: v });
  }
  if (ms.pinned) out.pinned = true;
  if (Array.isArray(m.mentions) && m.mentions.length) {
    out.mentions = m.mentions.map((u: any) => snaps.add(snapUser(u, u.member))).filter(Boolean);
  }
  if (ms.reactions.size) {
    out.reactions = [...ms.reactions.values()].map((r) => ({
      emoji: r.emoji,
      count: tallyCount(r),
      ...(r.burst ? { burst: true } : {}),
      ...(r.known.size ? { users: [...r.known] } : {}),
    }));
  }
  if (ms.votes.size) {
    out.votes = Object.fromEntries([...ms.votes].map(([id, v]) => [id, { count: tallyCount(v), ...(v.known.size ? { users: [...v.known] } : {}) }]));
  }
  if (m.message_reference) out.reference = m.message_reference;

  // Reply preview, or for a thread's first message, the message it was started from.
  const ref = referencedMessage(state, m);
  if (ref === "deleted" || (!ref && m.type === 19 && m.message_reference?.message_id)) out.referenced = { deleted: true };
  else if (ref?.id) {
    out.referenced = {
      id: ref.id,
      channel_id: ref.channel_id,
      author: snaps.add(snapUser(ref.author, null)),
      content: previewText(ref.content, 300),
      ...(ref.attachments?.length ? { attachments: true } : {}),
      ...(ref.embeds?.length ? { embeds: true } : {}),
    };
    if (ref.author?.id && ref.author.avatar) media.add(avatarRef(ref.author.id, ref.author.avatar).key);
  }

  const im = m.interaction_metadata ?? m.interaction;
  if (im) {
    const owners = m.interaction_metadata?.authorizing_integration_owners ?? {};
    out.interaction = {
      name: m.interaction_metadata?.name ?? m.interaction?.name ?? null,
      type: im.type,
      ...(m.interaction_metadata?.command_type ? { command_type: m.interaction_metadata.command_type } : {}),
      user: snaps.add(snapUser(im.user, m.interaction?.member)),
      // Installed only for the invoking user, not in this server.
      ...(owners["1"] && !owners["0"] ? { user_installed: true } : {}),
    };
  }

  // A message that started a thread (or a forum post, whose id is the thread id).
  const threadId = m.thread?.id ?? (state.channels.has(m.id) && m.channel_id !== m.id ? m.id : undefined);
  if (threadId && isPublished(state, threadId)) {
    out.thread = { id: threadId, name: state.channels.get(threadId)!.c.name ?? m.thread?.name, count: ctx.threadCounts.get(threadId) ?? 0 };
  }

  for (const r of mediaInMessage(m, ctx.guildId)) media.add(r.key);
  // Reactions folded from live events aren't in the message snapshot.
  for (const r of ms.reactions.values()) if (r.emoji?.id) media.add(emojiRef(r.emoji.id, !!r.emoji.animated).key);
  if (fallback?.avatar && m.author?.id) media.add(`gavatar-${ctx.guildId}-${m.author.id}-${fallback.avatar}.${String(fallback.avatar).startsWith("a_") ? "gif" : "png"}`);
  return out;
}

function searchRow(msg: PublishedMessage, channelId: string, snaps: SnapTable, m: any): SearchRow {
  const author = msg.author ? snaps.users[msg.author] : undefined;
  const row: SearchRow = {
    id: msg.id,
    c: channelId,
    ts: msg.ts,
    a: author?.id,
    text: normalizeText(searchText(m)),
    // What the result list shows.
    x: searchText(m).replace(/\s+/g, " ").slice(0, 300),
    at: m.webhook_id ? "webhook" : author?.bot ? "bot" : "user",
  };
  const has = hasFlags(m);
  if (has.length) row.has = has;
  const men = (m.mentions ?? []).map((u: any) => u.id);
  if (men.length) row.men = men;
  if (msg.pinned) row.pin = true;
  return row;
}

export interface SiteData {
  files: Map<string, PublicationFile>;
}

export function buildSiteData(state: ArchiveState, builtAt = new Date().toISOString()): SiteData {
  const files = new Map<string, PublicationFile>();
  const guildId = state.guild.id ?? "";
  const media = (key: string) => {
    const e = state.media.get(key);
    return e?.url ?? null;
  };

  // Only channels that are currently selected produce data (see docs/reader.md).
  const byFile = new Map<string, MessageState[]>();
  const threadCounts = new Map<string, number>();
  for (const ms of state.messages.values()) {
    // Deleted messages (and earlier versions of edited ones) stay in raw/ but aren't published.
    if (!isPublished(state, ms.channelId) || ms.deletedAt) continue;
    const key = `${ms.channelId}/${monthOf(ms.m.id)}`;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(ms);
    threadCounts.set(ms.channelId, (threadCounts.get(ms.channelId) ?? 0) + 1);
  }
  const ctx: Context = { state, guildId, threadCounts };

  const months: Record<string, Record<string, number>> = {};
  const latestUsers = new Map<string, { snap: UserSnap; ts: string; names: Set<string> }>();
  const search = new Map<string, SearchRow[]>();
  const noteUser = (u: UserSnap | undefined, ts: string) => {
    if (!u) return;
    const cur = latestUsers.get(u.id) ?? { snap: u, ts, names: new Set<string>() };
    for (const n of [u.username, u.global_name, u.nick]) if (n) cur.names.add(n);
    if (cur.ts <= ts) {
      cur.snap = u;
      cur.ts = ts;
    }
    latestUsers.set(u.id, cur);
  };

  for (const [key, list] of byFile) {
    list.sort(byId);
    const [channelId, month] = key.split("/");
    const snaps = new SnapTable();
    const keys = new Set<string>();
    const messages = list.map((ms) => messageOut(ms, ctx, snaps, keys));
    const mediaMap: Record<string, string | null> = {};
    for (const k of keys) mediaMap[k] = media(k);
    const file: MonthFile = { channel: channelId, month, media: mediaMap, users: snaps.users, messages };
    files.set(`c/${key}.json`, parseMonthFile(file));
    (months[channelId] ??= {})[month] = messages.length;
    messages.forEach((msg, i) => {
      noteUser(msg.author ? snaps.users[msg.author] : undefined, msg.ts);
      for (const k of msg.mentions ?? []) noteUser(snaps.users[k], msg.ts);
      if (msg.referenced && !msg.referenced.deleted && msg.referenced.author) noteUser(snaps.users[msg.referenced.author], msg.ts);
      if (msg.interaction?.user) noteUser(snaps.users[msg.interaction.user], msg.ts);
      const required = new Set([
        ...(msg.reactions ?? []).flatMap((r) => r.users ?? []),
        ...Object.values(msg.votes ?? {}).flatMap((v) => v.users ?? []),
      ]);
      for (const id of required) {
        const profile = state.reactors.get(msg.id)?.get(id);
        if (profile) noteUser(snapUser(profile.user, profile.member) ?? undefined, profile.at);
      }
      if (!search.has(month)) search.set(month, []);
      search.get(month)!.push(searchRow(msg, channelId, snaps, list[i].m));
    });
  }
  for (const [month, rows] of search) {
    rows.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)); // newest first
    files.set(`search/${month}.json`, parseSearchRows(rows));
  }

  // Channel tree: selected channels and their ancestors.
  const channels: Record<string, ChannelInfo> = {};
  const include = (id: string | null | undefined, depth = 0): void => {
    if (!id || depth > 4 || channels[id]) return;
    const ch = state.channels.get(id);
    if (!ch) return;
    const c = ch.c;
    channels[id] = {
      id,
      name: c.name,
      type: c.type,
      parent_id: c.parent_id ?? null,
      position: c.position ?? 0,
      ...(c.topic ? { topic: c.topic } : {}),
      ...(c.nsfw ? { nsfw: true } : {}),
      ...(ch.deleted ? { deleted: true } : {}),
      ...(c.thread_metadata ? { archived: !!c.thread_metadata.archived, created: c.thread_metadata.create_timestamp ?? null } : {}),
      months: months[id] ?? {},
    };
    include(c.parent_id, depth + 1);
  };
  for (const id of state.channels.keys()) if (isPublished(state, id)) include(id);

  const users: Record<string, UserSnap> = {};
  const userMedia: Record<string, string | null> = {};
  for (const [id, u] of latestUsers) {
    users[id] = { ...u.snap, names: [...u.names] };
    if (u.snap.avatar) {
      const ref: MediaRef = avatarRef(id, u.snap.avatar);
      userMedia[ref.key] = media(ref.key);
    }
  }

  const g = state.guild;
  const icon = g.icon && g.id ? guildIconRef(g.id, g.icon) : null;
  const archive: Archive = {
    format: 1,
    built_at: builtAt,
    guild: { id: g.id ?? "", name: g.name ?? "Discord archive", icon_url: icon ? media(icon.key) : null, roles: g.roles ?? [], emojis: g.emojis ?? [], stickers: g.stickers ?? [] },
    channels,
    search_months: [...search.keys()].sort().reverse(),
  };
  const userFile: UsersFile = { users, media: userMedia };
  files.set("archive.json", parseArchive(archive));
  files.set("users.json", parseUsersFile(userFile));
  return { files };
}
