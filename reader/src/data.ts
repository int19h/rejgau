// Loading the build's data files, plus helpers shared by views.

export interface UserSnap {
  id: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
  system?: boolean;
  nick?: string | null;
  member_asof?: "backfill";
  member_avatar?: string | null;
  roles?: string[];
  tag?: string | null;
  names?: string[];
}

export interface ChannelInfo {
  id: string;
  name?: string;
  type: number;
  parent_id: string | null;
  position: number;
  topic?: string;
  nsfw?: boolean;
  deleted?: boolean;
  archived?: boolean;
  created?: string | null;
  months: Record<string, number>;
}

export interface Role {
  id: string;
  name: string;
  color?: number;
  colors?: { primary_color?: number };
  position: number;
}

export interface Archive {
  format: number;
  built_at: string;
  guild: { id: string; name: string; icon_url: string | null; roles: Role[]; emojis: any[]; stickers: any[] };
  channels: Record<string, ChannelInfo>;
  search_months: string[];
}

export interface MonthFile {
  channel: string;
  month: string;
  media: Record<string, string | null>;
  users: Record<string, UserSnap>;
  messages: any[];
}

export interface UsersFile {
  users: Record<string, UserSnap>;
  media: Record<string, string | null>;
}

const BASE = "data/";
const cache = new Map<string, Promise<any>>();

export function load<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = fetch(BASE + path).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

export const loadArchive = () => load<Archive>("archive.json");
export const loadUsers = () => load<UsersFile>("users.json");
export const loadMonth = (channel: string, month: string) => load<MonthFile>(`c/${channel}/${month}.json`);
export const loadSearchMonth = (month: string) => load<any[]>(`search/${month}.json`);

const DISCORD_EPOCH = 1420070400000n;
export const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
export const monthOfId = (id: string) => new Date(snowflakeTime(id)).toISOString().slice(0, 7);

export function displayName(u: UserSnap | undefined | null): string {
  if (!u) return "Unknown";
  return u.nick || u.global_name || u.username || "Unknown";
}

export function hexColor(n: unknown): string | undefined {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 0xffffff) return undefined;
  return `#${n.toString(16).padStart(6, "0")}`;
}

/** Colour of a member's highest-positioned coloured role, as Discord shows names. */
export function roleColor(roleIds: string[] | undefined, roles: Role[]): string | undefined {
  if (!roleIds?.length) return undefined;
  let best: Role | undefined;
  for (const r of roles) {
    const c = r.colors?.primary_color ?? r.color;
    if (c && roleIds.includes(r.id) && (!best || r.position > best.position)) best = r;
  }
  return best ? hexColor(best.colors?.primary_color ?? best.color) : undefined;
}

/** Text-ish channel types that have messages. */
export const MESSAGE_CHANNEL_TYPES = new Set([0, 2, 5, 10, 11, 12, 13, 15, 16]);
export const THREAD_TYPES = new Set([10, 11, 12]);
