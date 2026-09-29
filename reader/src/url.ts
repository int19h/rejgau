/** Returns the URL if it's http(s), otherwise null. Everything user- or app-supplied goes through this. */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}
