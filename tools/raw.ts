import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { parseMessageBody } from "../shared/publication";
import type { RawLine } from "./fold";

export interface RawLimits {
  maxBytes: number;
  maxRecords: number;
  maxLineBytes: number;
  maxFiles: number;
  maxDepth: number;
}

/** These limits bound input size. Folding also needs memory for parsed and derived objects. */
export const DEFAULT_RAW_LIMITS: Readonly<RawLimits> = {
  maxBytes: 64 * 1024 * 1024,
  maxRecords: 250_000,
  maxLineBytes: 4 * 1024 * 1024,
  maxFiles: 20_000,
  maxDepth: 16,
};

export interface RawArchive {
  lines: RawLine[];
  digest: string;
  bytes: number;
  skipped: number;
  diagnostics: string[];
}

export interface RawOptions {
  limits?: Partial<RawLimits>;
  skipBadLines?: boolean;
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown, path: string): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path}: expected an object`);
  return value as ObjectValue;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
  return value;
}

export function discordId(value: unknown, path = "id"): asserts value is string {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    throw new Error(`${path}: expected a Discord ID between 1 and 18446744073709551615`);
  }
}

function ids(o: ObjectValue, names: string[], path: string, required: string[] = []): void {
  for (const name of names) {
    if (o[name] !== undefined && o[name] !== null || required.includes(name)) discordId(o[name], `${path}.${name}`);
  }
}

function stringField(o: ObjectValue, name: string, path: string): void {
  if (o[name] !== undefined && o[name] !== null && typeof o[name] !== "string") throw new Error(`${path}.${name}: expected a string`);
}

function numberField(o: ObjectValue, name: string, path: string): void {
  if (o[name] !== undefined && (!Number.isSafeInteger(o[name]) || Number(o[name]) < 0)) throw new Error(`${path}.${name}: expected a nonnegative integer`);
}

function idArray(value: unknown, path: string): void {
  array(value, path).forEach((id, i) => discordId(id, `${path}[${i}]`));
}

function user(value: unknown, path: string): void {
  const u = object(value, path);
  ids(u, ["id"], path, ["id"]);
  for (const k of ["username", "global_name", "avatar"]) stringField(u, k, path);
  if (u.member != null) member(u.member, `${path}.member`);
}

function member(value: unknown, path: string): void {
  const m = object(value, path);
  if (m.user != null) user(m.user, `${path}.user`);
  if (m.roles !== undefined) idArray(m.roles, `${path}.roles`);
  for (const k of ["nick", "avatar", "joined_at"]) stringField(m, k, path);
}

function channel(value: unknown, path: string): void {
  const c = object(value, path);
  ids(c, ["id", "guild_id", "parent_id", "owner_id", "last_message_id"], path, ["id"]);
  for (const k of ["name", "topic"]) stringField(c, k, path);
  for (const k of ["type", "position", "flags"]) numberField(c, k, path);
  if (c.thread_metadata != null) {
    const metadata = object(c.thread_metadata, `${path}.thread_metadata`);
    stringField(metadata, "create_timestamp", `${path}.thread_metadata`);
  }
}

function message(value: unknown, path: string, top = true): void {
  const m = object(value, path);
  ids(m, ["id", "channel_id", "guild_id", "webhook_id", "application_id"], path, top ? ["id", "channel_id"] : ["id"]);
  parseMessageBody(m);
  if (m.author != null) user(m.author, `${path}.author`);
  if (m.member != null) member(m.member, `${path}.member`);
  if (m.mentions !== undefined) array(m.mentions, `${path}.mentions`).forEach((u, i) => user(u, `${path}.mentions[${i}]`));
  if (m.mention_roles !== undefined) idArray(m.mention_roles, `${path}.mention_roles`);
  if (m.thread != null) channel(m.thread, `${path}.thread`);
  if (m.message_reference != null) ids(object(m.message_reference, `${path}.message_reference`), ["message_id", "channel_id", "guild_id"], `${path}.message_reference`);
  if (m.referenced_message != null) message(m.referenced_message, `${path}.referenced_message`, false);
  for (const key of ["interaction", "interaction_metadata"]) {
    if (m[key] == null) continue;
    const interaction = object(m[key], `${path}.${key}`);
    stringField(interaction, "name", `${path}.${key}`);
    if (interaction.user != null) user(interaction.user, `${path}.${key}.user`);
    if (interaction.member != null) member(interaction.member, `${path}.${key}.member`);
  }
}

/** Reject dangerous keys, excessive nesting, and non-finite JSON numbers before object merging. */
function jsonShape(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 64 || ++budget.nodes > 500_000) throw new Error("record exceeds the JSON structure limit");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("record contains a non-finite number");
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`record contains forbidden key ${key}`);
    jsonShape(child, depth + 1, budget);
  }
}

/** Parse the event envelope and every event field that controls folding or output paths. */
export function parseRawLine(value: unknown): RawLine {
  jsonShape(value);
  const line = object(value, "record");
  if (typeof line.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(line.at) || !Number.isFinite(Date.parse(line.at))) {
    throw new Error("record.at: expected an ISO date and time with a time zone");
  }
  if (typeof line.src !== "string" || !["gw", "rest", "rejgau"].includes(line.src)) throw new Error("record.src: expected gw, rest, or rejgau");
  if (typeof line.t !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(line.t)) throw new Error("record.t: expected an event name");
  if (line.sid !== undefined && typeof line.sid !== "string") throw new Error("record.sid: expected a string");
  numberField(line, "s", "record");
  const d = object(line.d, "record.d");
  const path = "record.d";
  ids(d, ["guild_id", "channel_id", "message_id", "user_id", "role_id"], path);

  switch (line.t) {
    case "CHANNEL_SELECTED":
      channel(d.channel, `${path}.channel`);
      if (d.ancestors !== undefined) array(d.ancestors, `${path}.ancestors`).forEach((c, i) => channel(c, `${path}.ancestors[${i}]`));
      break;
    case "CHANNEL_CREATE": case "CHANNEL_UPDATE": case "CHANNEL_DELETE":
    case "THREAD_CREATE": case "THREAD_UPDATE": case "THREAD_DELETE":
      channel(d, path);
      break;
    case "CHANNEL_UNSELECTED":
      discordId(d.id, `${path}.id`);
      break;
    case "THREAD_LIST_SYNC":
      array(d.threads, `${path}.threads`).forEach((c, i) => channel(c, `${path}.threads[${i}]`));
      if (d.channel_ids !== undefined) idArray(d.channel_ids, `${path}.channel_ids`);
      break;
    case "MESSAGE_CREATE": case "MESSAGE_UPDATE":
      message(d, path);
      break;
    case "MESSAGE_DELETE":
      ids(d, ["id", "channel_id"], path, ["id", "channel_id"]);
      break;
    case "MESSAGE_DELETE_BULK":
      discordId(d.channel_id, `${path}.channel_id`);
      idArray(d.ids, `${path}.ids`);
      break;
    case "MESSAGE_REACTION_ADD": case "MESSAGE_REACTION_REMOVE": case "MESSAGE_REACTION_REMOVE_ALL": case "MESSAGE_REACTION_REMOVE_EMOJI":
      ids(d, ["channel_id", "message_id"], path, ["channel_id", "message_id"]);
      if (line.t === "MESSAGE_REACTION_ADD" || line.t === "MESSAGE_REACTION_REMOVE") discordId(d.user_id, `${path}.user_id`);
      if (line.t !== "MESSAGE_REACTION_REMOVE_ALL") {
        const emoji = object(d.emoji, `${path}.emoji`);
        ids(emoji, ["id"], `${path}.emoji`);
        stringField(emoji, "name", `${path}.emoji`);
      }
      if (d.member != null) member(d.member, `${path}.member`);
      break;
    case "MESSAGE_POLL_VOTE_ADD": case "MESSAGE_POLL_VOTE_REMOVE":
      ids(d, ["channel_id", "message_id", "user_id"], path, ["channel_id", "message_id", "user_id"]);
      if (!Number.isSafeInteger(d.answer_id) || Number(d.answer_id) < 1) throw new Error(`${path}.answer_id: expected a positive integer`);
      break;
    case "MEMBER_SNAPSHOT":
      discordId(d.user_id, `${path}.user_id`);
      if (d.member != null) member(d.member, `${path}.member`);
      break;
    case "GUILD_SNAPSHOT": case "GUILD_UPDATE":
      ids(d, ["id"], path, ["id"]);
      stringField(d, "name", path);
      for (const field of ["roles", "emojis", "stickers"]) {
        if (d[field] === undefined) continue;
        array(d[field], `${path}.${field}`).forEach((value, i) => {
          const item = object(value, `${path}.${field}[${i}]`);
          discordId(item.id, `${path}.${field}[${i}].id`);
          stringField(item, "name", `${path}.${field}[${i}]`);
        });
      }
      break;
    case "GUILD_ROLE_CREATE": case "GUILD_ROLE_UPDATE": {
      const role = object(d.role, `${path}.role`);
      discordId(role.id, `${path}.role.id`);
      stringField(role, "name", `${path}.role`);
      break;
    }
    case "GUILD_ROLE_DELETE":
      discordId(d.role_id, `${path}.role_id`);
      break;
    case "GUILD_EMOJIS_UPDATE": case "GUILD_STICKERS_UPDATE": {
      const key = line.t === "GUILD_EMOJIS_UPDATE" ? "emojis" : "stickers";
      array(d[key], `${path}.${key}`).forEach((v, i) => {
        const item = object(v, `${path}.${key}[${i}]`);
        discordId(item.id, `${path}.${key}[${i}].id`);
        stringField(item, "name", `${path}.${key}[${i}]`);
      });
      break;
    }
    case "MEDIA_STORED": case "MEDIA_FAILED":
      if (typeof d.key !== "string" || !d.key) throw new Error(`${path}.key: expected a media key`);
      if (line.t === "MEDIA_STORED" && typeof d.url !== "string") throw new Error(`${path}.url: expected a media URL`);
      stringField(d, "reason", path);
      break;
    // Other events do not create output paths or modify folded content.
  }
  return line as unknown as RawLine;
}

const fileOrder = (a: string, b: string) => Number(b === "guild.jsonl") - Number(a === "guild.jsonl") || (a < b ? -1 : a > b ? 1 : 0);

export function readRawArchive(archive: string, options: RawOptions = {}): RawArchive {
  const limits = { ...DEFAULT_RAW_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key}: expected a positive integer`);
  }
  const root = join(realpathSync(archive), "raw");
  const files: string[] = [];
  let entries = 0;
  let totalBytes = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new Error(`raw directory exceeds depth limit ${limits.maxDepth}`);
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`raw input directory must be a real directory: ${dir}`);
    for (const name of readdirSync(dir).sort(fileOrder)) {
      if (++entries > limits.maxFiles) throw new Error(`raw input exceeds entry limit ${limits.maxFiles}`);
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`raw input contains a symbolic link: ${file}`);
      if (stat.isDirectory()) visit(file, depth + 1);
      else if (name.endsWith(".jsonl")) {
        if (!stat.isFile()) throw new Error(`raw input must be a regular file: ${file}`);
        totalBytes += stat.size;
        if (totalBytes > limits.maxBytes) throw new Error(`raw input exceeds byte limit ${limits.maxBytes}`);
        files.push(file);
      }
    }
  };
  visit(root, 0);

  const result: RawArchive = { lines: [], digest: "", bytes: 0, skipped: 0, diagnostics: [] };
  const hash = createHash("sha256");
  let records = 0;
  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/");
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) throw new Error(`raw input must be a regular file: ${file}`);
      hash.update(`${Buffer.byteLength(rel)}:${rel}:${before.size}:`);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const chunk = Buffer.alloc(64 * 1024);
      let pending = "";
      let number = 0;
      const consume = (text: string): void => {
        number++;
        if (Buffer.byteLength(text) > limits.maxLineBytes) throw new Error(`${rel}:${number}: line exceeds byte limit ${limits.maxLineBytes}`);
        if (!text.trim()) return;
        if (++records > limits.maxRecords) throw new Error(`raw input exceeds record limit ${limits.maxRecords}`);
        try {
          result.lines.push(parseRawLine(JSON.parse(text)));
        } catch (error) {
          const diagnostic = `${rel}:${number}: ${error instanceof Error ? error.message : String(error)}`;
          if (!options.skipBadLines) throw new Error(diagnostic);
          result.skipped++;
          if (result.diagnostics.length < 100) result.diagnostics.push(diagnostic);
        }
      };
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, null);
        if (!read) break;
        result.bytes += read;
        if (result.bytes > limits.maxBytes) throw new Error(`raw input exceeds byte limit ${limits.maxBytes}`);
        hash.update(chunk.subarray(0, read));
        pending += decoder.decode(chunk.subarray(0, read), { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (Buffer.byteLength(pending) > limits.maxLineBytes) throw new Error(`${rel}:${number + 1}: line exceeds byte limit ${limits.maxLineBytes}`);
      }
      pending += decoder.decode();
      if (pending) consume(pending);
      const after = fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`raw input changed during the build: ${rel}`);
    } finally {
      closeSync(fd);
    }
  }
  result.digest = hash.digest("hex");
  return result;
}

/** Compatibility helper for callers that only need the accepted records. Parsing is strict. */
export const readRaw = (archive: string, options?: RawOptions): RawLine[] => readRawArchive(archive, options).lines;
