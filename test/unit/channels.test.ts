import { describe, expect, it } from "vitest";
import { CHANNEL_FLAG_OBFUSCATED, isArchived, publishedChannelIds, type ChannelInfo } from "../../src/channels";
import type { GuildConfig } from "../../src/config";

const ch = (id: string, type: number, parentId: string | null = null, flags = 0): [string, ChannelInfo] => [id, { id, type, parentId, flags, deleted: false }];

// category 10 > text 11 (with thread 12), text 13 at top level, category 20 > text 21, hidden 30
const channels = new Map<string, ChannelInfo>([
  ch("10", 4), ch("11", 0, "10"), ch("12", 11, "11"), ch("13", 0),
  ch("20", 4), ch("21", 0, "20"), ch("30", 0, null, CHANNEL_FLAG_OBFUSCATED),
]);
const cfg = (channels: GuildConfig["channels"], exclude: string[] = []): GuildConfig => ({
  guildId: "1", repo: "o/r", branch: "archive", path: "", channels, exclude, backfill: true,
});

describe("isArchived", () => {
  it("selects everything visible with 'all', except categories and obfuscated channels", () => {
    const sel = [...channels.keys()].filter((id) => isArchived(id, channels, cfg("all")));
    expect(sel).toEqual(["11", "12", "13", "21"]);
  });

  it("selects a category's channels and their threads", () => {
    const sel = [...channels.keys()].filter((id) => isArchived(id, channels, cfg(["10"])));
    expect(sel).toEqual(["11", "12"]);
  });

  it("applies exclusions to descendants", () => {
    const sel = [...channels.keys()].filter((id) => isArchived(id, channels, cfg("all", ["11", "20"])));
    expect(sel).toEqual(["13"]);
  });

  it("ignores unknown channels", () => {
    expect(isArchived("999", channels, cfg("all"))).toBe(false);
  });

  it("follows a channel moved into another category", () => {
    const moved = new Map(channels);
    moved.set("13", { ...moved.get("13")!, parentId: "10" });
    expect(isArchived("13", channels, cfg(["10"]))).toBe(false);
    expect(isArchived("13", moved, cfg(["10"]))).toBe(true);
  });
});

describe("publishedChannelIds", () => {
  it("includes archived channels and their ancestors only", () => {
    expect([...publishedChannelIds(channels, cfg(["12"]))].sort()).toEqual(["10", "11", "12"]);
    expect([...publishedChannelIds(channels, cfg(["13"]))]).toEqual(["13"]);
  });
});

describe("isArchived with an incomplete channel tree", () => {
  it("fails closed when a parent is unknown", () => {
    // Channel 21's category (20) is excluded, but we only know the channel itself.
    const partial = new Map<string, ChannelInfo>([ch("21", 0, "20"), ch("12", 11, "11")]);
    expect(isArchived("21", partial, cfg("all", ["20"]))).toBe(false);
    expect(isArchived("12", partial, cfg("all"))).toBe(false);
  });
});
