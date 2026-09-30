/** Case- and diacritic-insensitive form used for search (at build time and for queries). */
export function normalizeText(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}
