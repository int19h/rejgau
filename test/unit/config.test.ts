import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/config";

describe("parseConfig", () => {
  it("applies defaults", () => {
    const cfg = parseConfig(JSON.stringify({ guilds: { "123": { repo: "o/r", channels: "all" } } }));
    expect(cfg.guilds.get("123")).toEqual({ guildId: "123", repo: "o/r", branch: "archive", path: "", channels: "all", exclude: [], backfill: true, pages: false });
    expect(cfg.flushIdleMs).toBe(120_000);
    expect(cfg.flushMaxMs).toBe(600_000);
    expect(cfg.maxMediaBytes).toBe(100 * 1024 * 1024);
    expect(cfg.mediaSpacingMs).toBe(8000);
  });

  it("normalizes the folder path", () => {
    const cfg = parseConfig(JSON.stringify({ guilds: { "1": { repo: "o/r", path: "/logs/x/", channels: ["2"] } } }));
    expect(cfg.guilds.get("1")!.path).toBe("logs/x");
  });

  it.each([
    [undefined, /not set/],
    ["{", /not valid JSON/],
    ["{}", /"guilds"/],
    [JSON.stringify({ guilds: { abc: { repo: "o/r", channels: "all" } } }), /guild ID/],
    [JSON.stringify({ guilds: { "1": { repo: "nope", channels: "all" } } }), /repo/],
    [JSON.stringify({ guilds: { "1": { repo: "o/r", channels: [1] } } }), /channels/],
    [JSON.stringify({ guilds: { "1": { repo: "o/r", channels: "all", path: "../x" } } }), /path/],
    [JSON.stringify({ guilds: {}, flushIdleSeconds: -1 }), /flushIdleSeconds/],
  ])("rejects %s", (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(message);
  });
});
