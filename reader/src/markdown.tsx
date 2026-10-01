// Discord-flavoured markdown rendering to Preact (parsing is in mdparse.ts). Everything is rendered
// as escaped text or safe elements; the only raw HTML is highlight.js output for code blocks, which
// escapes its input.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import { emojiRef } from "../../src/media";
import { parseMarkdown, type MdNode } from "./mdparse";
import { safeUrl } from "./url";

for (const [name, lang] of Object.entries({ bash, c, cpp, css, diff, go, java, javascript, json, python, rust, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, lang);
}
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

export { parseMarkdown, type MdNode };

export interface MdContext {
  /** Resolves a user mention to a display name (and optional role colour). */
  user(id: string): { name: string; color?: string } | null;
  role(id: string): { name: string; color?: string } | null;
  channel(id: string): string | null;
  /** URL of an archived media item by key, or null. */
  media(key: string): string | null;
  /** Emoji-only messages render emoji larger. */
  jumbo?: boolean;
}

const TIME_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
  t: { timeStyle: "short" },
  T: { timeStyle: "medium" },
  d: { dateStyle: "short" },
  D: { dateStyle: "long" },
  f: { dateStyle: "long", timeStyle: "short" },
  F: { dateStyle: "full", timeStyle: "short" },
  s: { dateStyle: "short", timeStyle: "short" },
  S: { dateStyle: "short", timeStyle: "medium" },
};

export function formatRelative(date: Date, now = new Date()): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const s = (date.getTime() - now.getTime()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
  for (const [unit, secs] of units) if (Math.abs(s) >= secs || unit === "second") return rtf.format(Math.round(s / secs), unit);
  return "";
}

function Spoiler({ children }: { children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  return (
    <span class={open ? "spoiler open" : "spoiler"} onClick={() => setOpen(true)} role="button" aria-label={open ? undefined : "spoiler"}>
      {children}
    </span>
  );
}

function CodeBlock({ lang, content }: { lang?: string; content: string }) {
  const known = lang && hljs.getLanguage(lang);
  if (!known) return <pre class="codeblock"><code>{content}</code></pre>;
  const html = hljs.highlight(content, { language: lang!, ignoreIllegals: true }).value;
  return <pre class="codeblock"><code class="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

function Emoji({ id, name, animated, ctx }: { id: string; name: string; animated?: boolean; ctx: MdContext }) {
  const [failed, setFailed] = useState(false);
  const url = ctx.media(emojiRef(id, !!animated).key);
  if (!url || failed) return <span class="emoji-text">:{name}:</span>;
  return <img class={ctx.jumbo ? "emoji jumbo" : "emoji"} src={url} alt={`:${name}:`} title={`:${name}:`} draggable={false} onError={() => setFailed(true)} />;
}

function Link({ href, children }: { href: unknown; children: ComponentChildren }) {
  const url = safeUrl(href);
  if (!url) return <>{children}</>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" title={url}>
      {children}
    </a>
  );
}

/** Groups consecutive list items into nested lists. */
function renderList(items: MdNode[], ctx: MdContext, key: number): JSX.Element {
  const Tag = items[0].ordered ? "ol" : "ul";
  const out: JSX.Element[] = [];
  let i = 0;
  const base = items[0].indent;
  while (i < items.length) {
    const it = items[i];
    const children: MdNode[] = [];
    let j = i + 1;
    while (j < items.length && items[j].indent > base) children.push(items[j++]);
    out.push(
      <li key={i}>
        {renderNodes(it.content, ctx)}
        {children.length ? renderList(children, ctx, 0) : null}
      </li>,
    );
    i = j;
  }
  return (
    <Tag key={key} class="md-list" start={Tag === "ol" ? items[0].start : undefined}>
      {out}
    </Tag>
  );
}

export function renderNodes(nodes: MdNode[] | undefined, ctx: MdContext): ComponentChildren {
  if (!nodes) return null;
  const out: ComponentChildren[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === "listItem") {
      const items: MdNode[] = [];
      // A run of items; a top-level item of the other kind (ordered vs not) starts a new list.
      while (i < nodes.length && (nodes[i].type === "listItem" || (nodes[i].type === "br" && nodes[i + 1]?.type === "listItem"))) {
        const it = nodes[i];
        if (it.type === "listItem") {
          if (items.length && it.indent === 0 && it.ordered !== items[0].ordered) break;
          items.push(it);
        }
        i++;
      }
      i--;
      out.push(renderList(items, ctx, i));
      continue;
    }
    out.push(renderNode(n, ctx, i));
  }
  return out;
}

function renderNode(n: MdNode, ctx: MdContext, key: number): ComponentChildren {
  const kids = () => renderNodes(n.content, ctx);
  switch (n.type) {
    case "text":
    case "emoticon":
      return typeof n.content === "string" ? n.content : kids();
    case "br":
    case "newline":
      return <br key={key} />;
    case "strong":
      return <strong key={key}>{kids()}</strong>;
    case "em":
      return <em key={key}>{kids()}</em>;
    case "underline":
      return <u key={key}>{kids()}</u>;
    case "strikethrough":
      return <s key={key}>{kids()}</s>;
    case "inlineCode":
      return <code key={key} class="inline">{n.content}</code>;
    case "codeBlock":
      return <CodeBlock key={key} lang={n.lang} content={n.content} />;
    case "blockQuote":
      return <blockquote key={key}>{kids()}</blockquote>;
    case "spoiler":
      return <Spoiler key={key}>{kids()}</Spoiler>;
    case "heading": {
      const H = (["h1", "h2", "h3"] as const)[Math.min(3, Math.max(1, n.level)) - 1];
      return <H key={key} class="md-heading">{kids()}</H>;
    }
    case "subtext":
      return <small key={key} class="subtext">{kids()}</small>;
    case "link":
      return <Link key={key} href={n.target}>{kids()}</Link>;
    case "url":
    case "autolink":
      return <Link key={key} href={n.target}>{kids()}</Link>;
    case "user": {
      const u = ctx.user(n.id);
      return <span key={key} class="mention" style={u?.color ? { color: u.color } : undefined}>@{u?.name ?? "unknown-user"}</span>;
    }
    case "role": {
      const r = ctx.role(n.id);
      return <span key={key} class="mention" style={r?.color ? { color: r.color, background: `${r.color}22` } : undefined}>@{r?.name ?? "unknown-role"}</span>;
    }
    case "channel":
      return <span key={key} class="mention">#{ctx.channel(n.id) ?? "unknown"}</span>;
    case "everyone":
      return <span key={key} class="mention">@everyone</span>;
    case "here":
      return <span key={key} class="mention">@here</span>;
    case "emoji":
      return <Emoji key={key} id={n.id} name={n.name} animated={n.animated} ctx={ctx} />;
    case "twemoji":
      return <span key={key} class={ctx.jumbo ? "uemoji jumbo" : "uemoji"}>{n.name}</span>;
    case "timestamp": {
      const date = new Date(Number(n.timestamp) * 1000);
      if (Number.isNaN(date.getTime())) return String(n.timestamp);
      const text = n.format === "R" ? formatRelative(date) : new Intl.DateTimeFormat(undefined, TIME_STYLES[n.format] ?? TIME_STYLES.f).format(date);
      return <time key={key} class="timestamp" dateTime={date.toISOString()} title={date.toLocaleString()}>{text}</time>;
    }
    case "slashCommand":
      return <span key={key} class="mention">/{n.fullName ?? n.name}</span>;
    case "guildNavigation":
      return <span key={key} class="mention">{n.id}</span>;
    default:
      return typeof n.content === "string" ? n.content : Array.isArray(n.content) ? kids() : null;
  }
}

/** Whether content is only emoji (custom or Unicode) and whitespace, up to 30, like Discord's jumbo rule. */
export function isEmojiOnly(nodes: MdNode[]): boolean {
  let count = 0;
  for (const n of nodes) {
    if (n.type === "emoji" || n.type === "twemoji") count++;
    else if (n.type === "text" && /^\s*$/.test(n.content)) continue;
    else if (n.type === "br") continue;
    else return false;
  }
  return count > 0 && count <= 30;
}

export function Markdown({ text, ctx }: { text: string; ctx: MdContext }) {
  const nodes = parseMarkdown(text);
  const jumbo = isEmojiOnly(nodes);
  return <div class="md">{renderNodes(nodes, jumbo ? { ...ctx, jumbo } : ctx)}</div>;
}
