import { describe, expect, it } from "vitest";
import { compileQuery, dateRange, monthInBounds, parseQuery, type SearchRow } from "../../reader/src/search";

const ctx = {
  userNames: new Map([["7", ["alice", "Alice W.", "Ally"]], ["8", ["bob"]]]),
  channelNames: new Map([["11", "general"], ["12", "random"]]),
};
const row = (extra: Partial<SearchRow>): SearchRow => ({ id: "1", c: "11", ts: new Date(2026, 8, 15, 12).toISOString(), a: "7", text: "hello world", at: "user", ...extra });
const q = (s: string) => compileQuery(parseQuery(s), ctx);

describe("search", () => {
  it("parses filters, negation, phrases and unknown keys", () => {
    expect(parseQuery('from:alice -has:image "exact phrase" foo:bar Héllo')).toEqual({
      filters: [{ key: "from", value: "alice", negate: false }, { key: "has", value: "image", negate: true }],
      terms: [{ text: "exact phrase", negate: false }, { text: "foo:bar", negate: false }, { text: "hello", negate: false }],
    });
  });

  it("matches text diacritic-insensitively and users by any past name", () => {
    expect(q("héllo").match(row({}))).toBe(true);
    expect(q("from:ally").match(row({}))).toBe(true);
    expect(q("from:bob").match(row({}))).toBe(false);
    expect(q("-from:bob hello").match(row({}))).toBe(true);
    expect(q("in:general").match(row({}))).toBe(true);
    expect(q("in:random").match(row({}))).toBe(false);
    expect(q("mentions:bob").match(row({ men: ["8"] }))).toBe(true);
    expect(q("has:image").match(row({ has: ["file", "image"] }))).toBe(true);
    expect(q("pinned:true").match(row({}))).toBe(false);
    expect(q("authorType:bot").match(row({ at: "bot" }))).toBe(true);
  });

  it("uses local days, with before/after exclusive of the named day", () => {
    expect(q("during:2026-09-15").match(row({}))).toBe(true);
    expect(q("before:2026-09-15").match(row({}))).toBe(false);
    expect(q("after:2026-09-15").match(row({}))).toBe(false);
    expect(q("after:2026-09-14").match(row({}))).toBe(true);
    expect(q("during:2026-09").match(row({}))).toBe(true);
    expect(dateRange("nope")).toBeNull();
  });

  it("prunes months with a day of slack", () => {
    const { bounds } = q("during:2026-09");
    expect(monthInBounds("2026-09", bounds)).toBe(true);
    expect(monthInBounds("2026-10", bounds)).toBe(true); // slack for time zones
    expect(monthInBounds("2026-11", bounds)).toBe(false);
  });
});
