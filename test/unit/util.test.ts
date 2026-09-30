import { describe, expect, it } from "vitest";
import { dayPath, fnv1a64, joinPath, maxSnowflake, monthTag, rawLine, snowflakeTime } from "../../src/util";

describe("util", () => {
  it("decodes snowflake timestamps", () => {
    // From the spike: message 1554541602075316245 was received at 2026-09-29T17:13:19Z.
    expect(new Date(snowflakeTime("1554541602075316245")).toISOString()).toMatch(/^2026-09-29T17:13:1/);
  });

  it("formats UTC day paths and months", () => {
    const t = Date.UTC(2026, 0, 5, 23, 59);
    expect(dayPath(t)).toBe("2026/01/05");
    expect(monthTag(t)).toBe("2026-01");
  });

  it("compares snowflakes numerically", () => {
    expect(maxSnowflake("99", "100")).toBe("100");
    expect(maxSnowflake(null, "1")).toBe("1");
  });

  it("joins folder prefixes", () => {
    expect(joinPath("", "raw/x")).toBe("raw/x");
    expect(joinPath("a/b", "raw/x")).toBe("a/b/raw/x");
  });

  it("hashes stably", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });

  it("builds raw lines with d spliced in verbatim", () => {
    const line = rawLine({ at: Date.UTC(2026, 8, 29), src: "gw", sid: "x", s: 5, t: "MESSAGE_CREATE" }, '{"id":"1","content":"é"}');
    expect(line).toBe('{"at":"2026-09-29T00:00:00.000Z","src":"gw","sid":"x","s":5,"t":"MESSAGE_CREATE","d":{"id":"1","content":"é"}}');
    expect(JSON.parse(line).d.content).toBe("é");
  });
});
