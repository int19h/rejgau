// Discord markdown → GitHub-flavoured Markdown, for the pre-rendered logs (tools/logs.ts).
//
// Message text is parsed with the reader's Discord parser and re-emitted as GFM. Every piece of
// user text is escaped, so GitHub shows it literally: it can't inject HTML, tables, footnotes,
// headings or list items. HTML is only used where GFM has no syntax (<ins>, <sub>, <kbd>, <details>),
// and only around text that is itself escaped.

import { parseMarkdown, type MdNode } from "../reader/src/mdparse";
import { safeUrl } from "../reader/src/url";

export interface GfmContext {
  /** Display name for a user mention, or null if unknown. */
  user(id: string): string | null;
  role(id: string): string | null;
  /** Channel name, and a relative link to its log if it's archived. */
  channel(id: string): { name: string; href?: string } | null;
}

// --- escaping ---

/** Characters that are markup anywhere in a GFM line. `&` only matters before an entity. */
const INLINE_SPECIAL = /[\\`*_[\]<>|~]|&(?=#?\w+;)/g;
/** Constructs that are only markup at the start of a line: headings, lists, quotes, setext/hr lines. */
const LINE_START = /^([#+=-]|\d{1,9}(?=[.)]))/;

/** Escapes plain text for an inline position. `lineStart`: the text begins a GFM line. */
export function escapeText(s: string, lineStart = false): string {
  let out = s.replace(INLINE_SPECIAL, "\\$&");
  if (lineStart) {
    // Leading spaces would make an indented code block; keep the indent visible without that.
    out = out.replace(/^[ \t]+/, (ws) => " ".repeat(ws.length));
    const m = LINE_START.exec(out);
    if (m) out = /\d/.test(m[1]) ? `${m[1]}\\${out.slice(m[1].length)}` : `\\${out}`;
  }
  return out;
}

/** Escapes text that is shown as one line (names, titles, snippets): newlines become spaces. */
export const escapeLine = (s: string) => escapeText(String(s ?? "").replace(/\s*\n\s*/g, " "));

/** A URL for a link or image destination: only http(s), in angle brackets so no escaping applies. */
export function linkUrl(raw: unknown): string | null {
  const url = safeUrl(raw);
  return url ? `<${url.replace(/[<> ]/g, (c) => encodeURIComponent(c))}>` : null;
}

export function link(text: string, url: unknown): string {
  const dest = linkUrl(url);
  return dest ? `[${text}](${dest})` : text;
}

export function inlineCode(s: string): string {
  const text = s.replace(/\n/g, " ");
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || /^ .* $/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function codeBlock(content: string, lang?: string): string {
  const longest = Math.max(2, ...(content.match(/^`{3,}/gm) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const info = (lang ?? "").replace(/[^\w+#.-]/g, "");
  return `${fence}${info}\n${content.replace(/\n$/, "")}\n${fence}`;
}

/** Prefixes every line of some blocks with "> ". */
export function quote(md: string): string {
  return md
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

/**
 * Joins lines separated by Discord line breaks into paragraphs: consecutive non-empty lines get a
 * GFM hard break ("\" at the end), empty lines separate paragraphs.
 */
export function paragraphs(text: string): string {
  const lines = text.split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const next = lines[i + 1];
    out.push(next !== undefined && next.trim() ? `${line}\\` : line);
  }
  return out.join("\n");
}

// --- rendering ---

const BLOCK_TYPES = new Set(["codeBlock", "blockQuote", "heading", "subtext", "listItem"]);

const TIME_FORMATS: Record<string, (d: Date) => string> = {
  t: (d) => d.toISOString().slice(11, 16),
  T: (d) => d.toISOString().slice(11, 19),
  d: (d) => d.toISOString().slice(0, 10),
  D: (d) => d.toISOString().slice(0, 10),
};
/** Discord timestamps (<t:…:f>) as fixed UTC text: the logs are static, so "3 days ago" has no meaning. */
export function formatTimestamp(seconds: string | number, format = "f"): string {
  const d = new Date(Number(seconds) * 1000);
  if (Number.isNaN(d.getTime())) return String(seconds);
  return (TIME_FORMATS[format] ?? ((x: Date) => `${x.toISOString().slice(0, 16).replace("T", " ")} UTC`))(d);
}

interface RenderState {
  ctx: GfmContext;
  spoiler: boolean;
}

/** Renders inline nodes; Discord line breaks become "\n" (turned into hard breaks by paragraphs()). */
function inline(nodes: MdNode[] | undefined, st: RenderState, lineStart: boolean): string {
  let out = "";
  const atStart = () => (out === "" ? lineStart : out.endsWith("\n"));
  for (const n of mergeText(nodes ?? [])) out += inlineNode(n, st, atStart());
  return out;
}

/** The parser splits text at punctuation; rejoin it so escaping sees whole runs (e.g. "&amp;"). */
function mergeText(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.type === "text" && typeof n.content === "string" && prev?.type === "text" && typeof prev.content === "string") {
      out[out.length - 1] = { ...prev, content: prev.content + n.content };
    } else out.push(n);
  }
  return out;
}

function inlineNode(n: MdNode, st: RenderState, lineStart: boolean): string {
  const kids = () => inline(n.content, st, false);
  switch (n.type) {
    case "text":
    case "emoticon":
      if (typeof n.content !== "string") return inline(n.content, st, lineStart);
      return n.content
        .split("\n")
        .map((part: string, i: number) => escapeText(part, lineStart || i > 0))
        .join("\n");
    case "br":
    case "newline":
      return "\n";
    case "strong":
      return `**${kids()}**`;
    case "em":
      return `*${kids()}*`;
    case "underline":
      return `<ins>${kids()}</ins>`;
    case "strikethrough":
      return `~~${kids()}~~`;
    case "inlineCode":
      return inlineCode(String(n.content ?? ""));
    case "codeBlock":
      // A code block inside inline markup (e.g. a spoiler): keep it as inline code.
      return inlineCode(String(n.content ?? ""));
    case "spoiler":
      st.spoiler = true;
      return `||${kids()}||`;
    case "link":
    case "url":
    case "autolink": {
      const dest = linkUrl(n.target);
      if (!dest) return kids();
      // A bare URL shows as itself (an autolink needs no escaping); masked links keep their text.
      return n.type === "link" ? `[${kids()}](${dest})` : dest;
    }
    case "user":
      return `**@${escapeLine(st.ctx.user(n.id) ?? "unknown-user")}**`;
    case "role":
      return `**@${escapeLine(st.ctx.role(n.id) ?? "unknown-role")}**`;
    case "channel": {
      const c = st.ctx.channel(n.id);
      const text = `#${escapeLine(c?.name ?? "unknown")}`;
      return c?.href ? `[**${text}**](${c.href})` : `**${text}**`;
    }
    case "everyone":
      return "**@everyone**";
    case "here":
      return "**@here**";
    case "emoji":
      return escapeText(`:${n.name}:`);
    case "twemoji":
      return String(n.name ?? "");
    case "timestamp":
      return `**${escapeText(formatTimestamp(n.timestamp, n.format))}**`;
    case "slashCommand":
      return inlineCode(`/${n.fullName ?? n.name}`);
    case "guildNavigation":
      return escapeText(`<id:${n.id}>`);
    default:
      // Block nodes in an inline position, or anything unknown: keep the text.
      if (typeof n.content === "string") return escapeText(n.content, lineStart);
      return Array.isArray(n.content) ? inline(n.content, st, lineStart) : "";
  }
}

function list(items: MdNode[], st: RenderState): string {
  let n = 0;
  return items
    .map((it) => {
      const marker = it.ordered ? `${(it.start ?? 1) + (it.indent === 0 ? n++ : 0)}.` : "-";
      return `${"    ".repeat(it.indent)}${marker} ${inline(it.content, st, false).replace(/\n/g, " ")}`;
    })
    .join("\n");
}

/** Renders nodes as GFM blocks separated by blank lines. */
function blocks(nodes: MdNode[], st: RenderState): string {
  const out: string[] = [];
  let run: MdNode[] = [];
  const flush = () => {
    const p = paragraphs(inline(run, st, true));
    if (p) out.push(p);
    run = [];
  };
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!BLOCK_TYPES.has(n.type)) {
      run.push(n);
      continue;
    }
    flush();
    switch (n.type) {
      case "codeBlock":
        out.push(codeBlock(String(n.content ?? ""), n.lang));
        break;
      case "blockQuote": {
        const inner = blocks(n.content ?? [], st);
        if (inner) out.push(quote(inner));
        break;
      }
      case "heading":
        out.push(`${"#".repeat(Math.min(3, Math.max(1, n.level)))} ${inline(n.content, st, false).replace(/\n/g, " ")}`);
        break;
      case "subtext":
        out.push(`<sub>${inline(n.content, st, false).replace(/\n/g, " ")}</sub>`);
        break;
      case "listItem": {
        const items: MdNode[] = [];
        while (i < nodes.length && nodes[i].type === "listItem") items.push(nodes[i++]);
        i--;
        out.push(list(items, st));
        break;
      }
    }
  }
  flush();
  return out.join("\n\n");
}

/** Renders Discord message text as GFM. `spoiler`: it contains spoilers (callers hide the message). */
export function renderMarkdown(text: string, ctx: GfmContext): { md: string; spoiler: boolean } {
  const st: RenderState = { ctx, spoiler: false };
  return { md: blocks(parseMarkdown(text ?? ""), st), spoiler: st.spoiler };
}
