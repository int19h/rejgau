// Which channels are archived. Pure logic over a snapshot of the guild's channel tree.

import type { GuildConfig } from "./config";

export interface ChannelInfo {
  id: string;
  type: number;
  parentId: string | null;
  flags: number;
  deleted: boolean;
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
  for (const c of chain) {
    if ((channels.get(c)?.flags ?? 0) & CHANNEL_FLAG_OBFUSCATED) return false;
  }
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
