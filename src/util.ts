const DISCORD_EPOCH = 1420070400000n;

/** Creation time (ms since Unix epoch) encoded in a Discord snowflake. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function maxSnowflake(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

/** "YYYY/MM/DD" for a UTC timestamp. */
export function dayPath(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
}

/** "YYYY-MM" for a UTC timestamp. */
export function monthTag(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** Joins a repo folder prefix ("" or "a/b") with a relative path. */
export function joinPath(prefix: string, rel: string): string {
  return prefix ? `${prefix}/${rel}` : rel;
}

/** 64-bit FNV-1a as 16 hex chars; used for stable, non-cryptographic asset names. */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One raw log line: the header fields, then `d` spliced in as already-serialized JSON. */
export function rawLine(fields: { at: number; src: string; sid?: string; s?: number; t: string }, dJson: string): string {
  const head: Record<string, unknown> = { at: new Date(fields.at).toISOString(), src: fields.src };
  if (fields.sid !== undefined) head.sid = fields.sid;
  if (fields.s !== undefined) head.s = fields.s;
  head.t = fields.t;
  return `${JSON.stringify(head).slice(0, -1)},"d":${dJson}}`;
}
