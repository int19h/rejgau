// This contract describes generated files. Raw Discord records keep their source format.

export const MAX_PUBLICATION_FILE_BYTES = 32 * 1024 * 1024;

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

export interface Role {
  id: string;
  name: string;
  color?: number;
  colors?: { primary_color?: number };
  position: number;
}

export interface Emoji { id?: string | null; name?: string | null; animated?: boolean }
export interface Sticker { id: string; name?: string; format_type: number }
export interface MediaItem { url?: string; content_type?: string; width?: number | null; height?: number | null }
export interface Attachment extends MediaItem {
  id: string;
  filename?: string;
  description?: string;
  flags?: number;
  is_spoiler?: boolean;
}
export interface Embed {
  type?: string;
  url?: string;
  title?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  image?: MediaItem;
  thumbnail?: MediaItem;
  video?: MediaItem;
  provider?: { name?: string; url?: string };
  author?: { name?: string; url?: string };
  footer?: { text?: string };
  fields?: { name?: string; value?: string; inline?: boolean }[];
}
export interface Component {
  type: number;
  style?: number;
  label?: string;
  url?: string;
  emoji?: Emoji;
  placeholder?: string;
  content?: string;
  description?: string;
  name?: string;
  spoiler?: boolean;
  divider?: boolean;
  accent_color?: number | null;
  media?: MediaItem;
  file?: MediaItem;
  components?: Component[];
  accessory?: Component;
  items?: { media?: MediaItem; description?: string; spoiler?: boolean }[];
}
export interface Poll {
  question?: { text?: string; emoji?: Emoji };
  answers?: { answer_id: number; poll_media?: { text?: string; emoji?: Emoji } }[];
  allow_multiselect?: boolean;
  expiry?: string | null;
  results?: { is_finalized?: boolean; answer_counts?: { id: number; count: number }[] };
}
export interface MessageBody {
  content?: string;
  timestamp?: string;
  flags?: number;
  attachments?: Attachment[];
  embeds?: Embed[];
  components?: Component[];
  sticker_items?: Sticker[];
  poll?: Poll;
  message_snapshots?: { message?: MessageBody }[];
}
export interface Reaction { emoji: Emoji; count: number; burst?: boolean; users?: string[] }
export interface Vote { count: number; users?: string[] }
export interface MessageReference { message_id?: string; channel_id?: string; guild_id?: string; type?: number }
export type ReferencedMessage = { deleted: true } | {
  deleted?: false;
  id: string;
  channel_id?: string;
  author?: string;
  content: string;
  attachments?: boolean;
  embeds?: boolean;
};
export interface PublishedMessage extends MessageBody {
  id: string;
  ts: string;
  type: number;
  author?: string;
  content: string;
  edited_timestamp?: string;
  poll?: Poll;
  webhook_id?: string;
  application_id?: string;
  tts?: boolean;
  mention_everyone?: boolean;
  mention_roles?: string[];
  message_snapshots?: { message?: MessageBody }[];
  call?: Record<string, unknown>;
  role_subscription_data?: Record<string, unknown>;
  activity?: Record<string, unknown>;
  pinned?: boolean;
  mentions?: string[];
  reactions?: Reaction[];
  votes?: Record<string, Vote>;
  reference?: MessageReference;
  referenced?: ReferencedMessage;
  interaction?: { name: string | null; type?: number; command_type?: number; user?: string; user_installed?: boolean };
  thread?: { id: string; name?: string; count: number };
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
export interface Provenance {
  renderer_revision?: string;
  archive_revision?: string;
  archive_digest?: string;
  raw_bytes?: number;
  raw_records?: number;
  skipped_records?: number;
  incomplete?: boolean;
}
export interface Archive {
  format: 1;
  built_at: string;
  guild: { id: string; name: string; icon_url: string | null; roles: Role[]; emojis: Emoji[]; stickers: Sticker[] };
  channels: Record<string, ChannelInfo>;
  search_months: string[];
  generation?: string;
  data_root?: string;
  provenance?: Provenance;
}
export interface MonthFile {
  channel: string;
  month: string;
  media: Record<string, string | null>;
  users: Record<string, UserSnap>;
  messages: PublishedMessage[];
}
export interface UsersFile { users: Record<string, UserSnap>; media: Record<string, string | null> }
export interface SearchRow {
  id: string;
  c: string;
  ts: string;
  a?: string;
  text: string;
  x?: string;
  at: "user" | "bot" | "webhook";
  has?: string[];
  men?: string[];
  pin?: boolean;
}
export type PublicationFile = Archive | MonthFile | UsersFile | SearchRow[];

// Parsers reject malformed consumed fields and preserve unknown source extensions.
type Check = (value: unknown, path: string) => void;
function fail(path: string, expected: string): never { throw new Error(`Invalid publication data: ${path} must be ${expected}.`); }
const object = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "an object");
  return value as Record<string, unknown>;
};
const string: Check = (v, p) => { if (typeof v !== "string") fail(p, "a string"); };
const boolean: Check = (v, p) => { if (typeof v !== "boolean") fail(p, "a boolean"); };
const number: Check = (v, p) => { if (typeof v !== "number" || !Number.isFinite(v)) fail(p, "a finite number"); };
const integer: Check = (v, p) => { number(v, p); if (!Number.isSafeInteger(v) || (v as number) < 0) fail(p, "a nonnegative integer"); };
const match = (pattern: RegExp, description: string): Check => (v, p) => { string(v, p); if (!pattern.test(v as string)) fail(p, description); };
const id = match(/^\d{1,20}$/, "a Discord ID");
const month = match(/^\d{4}-(?:0[1-9]|1[0-2])$/, "a month in YYYY-MM form");
const hash = match(/^[a-f0-9]{64}$/, "a lowercase SHA256 digest");
const revision = match(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "a full Git revision");
const timestamp: Check = (v, p) => { string(v, p); if (!Number.isFinite(Date.parse(v as string))) fail(p, "a timestamp"); };
const nullable = (check: Check): Check => (v, p) => { if (v !== null) check(v, p); };
const array = (check: Check): Check => (v, p) => {
  if (!Array.isArray(v)) fail(p, "an array");
  (v as unknown[]).forEach((x, i) => check(x, `${p}[${i}]`));
};
const fields = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v, p) => {
  const o = object(v, p);
  for (const [key, check] of Object.entries(required)) check(o[key], `${p}.${key}`);
  for (const [key, check] of Object.entries(optional)) if (o[key] !== undefined) check(o[key], `${p}.${key}`);
};
const dictionary = (check: Check, keyCheck?: Check): Check => (v, p) => {
  for (const [key, item] of Object.entries(object(v, p))) {
    if (keyCheck) keyCheck(key, `${p} key`);
    check(item, `${p}[${JSON.stringify(key)}]`);
  }
};
const mediaMap = dictionary(nullable(string));
const user = fields({ id }, {
  username: string, global_name: nullable(string), avatar: nullable(string), bot: boolean, system: boolean,
  nick: nullable(string), member_asof: match(/^backfill$/, '"backfill"'), member_avatar: nullable(string),
  roles: array(id), tag: nullable(string), names: array(string),
});
const emoji = fields({}, { id: nullable(id), name: nullable(string), animated: boolean });
const sticker = fields({ id, format_type: integer }, { name: string });
const mediaItem = fields({}, { url: string, content_type: string, width: nullable(number), height: nullable(number) });
const attachment: Check = (v, p) => {
  mediaItem(v, p);
  fields({ id }, { filename: string, description: string, flags: integer, is_spoiler: boolean })(v, p);
};
const embed = fields({}, {
  type: string, url: string, title: string, description: string, color: integer, timestamp,
  image: mediaItem, thumbnail: mediaItem, video: mediaItem,
  provider: fields({}, { name: string, url: string }), author: fields({}, { name: string, url: string }),
  footer: fields({}, { text: string }), fields: array(fields({}, { name: string, value: string, inline: boolean })),
});
function component(v: unknown, p: string, depth = 0): void {
  if (depth > 64) fail(p, "a component tree with at most 64 levels");
  const child: Check = (x, q) => component(x, q, depth + 1);
  fields({ type: integer }, {
    style: integer, label: string, url: string, emoji, placeholder: string, content: string,
    description: string, name: string, spoiler: boolean, divider: boolean, accent_color: nullable(integer),
    media: mediaItem, file: mediaItem, components: array(child), accessory: child,
    items: array(fields({}, { media: mediaItem, description: string, spoiler: boolean })),
  })(v, p);
}
function body(v: unknown, p: string, depth = 0): void {
  if (depth > 64) fail(p, "a message body with at most 64 levels");
  fields({}, {
    content: string, timestamp, flags: integer, attachments: array(attachment), embeds: array(embed),
    components: array(component), sticker_items: array(sticker), poll,
    message_snapshots: array(fields({}, { message: (x, q) => body(x, q, depth + 1) })),
  })(v, p);
}
const pollMedia = fields({}, { text: string, emoji });
const poll = fields({}, {
  question: pollMedia, answers: array(fields({ answer_id: integer }, { poll_media: pollMedia })),
  allow_multiselect: boolean, expiry: nullable(timestamp),
  results: fields({}, { is_finalized: boolean, answer_counts: array(fields({ id: integer, count: integer })) }),
});
const reaction = fields({ emoji, count: integer }, { burst: boolean, users: array(id) });
const vote = fields({ count: integer }, { users: array(id) });
const reference = fields({}, { message_id: id, channel_id: id, guild_id: id, type: integer });
const referenced: Check = (v, p) => {
  const o = object(v, p);
  if (o.deleted === true) {
    if (Object.keys(o).some((k) => k !== "deleted")) fail(p, "a deletion marker without message content");
  } else fields({ id, content: string }, { deleted: (x, q) => { if (x !== false) fail(q, "false"); }, channel_id: id, author: string, attachments: boolean, embeds: boolean })(v, p);
};
const message: Check = (v, p) => {
  body(v, p);
  const o = object(v, p);
  if (o.deleted_at !== undefined || o.edits !== undefined) fail(p, "a current undeleted message");
  fields({ id, ts: timestamp, type: integer, content: string }, {
    author: string, edited_timestamp: timestamp, poll, webhook_id: id, application_id: id, tts: boolean,
    mention_everyone: boolean, mention_roles: array(id), message_snapshots: array(fields({}, { message: body })),
    call: object, role_subscription_data: object, activity: object, pinned: boolean, mentions: array(string),
    reactions: array(reaction), votes: dictionary(vote, match(/^\d+$/, "a poll answer ID")), reference, referenced,
    interaction: fields({ name: nullable(string) }, { type: integer, command_type: integer, user: string, user_installed: boolean }),
    thread: fields({ id, count: integer }, { name: string }),
  })(v, p);
};
const channel = fields({ id, type: integer, parent_id: nullable(id), position: number, months: dictionary(integer, month) }, {
  name: string, topic: string, nsfw: boolean, deleted: boolean, archived: boolean, created: nullable(timestamp),
});
const role = fields({ id, name: string, position: number }, { color: integer, colors: fields({}, { primary_color: integer }) });
const provenance: Check = (v, p) => {
  fields({}, { renderer_revision: revision, archive_revision: revision, archive_digest: hash, raw_bytes: integer, raw_records: integer, skipped_records: integer, incomplete: boolean })(v, p);
  const o = object(v, p);
  if ((o.incomplete === true) !== (typeof o.skipped_records === "number" && o.skipped_records > 0)) fail(p, "consistent skipped_records and incomplete values");
};

export function parseArchive(value: unknown): Archive {
  const o = object(value, "archive.json");
  fields({
    format: (v, p) => { if (v !== 1) fail(p, "supported format 1"); }, built_at: timestamp,
    guild: fields({ id: string, name: string, icon_url: nullable(string), roles: array(role), emojis: array(emoji), stickers: array(sticker) }),
    channels: dictionary(channel, id), search_months: array(month),
  }, { generation: hash, data_root: string, provenance })(o, "archive.json");
  if ((o.generation === undefined) !== (o.data_root === undefined) || (o.generation !== undefined && o.data_root !== `generations/${o.generation}/`)) fail("archive.json.data_root", "the path for its generation");
  const channels = object(o.channels, "archive.json.channels");
  for (const [key, item] of Object.entries(channels)) {
    const c = object(item, `archive.json.channels.${key}`);
    if (c.id !== key) fail(`archive.json.channels.${key}.id`, "the channel key");
    const seen = new Set<string>([key]);
    let parent = c.parent_id;
    while (parent !== null) {
      if (typeof parent !== "string" || !Object.hasOwn(channels, parent) || seen.has(parent)) fail(`archive.json.channels.${key}.parent_id`, "an existing ancestor without a cycle");
      seen.add(parent);
      parent = object(channels[parent], `archive.json.channels.${parent}`).parent_id;
    }
  }
  return o as unknown as Archive;
}

export function parseMonthFile(value: unknown): MonthFile {
  fields({ channel: id, month, media: mediaMap, users: dictionary(user), messages: array(message) })(value, "month file");
  const file = value as MonthFile;
  const seen = new Set<string>();
  for (const m of file.messages) {
    if (seen.has(m.id)) fail(`message ${m.id}`, "unique within its month");
    seen.add(m.id);
    const keys = [m.author, ...(m.mentions ?? []), m.interaction?.user, m.referenced && !m.referenced.deleted ? m.referenced.author : undefined];
    for (const key of keys) if (key !== undefined && !Object.hasOwn(file.users, key)) fail(`message ${m.id} user`, "a known snapshot key");
  }
  return file;
}

export function parseUsersFile(value: unknown): UsersFile {
  fields({ users: dictionary(user, id), media: mediaMap })(value, "users.json");
  const file = value as UsersFile;
  for (const [key, snap] of Object.entries(file.users)) if (key !== snap.id) fail(`users.json.users.${key}.id`, "the user key");
  return file;
}

export function parseSearchRows(value: unknown): SearchRow[] {
  array(fields({ id, c: id, ts: timestamp, text: string, at: match(/^(?:user|bot|webhook)$/, "an author type") }, {
    a: id, x: string, has: array(string), men: array(id), pin: boolean,
  }))(value, "search rows");
  return value as SearchRow[];
}

/** Makes sure that consumed body fields have supported shapes without changing source fields. */
export function parseMessageBody(value: unknown): MessageBody {
  body(value, "message body");
  return value as MessageBody;
}
