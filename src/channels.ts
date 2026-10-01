// Which channels are archived. Pure logic over a snapshot of the guild's channel tree.

import type { GuildConfig } from "./config";

export interface ChannelInfo {
  id: string;
  type: number;
  parentId: string | null;
  flags: number;
  deleted: boolean;
  /** The bot can't view it (from its roles and the channel's permission overwrites). */
  hidden?: boolean;
}

export const CHANNEL_TYPE_CATEGORY = 4;
/** Channels the bot can't view arrive with this flag (from 2026-11-16) and must be ignored. */
export const CHANNEL_FLAG_OBFUSCATED = 1 << 17;
const THREAD_TYPES = new Set([10, 11, 12]);

export function isThread(ch: ChannelInfo): boolean {
  return THREAD_TYPES.has(ch.type);
}

/** The channel itself followed by its ancestors (thread → channel → category). */
export function ancestry(id: string, channels: ReadonlyMap<string, ChannelInfo>): string[] {
  const chain: string[] = [];
  let cur: string | null = id;
  while (cur !== null && chain.length < 4 && !chain.includes(cur)) {
    chain.push(cur);
    cur = channels.get(cur)?.parentId ?? null;
  }
  return chain;
}

/** Whether messages and events in this channel (or thread) are archived. Categories never are. */
export function isArchived(id: string, channels: ReadonlyMap<string, ChannelInfo>, cfg: GuildConfig): boolean {
  const ch = channels.get(id);
  if (!ch || ch.type === CHANNEL_TYPE_CATEGORY) return false;
  const chain = ancestry(id, channels);
  // Fail closed: if part of the parent chain is unknown, an `exclude` or category selection can't
  // be evaluated, so nothing is archived until the chain is known.
  const top = channels.get(chain[chain.length - 1]);
  if (!top || (top.parentId && !channels.has(top.parentId))) return false;
  for (const c of chain) {
    if ((channels.get(c)?.flags ?? 0) & CHANNEL_FLAG_OBFUSCATED) return false;
  }
  // Channels the bot can't view are never archived (their names and topics would leak otherwise).
  // A thread is visible exactly when its parent is.
  if (ch.hidden || (isThread(ch) && ch.parentId && channels.get(ch.parentId)?.hidden)) return false;
  if (chain.some((c) => cfg.exclude.includes(c))) return false;
  if (cfg.channels === "all") return true;
  return chain.some((c) => (cfg.channels as string[]).includes(c));
}

/**
 * IDs that belong in channels.json: every archived channel/thread plus the ancestors of those
 * (so the reader can show category and parent names). Nothing else, so names of channels that
 * aren't archived never reach the repo.
 */
export function publishedChannelIds(channels: ReadonlyMap<string, ChannelInfo>, cfg: GuildConfig): Set<string> {
  const out = new Set<string>();
  for (const id of channels.keys()) {
    if (isArchived(id, channels, cfg)) for (const c of ancestry(id, channels)) out.add(c);
  }
  return out;
}

// --- permissions ---

/** What's needed to work out the bot's permissions in a channel. */
export interface PermissionContext {
  guildId: string;
  /** The bot's user ID. */
  userId: string;
  /** Role ID → permission bitset (as Discord sends it, a decimal string). The @everyone role's ID is the guild ID. */
  roles: Record<string, string>;
  /** The bot's roles (not including @everyone). */
  memberRoles: string[];
}

const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;

function bits(v: unknown): bigint {
  try {
    return typeof v === "string" || typeof v === "number" ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Whether the bot can view a (non-thread) channel with these permission overwrites, following
 * Discord's order: base permissions from @everyone and the bot's roles (administrator sees all),
 * then the channel's @everyone overwrite, its role overwrites combined, then the bot's own.
 */
export function canView(overwrites: unknown, p: PermissionContext): boolean {
  let base = bits(p.roles[p.guildId]);
  for (const r of p.memberRoles) base |= bits(p.roles[r]);
  if (base & ADMINISTRATOR) return true;
  const list = (Array.isArray(overwrites) ? overwrites : []) as { id: string; type: number | string; allow: string; deny: string }[];
  const isRole = (o: { type: number | string }) => o.type === 0 || o.type === "role";
  let perms = base;
  const everyone = list.find((o) => o.id === p.guildId && isRole(o));
  if (everyone) perms = (perms & ~bits(everyone.deny)) | bits(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of list) {
    if (isRole(o) && o.id !== p.guildId && p.memberRoles.includes(o.id)) {
      allow |= bits(o.allow);
      deny |= bits(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const mine = list.find((o) => !isRole(o) && o.id === p.userId);
  if (mine) perms = (perms & ~bits(mine.deny)) | bits(mine.allow);
  return (perms & VIEW_CHANNEL) !== 0n;
}

// --- where raw lines go ---

const CHANNEL_SCOPED = new Set([
  "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE", "THREAD_CREATE", "THREAD_UPDATE", "THREAD_DELETE",
  "THREAD_MEMBER_UPDATE", "THREAD_MEMBERS_UPDATE", "CHANNEL_UNSELECTED",
]);

/**
 * Which file of a day a raw line goes to: the ID of the channel or thread it concerns, or "guild"
 * for server-wide records (snapshots, roles, emoji, members, media, sessions, config).
 */
export function lineScope(t: string, d: any): string {
  let id: unknown;
  if (t === "CHANNEL_SELECTED") id = d?.channel?.id;
  else if (CHANNEL_SCOPED.has(t)) id = d?.id;
  else id = d?.channel_id;
  return typeof id === "string" && /^\d{1,20}$/.test(id) ? id : "guild";
}
