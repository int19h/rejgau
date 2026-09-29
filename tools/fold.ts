// Folds an archive's raw log lines into the current state of guild, channels and messages.
// Pure: no I/O. Used by tools/build.ts to generate the reader's data.

export interface RawLine {
  at: string;
  src: "gw" | "rest" | "rejgau";
  sid?: string;
  s?: number;
  t: string;
  d: any;
}

/**
 * A reaction (per emoji and burst/"super" kind) or a poll answer. The displayed count is
 * `baseline + known.size`: `known` are users seen reacting/voting live, `baseline` is whatever a
 * snapshot's count attributes to people we don't know.
 */
export interface Tally {
  baseline: number;
  known: Set<string>;
}

export interface ReactionState extends Tally {
  emoji: { id?: string | null; name?: string | null; animated?: boolean };
  burst: boolean;
}

export const tallyCount = (t: Tally) => t.baseline + t.known.size;

export interface MessageState {
  /** The latest version of the message object (sanitized Discord message). */
  m: any;
  channelId: string;
  /** Previous versions, oldest first, for messages edited while archived. */
  edits: { ts: string; edited_timestamp: string | null; content: string; embeds?: any[]; attachments?: any[]; components?: any[] }[];
  deletedAt?: string;
  reactions: Map<string, ReactionState>;
  /** Poll answer id → tally. */
  votes: Map<number, Tally>;
  pinned: boolean;
  /** Where the message came from first: live gateway or REST history. */
  src: "gw" | "rest";
}

export interface ChannelState {
  c: any;
  selected: boolean;
  deleted: boolean;
}

export interface MediaEntry {
  url?: string;
  type?: string;
  size?: number;
  error?: string;
}

export interface ArchiveState {
  guild: any;
  channels: Map<string, ChannelState>;
  messages: Map<string, MessageState>;
  /** user id → latest member snapshot from MEMBER_SNAPSHOT (null = left the server). */
  memberSnapshots: Map<string, any | null>;
  media: Map<string, MediaEntry>;
}

const reactionKey = (e: any, burst: boolean) => `${burst ? "b" : "n"}:${e?.id ? `c:${e.id}` : `u:${e?.name ?? ""}`}`;

/** Aligns a tally with a snapshot's count, keeping known users; only when the count differs. */
function rebase(t: Tally, count: number): void {
  if (tallyCount(t) !== count) t.baseline = Math.max(0, count - t.known.size);
}

function tallyAdd(t: Tally, user: string): void {
  t.known.add(user);
}

function tallyRemove(t: Tally, user: string): void {
  if (!t.known.delete(user)) t.baseline = Math.max(0, t.baseline - 1);
}

/** Orders lines by `at`, keeping file order for ties (a stable sort). */
export function orderLines(lines: RawLine[]): RawLine[] {
  return lines
    .map((l, i) => ({ l, i, t: Date.parse(l.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.l);
}

export function emptyState(): ArchiveState {
  return { guild: {}, channels: new Map(), messages: new Map(), memberSnapshots: new Map(), media: new Map() };
}

function upsertChannel(state: ArchiveState, c: any, selected?: boolean): void {
  if (!c?.id) return;
  const cur = state.channels.get(c.id);
  state.channels.set(c.id, {
    c: { ...(cur?.c ?? {}), ...c },
    selected: selected ?? cur?.selected ?? false,
    deleted: false,
  });
}

function setReactionsFrom(ms: MessageState, reactions: any[] | undefined): void {
  if (!Array.isArray(reactions)) return;
  const next = new Map<string, ReactionState>();
  for (const r of reactions) {
    // REST/UPDATE snapshots split counts into normal and burst ("super") reactions.
    const normal = r.count_details?.normal ?? (r.count ?? 0) - (r.burst_count ?? r.count_details?.burst ?? 0);
    const burst = r.count_details?.burst ?? r.burst_count ?? 0;
    for (const [isBurst, count] of [[false, normal], [true, burst]] as const) {
      if (count <= 0) continue;
      const key = reactionKey(r.emoji, isBurst);
      const cur = ms.reactions.get(key) ?? { emoji: r.emoji, burst: isBurst, baseline: 0, known: new Set<string>() };
      rebase(cur, count);
      next.set(key, cur);
    }
  }
  ms.reactions = next;
}

function setVotesFrom(ms: MessageState, poll: any): void {
  const counts = poll?.results?.answer_counts;
  if (!Array.isArray(counts)) return;
  const finalized = !!poll.results.is_finalized;
  for (const a of counts) {
    const cur = ms.votes.get(a.id) ?? { baseline: 0, known: new Set<string>() };
    if (finalized) cur.baseline = Math.max(0, (a.count ?? 0) - cur.known.size);
    else rebase(cur, a.count ?? 0);
    ms.votes.set(a.id, cur);
  }
}

/**
 * Applies a message snapshot (live CREATE/UPDATE or REST). Merges only keys present; a newer
 * `edited_timestamp` records the previous version as an edit; an older one marks a stale copy.
 */
function upsertMessage(state: ArchiveState, m: any, src: "gw" | "rest"): void {
  if (!m?.id || !m.channel_id) return;
  const cur = state.messages.get(m.id);
  if (!cur) {
    const ms: MessageState = { m, channelId: m.channel_id, edits: [], reactions: new Map(), votes: new Map(), pinned: !!m.pinned, src };
    setReactionsFrom(ms, m.reactions);
    setVotesFrom(ms, m.poll);
    state.messages.set(m.id, ms);
    return;
  }
  const prevEdited: string | null = cur.m.edited_timestamp ?? null;
  const nextEdited: string | null = m.edited_timestamp ?? null;
  if (prevEdited && (!nextEdited || Date.parse(nextEdited) < Date.parse(prevEdited))) {
    // Stale for content (older copy, e.g. a replay); still take reactions/poll/pin state.
    if (typeof m.pinned === "boolean") cur.pinned = m.pinned;
    if ("reactions" in m) setReactionsFrom(cur, m.reactions);
    if (m.poll) setVotesFrom(cur, m.poll);
    return;
  }
  if (nextEdited && nextEdited !== prevEdited) {
    cur.edits.push({
      ts: prevEdited ?? cur.m.timestamp,
      edited_timestamp: prevEdited,
      content: cur.m.content ?? "",
      ...(cur.m.embeds?.length ? { embeds: cur.m.embeds } : {}),
      ...(cur.m.attachments?.length ? { attachments: cur.m.attachments } : {}),
      ...(cur.m.components?.length ? { components: cur.m.components } : {}),
    });
  }
  const merged = { ...cur.m };
  for (const [k, v] of Object.entries(m)) if (v !== undefined) merged[k] = v;
  cur.m = merged;
  if (typeof m.pinned === "boolean") cur.pinned = m.pinned;
  if ("reactions" in m) setReactionsFrom(cur, m.reactions);
  if (m.poll) setVotesFrom(cur, m.poll);
}

export function applyLine(state: ArchiveState, line: RawLine): void {
  const d = line.d ?? {};
  switch (line.t) {
    case "GUILD_SNAPSHOT":
    case "GUILD_UPDATE":
      state.guild = { ...state.guild, ...d };
      return;
    case "GUILD_ROLE_CREATE":
    case "GUILD_ROLE_UPDATE": {
      const roles = (state.guild.roles ?? []).filter((r: any) => r.id !== d.role?.id);
      state.guild = { ...state.guild, roles: [...roles, d.role] };
      return;
    }
    case "GUILD_ROLE_DELETE":
      state.guild = { ...state.guild, roles: (state.guild.roles ?? []).filter((r: any) => r.id !== d.role_id) };
      return;
    case "GUILD_EMOJIS_UPDATE":
      state.guild = { ...state.guild, emojis: d.emojis ?? [] };
      return;
    case "GUILD_STICKERS_UPDATE":
      state.guild = { ...state.guild, stickers: d.stickers ?? [] };
      return;

    case "CHANNEL_SELECTED":
      for (const a of d.ancestors ?? []) upsertChannel(state, a);
      upsertChannel(state, d.channel, true);
      return;
    case "CHANNEL_UNSELECTED": {
      const cur = state.channels.get(d.id);
      if (cur) cur.selected = false;
      return;
    }
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE":
    case "THREAD_CREATE":
    case "THREAD_UPDATE":
      upsertChannel(state, d);
      return;
    case "CHANNEL_DELETE":
    case "THREAD_DELETE": {
      const cur = state.channels.get(d.id);
      if (cur) cur.deleted = true;
      return;
    }
    case "THREAD_LIST_SYNC":
      for (const th of d.threads ?? []) upsertChannel(state, th);
      return;

    case "MESSAGE_CREATE":
    case "MESSAGE_UPDATE":
      upsertMessage(state, d, line.src === "rest" ? "rest" : "gw");
      // A pin notice (type 6) references the message that got pinned.
      if (d.type === 6 && d.message_reference?.message_id) {
        const pinned = state.messages.get(d.message_reference.message_id);
        if (pinned) pinned.pinned = true;
      }
      return;
    case "MESSAGE_DELETE": {
      const ms = state.messages.get(d.id);
      if (ms && !ms.deletedAt) ms.deletedAt = line.at;
      return;
    }
    case "MESSAGE_DELETE_BULK":
      for (const id of d.ids ?? []) {
        const ms = state.messages.get(id);
        if (ms && !ms.deletedAt) ms.deletedAt = line.at;
      }
      return;

    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE": {
      const ms = state.messages.get(d.message_id);
      if (!ms) return;
      const burst = !!d.burst;
      const key = reactionKey(d.emoji, burst);
      const r = ms.reactions.get(key) ?? { emoji: d.emoji, burst, baseline: 0, known: new Set<string>() };
      if (line.t === "MESSAGE_REACTION_ADD") tallyAdd(r, d.user_id);
      else tallyRemove(r, d.user_id);
      if (tallyCount(r) === 0) ms.reactions.delete(key);
      else ms.reactions.set(key, r);
      return;
    }
    case "MESSAGE_REACTION_REMOVE_ALL": {
      const ms = state.messages.get(d.message_id);
      if (ms) ms.reactions.clear();
      return;
    }
    case "MESSAGE_REACTION_REMOVE_EMOJI": {
      const ms = state.messages.get(d.message_id);
      if (ms) {
        ms.reactions.delete(reactionKey(d.emoji, false));
        ms.reactions.delete(reactionKey(d.emoji, true));
      }
      return;
    }

    case "MESSAGE_POLL_VOTE_ADD":
    case "MESSAGE_POLL_VOTE_REMOVE": {
      const ms = state.messages.get(d.message_id);
      if (!ms) return;
      const v = ms.votes.get(d.answer_id) ?? { baseline: 0, known: new Set<string>() };
      if (line.t === "MESSAGE_POLL_VOTE_ADD") tallyAdd(v, d.user_id);
      else tallyRemove(v, d.user_id);
      ms.votes.set(d.answer_id, v);
      return;
    }

    case "MEMBER_SNAPSHOT":
      if (d.user_id) state.memberSnapshots.set(d.user_id, d.member ?? null);
      return;
    case "MEDIA_STORED":
      state.media.set(d.key, { url: d.url, type: d.content_type, size: d.size });
      return;
    case "MEDIA_FAILED":
      state.media.set(d.key, { error: d.reason ?? "failed" });
      return;
  }
}

export function fold(lines: RawLine[]): ArchiveState {
  const state = emptyState();
  const seen = new Set<string>();
  for (const line of orderLines(lines)) {
    // Replays after a crash can log the same Gateway dispatch twice.
    if (line.src === "gw" && line.sid !== undefined && line.s !== undefined) {
      const key = `${line.sid}:${line.s}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    applyLine(state, line);
  }
  return state;
}
