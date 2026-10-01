// Pre-rendered, human-readable logs: folded archive state → GFM files (path → text), for a
// regenerated branch that GitHub renders and that reads well in a terminal pager. Pure: no I/O.
//
// Layout (all times UTC):
//   README.md                                server index: channels by category
//   <channel>/README.md                      channel index: days with messages, threads
//   <channel>/<YYYY>/<MM>/<DD>.md            one day of messages
//   <channel>/threads/<thread>/…             threads, laid out like channels
// Folder names are channel names (made path-safe); a clash gets the channel ID appended.

import { posix } from "node:path";
import { refForUrl, stickerRef } from "../src/media";
import { MESSAGE_CHANNEL_TYPES, NORMAL_TYPES, SYSTEM_TEXT, THREAD_TYPES } from "../reader/src/data";
import { tallyCount, type ArchiveState, type MessageState } from "./fold";
import { escapeLine, escapeText, inlineCode, link, linkUrl, paragraphs, quote, renderMarkdown, type GfmContext } from "./gfm";

const DISCORD_EPOCH = 1420070400000n;
const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
const byId = (a: MessageState, b: MessageState) => (BigInt(a.m.id) < BigInt(b.m.id) ? -1 : BigInt(a.m.id) > BigInt(b.m.id) ? 1 : 0);
const dayOf = (id: string) => new Date(snowflakeTime(id)).toISOString().slice(0, 10);
const validDate = (iso: unknown) => {
  const d = new Date(typeof iso === "string" || typeof iso === "number" ? iso : NaN);
  return Number.isNaN(d.getTime()) ? null : d;
};
const hhmm = (iso: unknown) => validDate(iso)?.toISOString().slice(11, 16) ?? "??:??";
const dateTime = (iso: unknown) => validDate(iso)?.toISOString().slice(0, 16).replace("T", " ") ?? "unknown time";
const dayPath = (day: string) => `${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}.md`;

function relLink(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(from), to) || posix.basename(to);
  return rel.split("/").map(encodeURIComponent).join("/");
}

/** A folder name for a channel: its name with path-unsafe characters replaced. */
function slug(name: string | undefined, id: string): string {
  const s = String(name ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|#%]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return s || id;
}

function sizeText(bytes: unknown): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const duration = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function displayName(user: any, member?: any): string {
  return member?.nick || user?.global_name || user?.username || "Unknown";
}

function channelLabel(c: any): string {
  const name = escapeLine(c?.name ?? c?.id ?? "unknown");
  if (c?.type === 2 || c?.type === 13) return `🔊 ${name}`;
  if (c?.type === 15 || c?.type === 16) return `💬 ${name}`;
  if (THREAD_TYPES.has(c?.type)) return `🧵 ${name}`;
  return `#${name}`;
}

interface Layout {
  /** channel id → folder (no trailing slash) */
  dir: Map<string, string>;
  /** channel id → its messages, oldest first */
  messages: Map<string, MessageState[]>;
  /** channel id → day → messages */
  days: Map<string, Map<string, MessageState[]>>;
  /** user id → latest display name seen, for mentions the message itself doesn't resolve */
  names: Map<string, string>;
}

function layout(state: ArchiveState): Layout {
  const messages = new Map<string, MessageState[]>();
  for (const ms of state.messages.values()) {
    if (!state.channels.get(ms.channelId)?.selected) continue;
    if (!messages.has(ms.channelId)) messages.set(ms.channelId, []);
    messages.get(ms.channelId)!.push(ms);
  }
  const days = new Map<string, Map<string, MessageState[]>>();
  for (const [id, list] of messages) {
    list.sort(byId);
    const byDay = new Map<string, MessageState[]>();
    for (const ms of list) {
      const d = dayOf(ms.m.id);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(ms);
    }
    days.set(id, byDay);
  }

  // Folders: top-level channels first, then threads inside their parent's folder.
  const dir = new Map<string, string>();
  const taken = new Set<string>();
  const assign = (id: string, parent: string) => {
    const c = state.channels.get(id)!.c;
    let name = posix.join(parent, slug(c.name, id));
    if (taken.has(name.toLowerCase())) name = `${name}-${id}`;
    taken.add(name.toLowerCase());
    dir.set(id, name);
  };
  // Channels with nothing archived (e.g. selected but unreadable) are left out.
  const hasThreads = (id: string) => [...messages.keys()].some((t) => state.channels.get(t)?.c.parent_id === id);
  const selected = [...state.channels].filter(([id, ch]) => ch.selected && MESSAGE_CHANNEL_TYPES.has(ch.c.type) && (messages.has(id) || hasThreads(id)));
  const sortKey = ([id, ch]: [string, { c: any }]) => [ch.c.position ?? 0, id] as const;
  const ordered = (list: typeof selected) => list.sort((a, b) => sortKey(a)[0] - sortKey(b)[0] || (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
  for (const [id] of ordered(selected.filter(([, ch]) => !THREAD_TYPES.has(ch.c.type)))) assign(id, "");
  for (const [id, ch] of ordered(selected.filter(([, ch]) => THREAD_TYPES.has(ch.c.type)))) {
    const parent = dir.get(ch.c.parent_id);
    assign(id, parent ? `${parent}/threads` : "threads");
  }
  const names = new Map<string, string>();
  for (const [id, r] of state.reactors) names.set(id, displayName(r.user, r.member));
  for (const ms of [...state.messages.values()].sort(byId)) {
    const m = ms.m;
    if (m.author?.id) names.set(m.author.id, displayName(m.author, m.member ?? state.memberSnapshots.get(m.author.id)));
    for (const u of m.mentions ?? []) if (u?.id) names.set(u.id, displayName(u, u.member));
  }
  return { dir, messages, days, names };
}

interface Env {
  state: ArchiveState;
  layout: Layout;
  /** Path of the file being written, for relative links. */
  file: string;
  guildId: string;
}

/** Where a message is rendered: file path plus anchor, if it's in the logs. */
function messageHref(env: Env, channelId: string | undefined, messageId: string | undefined): string | null {
  if (!channelId || !messageId) return null;
  const dir = env.layout.dir.get(channelId);
  if (!dir || !env.state.messages.has(messageId)) return null;
  return `${relLink(env.file, `${dir}/${dayPath(dayOf(messageId))}`)}#m${messageId}`;
}

function gfmContext(env: Env, m: any): GfmContext {
  const mentioned = new Map<string, string>();
  for (const u of m?.mentions ?? []) if (u?.id) mentioned.set(u.id, displayName(u, u.member));
  return {
    user: (id) => mentioned.get(id) ?? env.layout.names.get(id) ?? null,
    role: (id) => (env.state.guild.roles ?? []).find((r: any) => r.id === id)?.name ?? null,
    channel: (id) => {
      const c = env.state.channels.get(id)?.c;
      if (!c) return null;
      const dir = env.layout.dir.get(id);
      return { name: c.name ?? id, href: dir ? relLink(env.file, `${dir}/README.md`) : undefined };
    },
  };
}

/** The archived copy of a Discord media URL, or null. */
function archived(env: Env, url: unknown): string | null {
  if (typeof url !== "string") return null;
  const ref = refForUrl(url);
  return ref ? linkUrl(env.state.media.get(ref.key)?.url) : null;
}

function mediaLine(env: Env, item: { url?: string; name?: string; type?: string; size?: number; alt?: string; voice?: number }): string {
  const name = escapeLine(item.name ?? "file");
  const url = archived(env, item.url);
  const type = String(item.type ?? "");
  const isImage = type.startsWith("image/") || (!type && /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(item.url ?? ""));
  if (!url) return `${isImage ? "🖼" : "📎"} ${name} *(not archived)*`;
  if (isImage) return `![${escapeLine(item.alt ?? item.name ?? "")}](${url})`;
  const size = sizeText(item.size);
  const meta = size ? ` · ${size}` : "";
  if (item.voice !== undefined) return `🎤 [Voice message · ${duration(item.voice)}](${url})${meta}`;
  const icon = type.startsWith("video/") ? "🎞" : type.startsWith("audio/") ? "🔊" : "📎";
  return `${icon} [${name}](${url})${meta}`;
}

/** Escapes multi-line plain text, each line as the start of a GFM line. */
const escapeLines = (s: string) => s.split("\n").map((l) => escapeText(l, true)).join("\n");

const isSpoilerAttachment = (a: any) => !!(a.flags & 8) || !!a.is_spoiler || String(a.filename ?? "").startsWith("SPOILER_");

function emojiText(e: any): string {
  if (!e) return "";
  return e.id ? escapeText(`:${e.name ?? "emoji"}:`) : String(e.name ?? "");
}

interface Body {
  blocks: string[];
  spoiler: boolean;
}

function embed(env: Env, e: any, ctx: GfmContext, body: Body): string {
  if ((e.type === "image" || e.type === "gifv") && (e.image || e.thumbnail)) {
    const img = e.image ?? e.thumbnail;
    const url = archived(env, img.url);
    return url ? `![](${url})` : link(escapeLine(e.url ?? "image"), e.url);
  }
  const parts: string[] = [];
  if (e.provider?.name) parts.push(`<sub>${escapeLine(e.provider.name)}</sub>`);
  if (e.author?.name) parts.push(`**${link(escapeLine(e.author.name), e.author.url)}**`);
  if (e.title) parts.push(`**${link(escapeLine(e.title), e.url)}**`);
  const md = (text: string) => {
    const r = renderMarkdown(text, ctx);
    if (r.spoiler) body.spoiler = true;
    return r.md;
  };
  if (e.description) parts.push(md(e.description));
  for (const f of e.fields ?? []) parts.push(`**${escapeLine(f.name ?? "")}**\\\n${md(f.value ?? "") || " "}`);
  const image = e.image?.url ?? (e.video && e.thumbnail?.url);
  if (image) parts.push(archived(env, image) ? `![](${archived(env, image)})` : "🖼 *(image not archived)*");
  else if (e.thumbnail?.url && archived(env, e.thumbnail.url)) parts.push(`![](${archived(env, e.thumbnail.url)})`);
  const footer = [e.footer?.text ? escapeLine(e.footer.text) : "", e.timestamp ? `${dateTime(e.timestamp)} UTC` : ""].filter(Boolean).join(" · ");
  if (footer) parts.push(`<sub>${footer}</sub>`);
  return quote(parts.filter(Boolean).join("\n\n"));
}

function button(c: any): string {
  const label = [emojiText(c.emoji), escapeLine(c.label ?? "")].filter(Boolean).join(" ") || "button";
  const kbd = `<kbd>${label}</kbd>`;
  return c.style === 5 && linkUrl(c.url) ? `[${kbd}](${linkUrl(c.url)})` : kbd;
}

function component(env: Env, c: any, ctx: GfmContext, body: Body): string {
  const kids = (list: any[] | undefined) => (list ?? []).map((x) => component(env, x, ctx, body)).filter(Boolean).join("\n\n");
  switch (c.type) {
    case 1:
      return (c.components ?? []).map((x: any) => component(env, x, ctx, body)).join(" ");
    case 2:
      return button(c);
    case 3:
    case 5:
    case 6:
    case 7:
    case 8:
      return `<kbd>${escapeLine(c.placeholder ?? "Make a selection")} ▾</kbd>`;
    case 9:
      return [kids(c.components), c.accessory ? component(env, c.accessory, ctx, body) : ""].filter(Boolean).join("\n\n");
    case 10: {
      const r = renderMarkdown(c.content ?? "", ctx);
      if (r.spoiler) body.spoiler = true;
      return r.md;
    }
    case 11:
      if (c.spoiler) body.spoiler = true;
      return mediaLine(env, { url: c.media?.url, type: c.media?.content_type ?? "image/", alt: c.description, name: "thumbnail" });
    case 12:
      return (c.items ?? [])
        .map((it: any) => {
          if (it.spoiler) body.spoiler = true;
          return mediaLine(env, { url: it.media?.url, type: it.media?.content_type, alt: it.description, name: "media" });
        })
        .join(" ");
    case 13:
      if (c.spoiler) body.spoiler = true;
      return mediaLine(env, { url: c.file?.url, type: c.file?.content_type, name: c.name ?? "file", size: c.size });
    case 14:
      return c.divider === false ? "" : "---";
    case 17: {
      if (c.spoiler) body.spoiler = true;
      const inner = kids(c.components);
      return inner ? quote(inner) : "";
    }
    default:
      return "";
  }
}

function poll(msg: MessageState): string {
  const p = msg.m.poll;
  const counts = new Map<number, number>();
  for (const a of p.results?.answer_counts ?? []) counts.set(a.id, a.count ?? 0);
  for (const [id, v] of msg.votes) counts.set(id, tallyCount(v));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const lines = [`📊 **${escapeLine(p.question?.text ?? "Poll")}**`, ""];
  for (const a of p.answers ?? []) {
    const n = counts.get(a.answer_id) ?? 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    const label = [emojiText(a.poll_media?.emoji), escapeLine(a.poll_media?.text ?? "")].filter(Boolean).join(" ");
    lines.push(`- ${inlineCode(bar)} ${label} — ${p.allow_multiselect ? plural(n, "vote") : `${plural(n, "vote")} (${pct}%)`}`);
  }
  const status = p.results?.is_finalized ? "poll closed" : p.expiry ? `ends ${dateTime(p.expiry)} UTC` : "";
  lines.push("", `<sub>${[plural(total, "vote"), p.allow_multiselect ? "multiple answers allowed" : "", status].filter(Boolean).join(" · ")}</sub>`);
  return lines.join("\n");
}

/** Content, components, attachments, embeds, stickers (and the poll, for the message itself). */
function body(env: Env, m: any, ctx: GfmContext, ms?: MessageState): Body {
  const b: Body = { blocks: [], spoiler: false };
  if (m.content) {
    const r = renderMarkdown(m.content, ctx);
    if (r.spoiler) b.spoiler = true;
    if (r.md) b.blocks.push(r.md);
  }
  for (const c of m.components ?? []) {
    const md = component(env, c, ctx, b);
    if (md) b.blocks.push(md);
  }
  const atts = m.attachments ?? [];
  if (atts.length) {
    const voice = m.flags & 8192;
    b.blocks.push(
      atts
        .map((a: any) => {
          if (isSpoilerAttachment(a)) b.spoiler = true;
          return mediaLine(env, {
            url: a.url,
            name: a.filename,
            type: a.content_type,
            size: a.size,
            alt: a.description,
            ...(voice && a.duration_secs !== undefined ? { voice: a.duration_secs } : {}),
          });
        })
        .join("\n\n"),
    );
  }
  for (const e of m.embeds ?? []) b.blocks.push(embed(env, e, ctx, b));
  for (const s of m.sticker_items ?? []) {
    const url = s.format_type === 3 ? null : linkUrl(env.state.media.get(stickerRef(s.id, s.format_type).key)?.url);
    b.blocks.push(url ? `![sticker: ${escapeLine(s.name ?? "")}](${url})` : `*sticker: ${escapeLine(s.name ?? "")}*`);
  }
  if (ms && m.poll) b.blocks.push(poll(ms));
  return b;
}

function wrapSpoiler(b: Body, summary = "Spoiler"): string {
  const md = b.blocks.join("\n\n");
  return b.spoiler && md ? `<details><summary>${summary}</summary>\n\n${md}\n\n</details>` : md;
}

function authorName(env: Env, m: any): string {
  const fallback = !m.member && m.author?.id ? env.state.memberSnapshots.get(m.author.id) : undefined;
  return displayName(m.author, m.member ?? fallback);
}

function renderMessage(env: Env, ms: MessageState): string {
  const m = ms.m;
  const ctx = gfmContext(env, m);
  const anchor = `<a id="m${m.id}"></a>`;
  const ts = m.timestamp ?? new Date(snowflakeTime(m.id)).toISOString();
  const name = `**${escapeLine(authorName(env, m))}**`;
  const out: string[] = [];

  if (!NORMAL_TYPES.has(m.type ?? 0)) {
    let text = escapeText(SYSTEM_TEXT[m.type] ?? "sent a system message.");
    if (m.type === 18) {
      const thread = m.thread?.id ?? m.message_reference?.channel_id;
      const dir = thread ? env.layout.dir.get(thread) : undefined;
      const title = `**${escapeLine(m.content || "thread")}**`;
      text += ` ${dir ? `[${title}](${relLink(env.file, `${dir}/README.md`)})` : title}`;
    }
    if (m.type === 6) {
      const href = messageHref(env, m.message_reference?.channel_id, m.message_reference?.message_id);
      if (href) text = `pinned [a message](${href}) to this channel.`;
    }
    out.push(`→ ${name} ${text} · ${hhmm(ts)} ${anchor}`);
    if (ms.deletedAt) out.push(`<sub>🗑 deleted ${dateTime(ms.deletedAt)} UTC</sub>`);
    return out.join("\n\n");
  }

  const badges = [m.webhook_id && !m.application_id ? "`WEBHOOK`" : m.author?.bot ? "`APP`" : "", ms.pinned ? "📌" : ""].filter(Boolean).join(" ");
  out.push(`${name}${badges ? ` ${badges}` : ""} · ${hhmm(ts)} ${anchor}`);

  // Context under the header: what this replies to, which app command produced it.
  const context: string[] = [];
  const ref = m.referenced_message ?? (m.type === 21 && m.message_reference?.message_id ? env.state.messages.get(m.message_reference.message_id)?.m : undefined);
  if (ref?.id) {
    const snippet = String(ref.content ?? "").replace(/\s+/g, " ").slice(0, 100) || (ref.attachments?.length ? "attachment" : ref.embeds?.length ? "embed" : "message");
    const href = messageHref(env, ref.channel_id ?? m.channel_id, ref.id);
    context.push(`> ↪ replying to **${escapeLine(displayName(ref.author))}**: ${href ? `[${escapeLine(snippet)}](${href})` : escapeLine(snippet)}`);
  } else if (m.message_reference?.message_id && m.type === 19) {
    context.push("> ↪ replying to a deleted message");
  }
  const im = m.interaction_metadata ?? m.interaction;
  if (im) {
    const owners = m.interaction_metadata?.authorizing_integration_owners ?? {};
    const cmd = m.interaction_metadata?.name ?? m.interaction?.name;
    const userApp = owners["1"] && !owners["0"] ? " *(user app)*" : "";
    context.push(`> ⌘ **${escapeLine(displayName(im.user, m.interaction?.member))}** used ${cmd ? inlineCode(`/${cmd}`) : "a command"}${userApp}`);
  }
  if (context.length) out.push(context.join("\\\n"));

  if (m.flags & 128 && !m.content && !m.components?.length && !m.embeds?.length) out.push(`*${escapeLine(authorName(env, m))} is thinking…*`);
  const b = body(env, m, ctx, ms);
  const main = wrapSpoiler(b);
  if (main) out.push(main);

  for (const s of m.message_snapshots ?? []) {
    const fm = s.message ?? {};
    const fb = body(env, fm, gfmContext(env, fm));
    const inner = [`↱ *Forwarded*`, wrapSpoiler(fb), fm.timestamp ? `<sub>${dateTime(fm.timestamp)} UTC</sub>` : ""].filter(Boolean).join("\n\n");
    out.push(quote(inner));
  }

  const meta: string[] = [];
  if (m.edited_timestamp) meta.push(`edited ${dateTime(m.edited_timestamp)} UTC`);
  if (ms.deletedAt) meta.push(`🗑 deleted ${dateTime(ms.deletedAt)} UTC`);
  if (meta.length) out.push(`<sub>${meta.join(" · ")}</sub>`);
  if (ms.edits.length) {
    const versions = ms.edits.map((e) => {
      const eb = body(env, { ...e, flags: m.flags }, ctx);
      return [`*Version from ${dateTime(e.ts ?? ts)} UTC:*`, wrapSpoiler(eb) || "*(empty)*"].join("\n\n");
    });
    out.push(`<details><summary>${plural(ms.edits.length, "earlier version")}</summary>\n\n${versions.join("\n\n---\n\n")}\n\n</details>`);
  }

  if (ms.reactions.size) {
    out.push(
      [...ms.reactions.values()]
        .map((r) => `${emojiText(r.emoji)}${r.burst ? "✨" : ""} ${tallyCount(r)}`)
        .join(" · "),
    );
  }

  const threadId = m.thread?.id ?? (env.state.channels.has(m.id) && m.channel_id !== m.id ? m.id : undefined);
  const threadDir = threadId ? env.layout.dir.get(threadId) : undefined;
  if (threadId && threadDir) {
    const count = env.layout.messages.get(threadId)?.length ?? 0;
    const tname = env.state.channels.get(threadId)?.c.name ?? m.thread?.name ?? "Thread";
    out.push(`🧵 [${escapeLine(tname)}](${relLink(env.file, `${threadDir}/README.md`)}) · ${plural(count, "message")}`);
  }
  return out.join("\n\n");
}

function dayFile(env: Env, channelId: string, day: string, list: MessageState[], prev?: string, next?: string): string {
  const c = env.state.channels.get(channelId)!.c;
  const dir = env.layout.dir.get(channelId)!;
  const nav = [
    prev ? `[← ${prev}](${relLink(env.file, `${dir}/${dayPath(prev)}`)})` : "",
    `[${channelLabel(c)}](${relLink(env.file, `${dir}/README.md`)})`,
    next ? `[${next} →](${relLink(env.file, `${dir}/${dayPath(next)}`)})` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const parts = [`# ${channelLabel(c)} · ${day}`, `<sub>${escapeLine(env.state.guild.name ?? "")} · times are UTC</sub>`, nav, "---"];
  for (const ms of list) parts.push(renderMessage(env, ms));
  parts.push("---", nav);
  return `${parts.join("\n\n")}\n`;
}

function channelIndex(env: Env, channelId: string): string {
  const ch = env.state.channels.get(channelId)!;
  const c = ch.c;
  const dir = env.layout.dir.get(channelId)!;
  const parts = [`# ${channelLabel(c)}`];
  if (c.topic) parts.push(quote(paragraphs(escapeLines(c.topic))));
  const parentDir = THREAD_TYPES.has(c.type) ? env.layout.dir.get(c.parent_id) : undefined;
  const up = parentDir ? `${parentDir}/README.md` : "README.md";
  const upLabel = up === "README.md" ? escapeLine(env.state.guild.name ?? "Server") : channelLabel(env.state.channels.get(c.parent_id)?.c);
  parts.push(`<sub>[${upLabel}](${relLink(env.file, up)})${ch.deleted ? " · deleted channel" : ""} · times are UTC</sub>`);

  const threads = [...env.layout.dir.keys()].filter((id) => env.state.channels.get(id)?.c.parent_id === channelId && THREAD_TYPES.has(env.state.channels.get(id)!.c.type));
  if (threads.length) {
    parts.push("## Threads");
    parts.push(
      threads
        .map((id) => `- [${escapeLine(env.state.channels.get(id)!.c.name ?? id)}](${relLink(env.file, `${env.layout.dir.get(id)}/README.md`)}) · ${plural(env.layout.messages.get(id)?.length ?? 0, "message")}`)
        .join("\n"),
    );
  }

  const days = [...(env.layout.days.get(channelId)?.keys() ?? [])].sort();
  if (!days.length) parts.push("*No archived messages.*");
  else {
    parts.push("## Days");
    const byMonth = new Map<string, string[]>();
    for (const d of days) {
      const month = d.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month)!.push(`[${d.slice(8)}](${relLink(env.file, `${dir}/${dayPath(d)}`)}) (${env.layout.days.get(channelId)!.get(d)!.length})`);
    }
    for (const [month, links] of [...byMonth].reverse()) parts.push(`**${month}**: ${links.join(" · ")}`);
  }
  return `${parts.join("\n\n")}\n`;
}

function rootIndex(env: Env, builtAt: string): string {
  const g = env.state.guild;
  const parts = [`# ${escapeLine(g.name ?? "Archive")}`, `<sub>Rendered from the rejgau archive on ${dateTime(builtAt)} UTC. Times are UTC. The raw logs are on the \`archive\` branch.</sub>`];
  const top = [...env.layout.dir.keys()].filter((id) => !THREAD_TYPES.has(env.state.channels.get(id)!.c.type));
  const groups = new Map<string, string[]>();
  for (const id of top) {
    const c = env.state.channels.get(id)!.c;
    const cat = c.parent_id ? env.state.channels.get(c.parent_id)?.c : undefined;
    const key = cat?.name ?? "";
    if (!groups.has(key)) groups.set(key, []);
    const list = env.layout.messages.get(id) ?? [];
    const range = list.length ? ` · ${dayOf(list[0].m.id)} – ${dayOf(list[list.length - 1].m.id)}` : "";
    groups.get(key)!.push(`- [${channelLabel(c)}](${relLink(env.file, `${env.layout.dir.get(id)}/README.md`)}) · ${plural(list.length, "message")}${range}`);
  }
  for (const [cat, lines] of groups) {
    if (cat) parts.push(`## ${escapeLine(cat)}`);
    parts.push(lines.join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

/** Builds every log file: path → GFM text. */
export function buildLogs(state: ArchiveState, builtAt = new Date().toISOString()): Map<string, string> {
  const files = new Map<string, string>();
  const l = layout(state);
  const env = (file: string): Env => ({ state, layout: l, file, guildId: state.guild.id ?? "" });
  files.set("README.md", rootIndex(env("README.md"), builtAt));
  for (const [id, dir] of l.dir) {
    files.set(`${dir}/README.md`, channelIndex(env(`${dir}/README.md`), id));
    const days = [...(l.days.get(id)?.keys() ?? [])].sort();
    days.forEach((day, i) => {
      const path = `${dir}/${dayPath(day)}`;
      files.set(path, dayFile(env(path), id, day, l.days.get(id)!.get(day)!, days[i - 1], days[i + 1]));
    });
  }
  return files;
}
