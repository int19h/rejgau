// Extraction of media references from Discord payloads.
//
// Every media item gets a deterministic key, which is also its release asset name. The key comes
// from Discord identity (attachment ID, emoji ID, avatar hash, …), so a Worker can stream the
// download into the upload without buffering it to compute a content hash.

import { fnv1a64 } from "./util";

export interface MediaRef {
  key: string;
  /** Where to download it from; null when it can't be fetched from Workers (recorded as an error). */
  url: string | null;
  /** For attachments: where to refresh an expired signed URL. */
  channelId?: string;
  messageId?: string;
}

const CDN = "https://cdn.discordapp.com";

/** Characters GitHub keeps in asset names; everything else becomes "_". */
export function sanitizeName(name: string, max = 100): string {
  // GitHub also rewrites leading and trailing dots, so avoid them to keep names predictable.
  const clean = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "").replace(/\.+$/, "");
  return (clean || "file").slice(-max).replace(/^\.+/, "");
}

function extOf(pathname: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(pathname);
  return m ? `.${m[1].toLowerCase()}` : "";
}

/** Keys and fetchable URLs for URLs that appear in messages (attachments, embeds, components). */
export function refForUrl(raw: string, ctx: { channelId?: string; messageId?: string } = {}): MediaRef | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const att = /^\/(?:ephemeral-)?attachments\/(\d+)\/(\d+)\/([^/]+)$/.exec(u.pathname);
  if (att && (u.hostname === "cdn.discordapp.com" || u.hostname === "media.discordapp.net")) {
    // media.discordapp.net is blocked for Workers; the same object is on the CDN.
    const url = `${CDN}${u.pathname}${u.search}`;
    let filename = att[3];
    try { filename = decodeURIComponent(filename); }
    catch { /* Keep malformed escapes encoded so one URL cannot stop an event. */ }
    return { key: `att-${att[2]}-${sanitizeName(filename)}`, url, ...ctx };
  }
  if (/^images-ext-\d+\.discordapp\.net$/.test(u.hostname)) {
    // Discord's external-image proxy (blocked for Workers). Its path embeds the original URL.
    const m = /^\/external\/[^/]+\/(?:%3F[^/]*\/)?(https?)\/(.+)$/.exec(u.pathname);
    return m ? refForUrl(`${m[1]}://${m[2]}${u.search}`) : null;
  }
  // Any other URL (embed images and thumbnails, external media in components): key by URL hash.
  return { key: `ext-${fnv1a64(raw)}${extOf(u.pathname)}`, url: raw };
}

export function emojiRef(id: string, animated: boolean): MediaRef {
  const ext = animated ? "gif" : "png";
  return { key: `emoji-${id}.${ext}`, url: `${CDN}/emojis/${id}.${ext}` };
}

export function avatarRef(userId: string, hash: string): MediaRef {
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return { key: `avatar-${userId}-${hash}.${ext}`, url: `${CDN}/avatars/${userId}/${hash}.${ext}?size=256` };
}

export function memberAvatarRef(guildId: string, userId: string, hash: string): MediaRef {
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return {
    key: `gavatar-${guildId}-${userId}-${hash}.${ext}`,
    url: `${CDN}/guilds/${guildId}/users/${userId}/avatars/${hash}.${ext}?size=256`,
  };
}

export function guildIconRef(guildId: string, hash: string): MediaRef {
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return { key: `guild-${guildId}-${hash}.${ext}`, url: `${CDN}/icons/${guildId}/${hash}.${ext}?size=256` };
}

export function stickerRef(id: string, formatType: number): MediaRef {
  switch (formatType) {
    case 1: // PNG
    case 2: // APNG
      return { key: `sticker-${id}.png`, url: `${CDN}/stickers/${id}.png` };
    case 3: // Lottie
      return { key: `sticker-${id}.json`, url: `${CDN}/stickers/${id}.json` };
    default: // 4 = GIF: only served from media.discordapp.net, which Workers can't reach.
      return { key: `sticker-${id}.gif`, url: null };
  }
}

const CUSTOM_EMOJI = /<(a?):[\w~]{1,32}:(\d{1,20})>/g;

export function emojiRefsInText(text: unknown): MediaRef[] {
  if (typeof text !== "string") return [];
  return [...text.matchAll(CUSTOM_EMOJI)].map((m) => emojiRef(m[2], m[1] === "a"));
}

/** Walks a Components (V1/V2) tree collecting media URLs and text with custom emoji. */
function fromComponents(node: unknown, out: MediaRef[], ctx: { channelId?: string; messageId?: string }): void {
  if (Array.isArray(node)) {
    for (const n of node) fromComponents(n, out, ctx);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const c = node as Record<string, any>;
  if (typeof c.content === "string") out.push(...emojiRefsInText(c.content));
  for (const media of [c.media, c.file]) {
    if (media && typeof media.url === "string") {
      const r = refForUrl(media.url, ctx);
      if (r) out.push(r);
    }
  }
  if (c.emoji?.id) out.push(emojiRef(c.emoji.id, !!c.emoji.animated));
  for (const key of ["components", "items", "accessory"]) {
    if (c[key] !== undefined) fromComponents(c[key], out, ctx);
  }
}

/** Media referenced by a message-shaped object (message, forwarded snapshot, referenced message). */
function fromMessageBody(m: Record<string, any>, out: MediaRef[], ctx: { channelId?: string; messageId?: string }): void {
  out.push(...emojiRefsInText(m.content));
  for (const a of m.attachments ?? []) {
    if (typeof a?.url === "string") {
      const r = refForUrl(a.url, ctx);
      if (r) out.push(r);
    }
  }
  for (const e of m.embeds ?? []) {
    for (const part of [e?.image, e?.thumbnail]) {
      if (typeof part?.url === "string") {
        const r = refForUrl(part.url);
        if (r) out.push(r);
      }
    }
    out.push(...emojiRefsInText(e?.description), ...emojiRefsInText(e?.title));
    for (const f of e?.fields ?? []) out.push(...emojiRefsInText(f?.value), ...emojiRefsInText(f?.name));
  }
  for (const s of m.sticker_items ?? m.stickers ?? []) {
    if (s?.id) out.push(stickerRef(s.id, s.format_type));
  }
  fromComponents(m.components, out, ctx);
  const poll = m.poll;
  if (poll) {
    out.push(...emojiRefsInText(poll.question?.text));
    for (const a of poll.answers ?? []) {
      const em = a?.poll_media?.emoji;
      if (em?.id) out.push(emojiRef(em.id, !!em.animated));
    }
  }
}

/** All media referenced by a MESSAGE_CREATE/MESSAGE_UPDATE payload or a REST message. */
export function mediaInMessage(msg: Record<string, any>, guildId: string): MediaRef[] {
  const out: MediaRef[] = [];
  const ctx = typeof msg.id === "string" && typeof msg.channel_id === "string" ? { channelId: msg.channel_id, messageId: msg.id } : {};
  fromMessageBody(msg, out, ctx);
  for (const snap of msg.message_snapshots ?? []) {
    if (snap?.message) fromMessageBody(snap.message, out, {});
  }
  for (const r of msg.reactions ?? []) {
    if (r?.emoji?.id) out.push(emojiRef(r.emoji.id, !!r.emoji.animated));
  }
  for (const user of [msg.author, msg.interaction_metadata?.user]) {
    if (user?.id && user.avatar) out.push(avatarRef(user.id, user.avatar));
  }
  if (msg.author?.id && msg.member?.avatar) out.push(memberAvatarRef(guildId, msg.author.id, msg.member.avatar));
  return dedupe(out);
}

export function dedupe(refs: MediaRef[]): MediaRef[] {
  const seen = new Map<string, MediaRef>();
  for (const r of refs) if (!seen.has(r.key)) seen.set(r.key, r);
  return [...seen.values()];
}
