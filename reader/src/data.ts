// Data loading and helpers for the archive reader.

import {
  MAX_PUBLICATION_FILE_BYTES, parseArchive, parseMonthFile, parseSearchRows, parseUsersFile,
  type Archive, type MonthFile, type Role, type SearchRow, type UserSnap, type UsersFile,
} from "../../shared/publication";
import { BoundedCache } from "./cache";

export type { Archive, ChannelInfo, MonthFile, Role, UserSnap, UsersFile } from "../../shared/publication";

export const MAX_JSON_BYTES = MAX_PUBLICATION_FILE_BYTES;
export const CACHE_BYTES = 16 * 1024 * 1024;
export const CACHE_ENTRIES = 12;
const cache = new BoundedCache<unknown>(CACHE_ENTRIES, CACHE_BYTES);

export class DataError extends Error {
  constructor(message: string, readonly reload = false) {
    super(message);
    this.name = "DataError";
  }
}

async function readJson(path: string, signal?: AbortSignal, reloadOnMissing = false, refresh = false): Promise<{ value: unknown; bytes: number }> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new Error("The data request timed out. Try again.")), 30_000);
  try {
    const response = await fetch(`data/${path}`, { signal: controller.signal, ...(refresh ? { cache: "no-cache" as const } : {}) });
    if (!response.ok) {
      if (response.status === 404 && reloadOnMissing) throw new DataError("The archive changed. Reload the archive to continue.", true);
      throw new DataError(`The data request failed (HTTP ${response.status}). Try again.`);
    }
    if (!response.body) throw new DataError("The data response is empty. Try again.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_JSON_BYTES) {
          await reader.cancel();
          throw new DataError("This archive data file exceeds the 32 MiB reader limit. The publisher must split the file.");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return { value: JSON.parse(text) as unknown, bytes };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function loadArchive(signal?: AbortSignal): Promise<Archive> {
  return parseArchive((await readJson("archive.json", signal, false, true)).value);
}

function dataPath(archive: Archive, path: string): string {
  if (archive.data_root) return `${archive.data_root}${path}`;
  return `${path}?v=${encodeURIComponent(archive.built_at)}`;
}

async function loadBuild<T>(archive: Archive, path: string, parse: (value: unknown) => T, signal?: AbortSignal, retain = true): Promise<T> {
  const key = dataPath(archive, path);
  const previous = cache.get(key);
  if (previous !== undefined) return previous as T;
  const result = await readJson(key, signal, !!archive.data_root);
  const value = parse(result.value);
  if (retain && !signal?.aborted) cache.set(key, value, result.bytes);
  return value;
}

export const loadUsers = (archive: Archive, signal?: AbortSignal): Promise<UsersFile> =>
  loadBuild(archive, "users.json", parseUsersFile, signal, false);

export async function loadMonth(archive: Archive, channel: string, month: string, signal?: AbortSignal): Promise<MonthFile> {
  return loadBuild(archive, `c/${channel}/${month}.json`, (value) => {
    const file = parseMonthFile(value);
    if (file.channel !== channel || file.month !== month) throw new DataError("The message file does not match this channel and month.");
    return file;
  }, signal);
}

export const loadSearchMonth = (archive: Archive, month: string, signal?: AbortSignal): Promise<SearchRow[]> =>
  loadBuild(archive, `search/${month}.json`, parseSearchRows, signal);

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

/** What a system message (join, boost, pin notice, …) says after the author's name. */
export const SYSTEM_TEXT: Record<number, string> = {
  1: "added someone to the thread.",
  2: "removed someone from the thread.",
  4: "changed the channel name.",
  5: "changed the channel icon.",
  6: "pinned a message to this channel.",
  7: "joined the server.",
  8: "boosted the server!",
  9: "boosted the server! The server has reached Level 1!",
  10: "boosted the server! The server has reached Level 2!",
  11: "boosted the server! The server has reached Level 3!",
  12: "added a channel follow.",
  18: "started a thread",
  46: "'s poll has closed.",
};

/** Message types rendered as regular messages; everything else is a compact system line. */
export const NORMAL_TYPES = new Set([0, 19, 20, 21, 23]);
