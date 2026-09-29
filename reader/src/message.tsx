// Rendering of one archived message: header, content, attachments, embeds, components, polls,
// stickers, reactions, replies, forwards, app-command headers, edits and deletion.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { avatarRef, emojiRef, memberAvatarRef, refForUrl, stickerRef } from "../../src/media";
import { displayName, hexColor, monthOfId, roleColor, type Archive, type MonthFile, type UserSnap, type UsersFile } from "./data";
import { Markdown, type MdContext } from "./markdown";
import { safeUrl } from "./url";

export interface MsgEnv {
  archive: Archive;
  file: MonthFile;
  users: UsersFile | null;
  channelId: string;
}

const media = (env: MsgEnv, key: string | undefined) => (key ? env.file.media[key] ?? env.users?.media[key] ?? null : null);

function mdContext(env: MsgEnv, msg: any): MdContext {
  const roles = env.archive.guild.roles;
  const mentionSnaps = new Map<string, UserSnap>();
  for (const k of msg.mentions ?? []) {
    const u = env.file.users[k];
    if (u) mentionSnaps.set(u.id, u);
  }
  return {
    user(id) {
      const u = mentionSnaps.get(id) ?? env.users?.users[id];
      return u ? { name: displayName(u), color: roleColor(u.roles, roles) } : null;
    },
    role(id) {
      const r = roles.find((x) => x.id === id);
      return r ? { name: r.name, color: hexColor(r.colors?.primary_color ?? r.color) } : null;
    },
    channel(id) {
      return env.archive.channels[id]?.name ?? null;
    },
    media(key) {
      return media(env, key);
    },
  };
}

export function Avatar({ user, env, guildId, small }: { user: UserSnap | undefined; env: MsgEnv; guildId: string; small?: boolean }) {
  let url: string | null = null;
  if (user?.member_avatar) url = media(env, memberAvatarRef(guildId, user.id, user.member_avatar).key);
  if (!url && user?.avatar) url = media(env, avatarRef(user.id, user.avatar).key);
  const cls = small ? "avatar small" : "avatar";
  const [failed, setFailed] = useState(false);
  if (url && !failed) return <img class={cls} src={url} alt="" loading="lazy" onError={() => setFailed(true)} />;
  // A local placeholder: never hotlink Discord's default avatars.
  const name = displayName(user);
  const hue = user ? Number(BigInt(user.id) % 360n) : 0;
  return (
    <span class={`${cls} placeholder`} style={{ background: `hsl(${hue} 45% 45%)` }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Name({ user, env }: { user: UserSnap | undefined; env: MsgEnv }) {
  const color = roleColor(user?.roles, env.archive.guild.roles);
  const title = [user?.username && `@${user.username}`, user?.member_asof === "backfill" ? "nickname and roles as of the archive's backfill" : null].filter(Boolean).join(" · ");
  return (
    <span class="name" style={color ? { color } : undefined} title={title || undefined}>
      {displayName(user)}
    </span>
  );
}

function Time({ iso, withDate }: { iso: string; withDate?: boolean }) {
  const d = new Date(iso);
  const text = withDate
    ? d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <time dateTime={iso} title={d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" })}>
      {text}
    </time>
  );
}

function isSpoilerAttachment(a: any): boolean {
  return !!(a.flags & 8) || !!a.is_spoiler || String(a.filename ?? "").startsWith("SPOILER_");
}

function Blur({ spoiler, children }: { spoiler: boolean; children: ComponentChildren }) {
  const [open, setOpen] = useState(!spoiler);
  if (open) return <>{children}</>;
  return (
    <div class="blur" onClick={() => setOpen(true)} role="button">
      <div class="blur-inner">{children}</div>
      <span class="blur-label">SPOILER</span>
    </div>
  );
}

function MediaItem({ url, type, name, env, width, height, alt, spoiler }: { url?: string; type?: string; name?: string; env: MsgEnv; width?: number; height?: number; alt?: string; spoiler?: boolean }) {
  const [failed, setFailed] = useState(false);
  const ref = url ? refForUrl(url) : null;
  const archived = ref ? media(env, ref.key) : null;
  const ct = String(type ?? "");
  const isImage = ct.startsWith("image/") || (!ct && /\.(png|jpe?g|gif|webp|avif)$/i.test(name ?? ref?.key ?? ""));
  if (!archived) {
    return (
      <div class="file missing">
        <span class="file-name">{name ?? "media"}</span> <span class="muted">(not archived)</span>
      </div>
    );
  }
  let el: ComponentChildren;
  if (failed) {
    // e.g. a private repo's release asset: the browser can't load it, but a signed-in viewer can open it.
    el = (
      <a class="file" href={archived} target="_blank" rel="noopener noreferrer">
        <span class="file-name">{name ?? alt ?? "media"}</span> <span class="muted small">(open)</span>
      </a>
    );
  } else if (isImage) el = <img class="media" src={archived} alt={alt ?? name ?? ""} loading="lazy" width={width} height={height} onError={() => setFailed(true)} />;
  else if (ct.startsWith("video/")) el = <video class="media" src={archived} controls preload="metadata" />;
  else if (ct.startsWith("audio/")) el = <audio src={archived} controls preload="metadata" />;
  else
    el = (
      <a class="file" href={archived} target="_blank" rel="noopener noreferrer">
        <span class="file-name">{name ?? "file"}</span>
      </a>
    );
  return <Blur spoiler={!!spoiler}>{el}</Blur>;
}

function Attachments({ list, env }: { list: any[]; env: MsgEnv }) {
  return (
    <div class="attachments">
      {list.map((a) => (
        <MediaItem key={a.id} url={a.url} type={a.content_type} name={a.filename} width={a.width} height={a.height} alt={a.description} env={env} spoiler={isSpoilerAttachment(a)} />
      ))}
    </div>
  );
}

function Embed({ e, env, ctx }: { e: any; env: MsgEnv; ctx: MdContext }) {
  const imageOnly = (e.type === "image" || e.type === "gifv") && (e.thumbnail || e.image);
  if (imageOnly) {
    const img = e.image ?? e.thumbnail;
    return <MediaItem url={img.url} type={img.content_type ?? "image/"} name={safeUrl(e.url) ?? undefined} env={env} width={img.width} height={img.height} />;
  }
  const color = hexColor(e.color);
  const url = safeUrl(e.url);
  return (
    <div class="embed" style={color ? { borderLeftColor: color } : undefined}>
      <div class="embed-body">
        {e.provider?.name && <div class="embed-provider">{e.provider.name}</div>}
        {e.author?.name && (
          <div class="embed-author">{safeUrl(e.author.url) ? <a href={safeUrl(e.author.url)!} target="_blank" rel="noopener noreferrer">{e.author.name}</a> : e.author.name}</div>
        )}
        {e.title && <div class="embed-title">{url ? <a href={url} target="_blank" rel="noopener noreferrer">{e.title}</a> : e.title}</div>}
        {e.description && <Markdown text={e.description} ctx={ctx} />}
        {e.fields?.length > 0 && (
          <div class="embed-fields">
            {e.fields.map((f: any, i: number) => (
              <div key={i} class={f.inline ? "embed-field inline" : "embed-field"}>
                <div class="embed-field-name"><Markdown text={f.name ?? ""} ctx={ctx} /></div>
                <div class="embed-field-value"><Markdown text={f.value ?? ""} ctx={ctx} /></div>
              </div>
            ))}
          </div>
        )}
        {e.image?.url && <MediaItem url={e.image.url} type={e.image.content_type ?? "image/"} env={env} width={e.image.width} height={e.image.height} />}
        {e.video?.url && !e.image && e.thumbnail?.url && <MediaItem url={e.thumbnail.url} type="image/" env={env} />}
        {(e.footer?.text || e.timestamp) && (
          <div class="embed-footer">
            {e.footer?.text}
            {e.footer?.text && e.timestamp ? " • " : ""}
            {e.timestamp && <Time iso={e.timestamp} withDate />}
          </div>
        )}
      </div>
      {e.thumbnail?.url && !e.video && <div class="embed-thumb"><MediaItem url={e.thumbnail.url} type="image/" env={env} /></div>}
    </div>
  );
}

const BUTTON_STYLES = ["", "primary", "secondary", "success", "danger", "link", "premium"];

function ComponentEmoji({ emoji, ctx }: { emoji: any; ctx: MdContext }) {
  if (!emoji) return null;
  if (emoji.id) {
    const url = ctx.media(emojiRef(emoji.id, !!emoji.animated).key);
    return url ? <img class="emoji" src={url} alt={`:${emoji.name}:`} /> : <span>:{emoji.name}:</span>;
  }
  return <span>{emoji.name}</span>;
}

function Component({ c, env, ctx }: { c: any; env: MsgEnv; ctx: MdContext }): any {
  const kids = (list: any[] | undefined) => (list ?? []).map((x, i) => <Component key={i} c={x} env={env} ctx={ctx} />);
  switch (c.type) {
    case 1:
      return <div class="action-row">{kids(c.components)}</div>;
    case 2: {
      const href = c.style === 5 ? safeUrl(c.url) : null;
      const body = (
        <>
          <ComponentEmoji emoji={c.emoji} ctx={ctx} />
          {c.label && <span>{c.label}</span>}
        </>
      );
      return href ? (
        <a class={`button ${BUTTON_STYLES[c.style] ?? ""}`} href={href} target="_blank" rel="noopener noreferrer">{body}</a>
      ) : (
        <button class={`button ${BUTTON_STYLES[c.style] ?? ""}`} disabled>{body}</button>
      );
    }
    case 3:
    case 5:
    case 6:
    case 7:
    case 8:
      return <div class="select" aria-disabled="true">{c.placeholder ?? "Make a selection"}</div>;
    case 9:
      return (
        <div class="section">
          <div class="section-body">{kids(c.components)}</div>
          {c.accessory && <div class="section-accessory"><Component c={c.accessory} env={env} ctx={ctx} /></div>}
        </div>
      );
    case 10:
      return <Markdown text={c.content ?? ""} ctx={ctx} />;
    case 11:
      return <MediaItem url={c.media?.url} type={c.media?.content_type ?? "image/"} alt={c.description} env={env} spoiler={!!c.spoiler} />;
    case 12:
      return (
        <div class="gallery">
          {(c.items ?? []).map((it: any, i: number) => (
            <MediaItem key={i} url={it.media?.url} type={it.media?.content_type} alt={it.description} env={env} spoiler={!!it.spoiler} width={it.media?.width} height={it.media?.height} />
          ))}
        </div>
      );
    case 13:
      return <MediaItem url={c.file?.url} type={c.file?.content_type} name={c.name} env={env} spoiler={!!c.spoiler} />;
    case 14:
      return <div class={c.divider === false ? "separator" : "separator divider"} />;
    case 17: {
      const color = hexColor(c.accent_color);
      return (
        <Blur spoiler={!!c.spoiler}>
          <div class="container" style={color ? { borderLeftColor: color } : undefined}>{kids(c.components)}</div>
        </Blur>
      );
    }
    default:
      return null;
  }
}

function Poll({ msg, ctx }: { msg: any; ctx: MdContext }) {
  const p = msg.poll;
  const counts: Record<string, number> = {};
  for (const a of p.results?.answer_counts ?? []) counts[a.id] = a.count;
  for (const [id, v] of Object.entries<any>(msg.votes ?? {})) counts[id] = v.count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const finalized = !!p.results?.is_finalized;
  return (
    <div class="poll">
      <div class="poll-question">{p.question?.text}</div>
      {(p.answers ?? []).map((a: any) => {
        const n = counts[a.answer_id] ?? 0;
        const pct = total ? Math.round((n / total) * 100) : 0;
        return (
          <div key={a.answer_id} class="poll-answer">
            <div class="poll-bar" style={{ width: `${pct}%` }} />
            <span class="poll-label">
              <ComponentEmoji emoji={a.poll_media?.emoji} ctx={ctx} /> {a.poll_media?.text}
            </span>
            <span class="poll-count">{n} ({pct}%)</span>
          </div>
        );
      })}
      <div class="muted small">
        {total} vote{total === 1 ? "" : "s"} · {finalized ? "Poll closed" : p.expiry ? <>ends <Time iso={p.expiry} withDate /></> : ""}
      </div>
    </div>
  );
}

function Stickers({ list, env }: { list: any[]; env: MsgEnv }) {
  return (
    <div class="stickers">
      {list.map((s) => {
        const ref = stickerRef(s.id, s.format_type);
        const url = s.format_type === 3 ? null : media(env, ref.key);
        return url ? <img key={s.id} class="sticker" src={url} alt={s.name} title={s.name} /> : <div key={s.id} class="sticker missing">{s.name}</div>;
      })}
    </div>
  );
}

function Reactions({ list, env, ctx }: { list: any[]; env: MsgEnv; ctx: MdContext }) {
  return (
    <div class="reactions">
      {list.map((r, i) => {
        const names = (r.users ?? []).map((id: string) => displayName(env.users?.users[id])).join(", ");
        return (
          <span key={i} class={r.burst ? "reaction burst" : "reaction"} title={names || undefined}>
            <ComponentEmoji emoji={r.emoji} ctx={ctx} /> {r.count}
          </span>
        );
      })}
    </div>
  );
}

function Body({ m, msg, env, ctx }: { m: any; msg: any; env: MsgEnv; ctx: MdContext }) {
  return (
    <>
      {m.content ? <Markdown text={m.content} ctx={ctx} /> : null}
      {m.components?.length > 0 && <div class="components">{m.components.map((c: any, i: number) => <Component key={i} c={c} env={env} ctx={ctx} />)}</div>}
      {m.attachments?.length > 0 && <Attachments list={m.attachments} env={env} />}
      {m.embeds?.map((e: any, i: number) => <Embed key={i} e={e} env={env} ctx={ctx} />)}
      {m.sticker_items?.length > 0 && <Stickers list={m.sticker_items} env={env} />}
      {msg.poll && m === msg && <Poll msg={msg} ctx={ctx} />}
    </>
  );
}

const SYSTEM_TEXT: Record<number, string> = {
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
const NORMAL_TYPES = new Set([0, 19, 20, 21, 23]);

export function Message({ msg, env, grouped, highlighted }: { msg: any; env: MsgEnv; grouped: boolean; highlighted: boolean }) {
  const [showEdits, setShowEdits] = useState(false);
  const ctx = mdContext(env, msg);
  const author = msg.author ? env.file.users[msg.author] : undefined;
  const guildId = env.archive.guild.id;
  const cls = ["message", grouped ? "grouped" : "", msg.deleted_at ? "deleted" : "", highlighted ? "highlight" : ""].filter(Boolean).join(" ");
  const anchor = `#/c/${env.channelId}/${monthOfId(msg.id)}/${msg.id}`;

  if (!NORMAL_TYPES.has(msg.type)) {
    return (
      <div id={`m${msg.id}`} class={`${cls} system`}>
        <span class="system-icon">→</span>
        <Name user={author} env={env} /> {SYSTEM_TEXT[msg.type] ?? "system message"}
        {msg.type === 18 && msg.content ? <strong> {msg.content}</strong> : null}{" "}
        <a class="muted small" href={anchor}><Time iso={msg.ts} withDate /></a>
      </div>
    );
  }

  const referenced = msg.referenced;
  const refUser = referenced?.author ? env.file.users[referenced.author] : undefined;
  const inter = msg.interaction;
  const interUser = inter?.user ? env.file.users[inter.user] : undefined;
  const forwards = msg.message_snapshots ?? [];

  return (
    <div id={`m${msg.id}`} class={cls}>
      {referenced && (
        <a class="reply" href={referenced.channel_id ? `#/c/${referenced.channel_id}/${monthOfId(referenced.id)}/${referenced.id}` : undefined}>
          <span class="reply-spine" />
          <Avatar user={refUser} env={env} guildId={guildId} small />
          <Name user={refUser} env={env} />
          <span class="reply-text">{referenced.content || (referenced.attachments ? "Click to see attachment" : referenced.embeds ? "Click to see embed" : "")}</span>
        </a>
      )}
      {inter && (
        <div class="reply">
          <span class="reply-spine" />
          <Avatar user={interUser} env={env} guildId={guildId} small />
          <Name user={interUser} env={env} /> <span class="muted">used</span> <span class="command">{inter.name ? `/${inter.name}` : "a command"}</span>
          {inter.user_installed && <span class="muted small"> (user app)</span>}
        </div>
      )}
      <div class="message-row">
        <div class="gutter">
          {grouped ? (
            <a class="hover-time" href={anchor}><Time iso={msg.ts} /></a>
          ) : (
            <Avatar user={author} env={env} guildId={guildId} />
          )}
        </div>
        <div class="message-main">
          {!grouped && (
            <div class="message-header">
              <Name user={author} env={env} />
              {author?.tag && <span class="tag-badge">{author.tag}</span>}
              {(author?.bot || msg.webhook_id) && <span class="bot-tag">{msg.webhook_id && !msg.application_id ? "WEBHOOK" : "APP"}</span>}
              <a class="muted small" href={anchor}><Time iso={msg.ts} withDate /></a>
              {msg.pinned && <span class="muted small" title="Pinned">📌</span>}
            </div>
          )}
          {msg.flags & 128 && !msg.content && !msg.components?.length && !msg.embeds?.length ? <div class="muted">{displayName(author)} is thinking…</div> : null}
          <Body m={msg} msg={msg} env={env} ctx={ctx} />
          {forwards.map((s: any, i: number) => (
            <div key={i} class="forward">
              <div class="muted small">↱ Forwarded</div>
              <Body m={s.message ?? {}} msg={msg} env={env} ctx={ctx} />
              {s.message?.timestamp && <div class="muted small"><Time iso={s.message.timestamp} withDate /></div>}
            </div>
          ))}
          {(msg.edited_timestamp || msg.deleted_at) && (
            <div class="meta">
              {msg.edited_timestamp && (
                <button class="linklike muted small" onClick={() => setShowEdits(!showEdits)} title={new Date(msg.edited_timestamp).toLocaleString()} disabled={!msg.edits?.length}>
                  (edited{msg.edits?.length ? `, ${msg.edits.length} earlier version${msg.edits.length > 1 ? "s" : ""}` : ""})
                </button>
              )}
              {msg.deleted_at && <span class="deleted-badge" title={`Deleted ${new Date(msg.deleted_at).toLocaleString()}`}>deleted</span>}
            </div>
          )}
          {showEdits && (
            <div class="edits">
              {msg.edits.map((e: any, i: number) => (
                <div key={i} class="edit">
                  <div class="muted small">Version from <Time iso={e.ts} withDate /></div>
                  <Body m={e} msg={{}} env={env} ctx={ctx} />
                </div>
              ))}
            </div>
          )}
          {msg.reactions?.length > 0 && <Reactions list={msg.reactions} env={env} ctx={ctx} />}
          {msg.thread && (
            <a class="thread-link" href={`#/c/${msg.thread.id}`}>
              🧵 {msg.thread.name ?? "Thread"} <span class="muted">· {msg.thread.count} message{msg.thread.count === 1 ? "" : "s"}</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Discord-style grouping: same author, within 7 minutes, same day, no reply/command header. */
export function isGrouped(prev: any | undefined, msg: any, file: MonthFile): boolean {
  if (!prev || !NORMAL_TYPES.has(prev.type) || !NORMAL_TYPES.has(msg.type)) return false;
  if (msg.referenced || msg.interaction || msg.type !== 0) return false;
  const a = file.users[prev.author]?.id;
  const b = file.users[msg.author]?.id;
  if (!a || a !== b) return false;
  const t0 = Date.parse(prev.ts);
  const t1 = Date.parse(msg.ts);
  if (t1 - t0 > 7 * 60_000) return false;
  return new Date(t0).toDateString() === new Date(t1).toDateString();
}
