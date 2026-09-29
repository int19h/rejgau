// Discord-style search: query parsing and matching against the build's search rows.

import { normalizeText } from "./text";

export interface SearchRow {
  id: string;
  c: string;
  ts: string;
  a?: string;
  text: string;
  at: "user" | "bot" | "webhook";
  has?: string[];
  men?: string[];
  pin?: boolean;
  del?: boolean;
}

export const FILTER_KEYS = ["from", "mentions", "in", "has", "before", "after", "during", "pinned", "authortype"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

export interface Filter {
  key: FilterKey;
  value: string;
  negate: boolean;
}

export interface ParsedQuery {
  /** Plain words and "quoted phrases", all required. */
  terms: { text: string; negate: boolean }[];
  filters: Filter[];
}

const TOKEN = /(-?)(?:([A-Za-z]+):(?:"([^"]*)"|(\S*))|"([^"]*)"|(\S+))/g;

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { terms: [], filters: [] };
  for (const m of q.matchAll(TOKEN)) {
    const negate = m[1] === "-";
    const key = m[2]?.toLowerCase();
    if (key !== undefined) {
      const value = m[3] ?? m[4] ?? "";
      if ((FILTER_KEYS as readonly string[]).includes(key) && value) {
        out.filters.push({ key: key as FilterKey, value, negate });
        continue;
      }
      // Unknown key (or empty value): treat the whole token as text.
      out.terms.push({ text: normalizeText(`${m[2]}:${value}`), negate });
      continue;
    }
    const text = m[5] ?? m[6] ?? "";
    if (text) out.terms.push({ text: normalizeText(text), negate });
  }
  return out;
}

export interface SearchContext {
  /** user id → names ever seen (username, display name, nicknames). */
  userNames: Map<string, string[]>;
  /** channel id → name. */
  channelNames: Map<string, string>;
  /** For date filters: the viewer's time zone offset is taken from `Date` (local time). */
  now?: Date;
}

/** Local-time [start, end) of a YYYY, YYYY-MM or YYYY-MM-DD value; null if unparseable. */
export function dateRange(value: string): [number, number] | null {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  if (m[3]) {
    const start = new Date(y, Number(m[2]) - 1, Number(m[3]));
    return [start.getTime(), new Date(y, Number(m[2]) - 1, Number(m[3]) + 1).getTime()];
  }
  if (m[2]) return [new Date(y, Number(m[2]) - 1, 1).getTime(), new Date(y, Number(m[2]), 1).getTime()];
  return [new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime()];
}

function resolveUsers(value: string, ctx: SearchContext): Set<string> {
  const v = normalizeText(value.replace(/^@/, ""));
  const exact = new Set<string>();
  const partial = new Set<string>();
  for (const [id, names] of ctx.userNames) {
    if (id === value) exact.add(id);
    for (const n of names) {
      const nn = normalizeText(n);
      if (nn === v) exact.add(id);
      else if (nn.includes(v)) partial.add(id);
    }
  }
  return exact.size ? exact : partial;
}

function resolveChannels(value: string, ctx: SearchContext): Set<string> {
  const v = normalizeText(value.replace(/^#/, ""));
  const ids = new Set<string>();
  for (const [id, name] of ctx.channelNames) if (id === value || normalizeText(name) === v) ids.add(id);
  return ids;
}

export interface CompiledQuery {
  match(row: SearchRow): boolean;
  /** Time bounds implied by date filters, for pruning which months to load. */
  bounds: { from: number; to: number };
  empty: boolean;
}

export function compileQuery(q: ParsedQuery, ctx: SearchContext): CompiledQuery {
  const preds: ((r: SearchRow) => boolean)[] = [];
  let from = -Infinity;
  let to = Infinity;
  for (const t of q.terms) preds.push((r) => r.text.includes(t.text) !== t.negate);
  for (const f of q.filters) {
    let p: ((r: SearchRow) => boolean) | null = null;
    switch (f.key) {
      case "from": {
        const ids = resolveUsers(f.value, ctx);
        p = (r) => !!r.a && ids.has(r.a);
        break;
      }
      case "mentions": {
        const ids = resolveUsers(f.value, ctx);
        p = (r) => !!r.men?.some((id) => ids.has(id));
        break;
      }
      case "in": {
        const ids = resolveChannels(f.value, ctx);
        p = (r) => ids.has(r.c);
        break;
      }
      case "has": {
        const v = f.value.toLowerCase();
        p = (r) => !!r.has?.includes(v);
        break;
      }
      case "pinned": {
        const v = f.value.toLowerCase() === "true";
        p = (r) => !!r.pin === v;
        break;
      }
      case "authortype": {
        const v = f.value.toLowerCase();
        p = (r) => r.at === v;
        break;
      }
      case "before":
      case "after":
      case "during": {
        const range = dateRange(f.value);
        if (!range) break;
        const [start, end] = range;
        // As in Discord: before/after exclude the named day (or month/year).
        const inRange =
          f.key === "before" ? (t: number) => t < start : f.key === "after" ? (t: number) => t >= end : (t: number) => t >= start && t < end;
        p = (r) => inRange(Date.parse(r.ts));
        if (!f.negate) {
          if (f.key === "before") to = Math.min(to, start);
          else if (f.key === "after") from = Math.max(from, end);
          else {
            from = Math.max(from, start);
            to = Math.min(to, end);
          }
        }
        break;
      }
    }
    if (p) {
      const inner = p;
      preds.push(f.negate ? (r) => !inner(r) : inner);
    }
  }
  return {
    match: (r) => preds.every((p) => p(r)),
    bounds: { from, to },
    empty: q.terms.length === 0 && q.filters.length === 0,
  };
}

/** Whether a UTC month (YYYY-MM) can contain times in [from, to), with a day of slack for time zones. */
export function monthInBounds(month: string, bounds: { from: number; to: number }): boolean {
  const [y, m] = month.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1) - 86_400_000;
  const end = Date.UTC(y, m, 1) + 86_400_000;
  return end > bounds.from && start < bounds.to;
}
