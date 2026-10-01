import { describe, expect, it } from "vitest";
import { CHANNEL_FLAG_OBFUSCATED, canView, isArchived, lineScope, publishedChannelIds, type ChannelInfo } from "../../src/channels";
import type { GuildConfig } from "../../src/config";

const ch = (id: string, type: number, parentId: string | null = null, flags = 0): [string, ChannelInfo] => [id, { id, type, parentId, flags, deleted: false }];

// category 10 > text 11 (with thread 12), text 13 at top level, category 20 > text 21, hidden 30
const channels = new Map<string, ChannelInfo>([
  ch("10", 4), ch("11", 0, "10"), ch("12", 11, "11"), ch("13", 0),
  ch("20", 4), ch("21", 0, "20"), ch("30", 0, null, CHANNEL_FLAG_OBFUSCATED),
]);
const cfg = (channels: GuildConfig["channels"], exclude: string[] = []): GuildConfig => ({
  guildId: "1", repo: "o/r", branch: "archive", path: "", channels, exclude, backfill: true, pages: false,
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

describe("canView", () => {
  const VIEW = String(1 << 10);
  const ctx = (memberRoles: string[] = [], everyone = VIEW, extra: Record<string, string> = {}) => ({
    guildId: "g",
    userId: "bot",
    roles: { g: everyone, mods: "0", admin: String(1 << 3), viewers: VIEW, ...extra },
    memberRoles,
  });
  const deny = (id: string, type = 0) => ({ id, type, allow: "0", deny: VIEW });
  const allow = (id: string, type = 0) => ({ id, type, allow: VIEW, deny: "0" });

  it("starts from @everyone and the bot's roles", () => {
    expect(canView([], ctx())).toBe(true);
    expect(canView([], ctx([], "0"))).toBe(false);
    expect(canView([], ctx(["viewers"], "0"))).toBe(true);
  });

  it("applies overwrites in Discord's order: @everyone, then roles combined, then the member", () => {
    expect(canView([deny("g")], ctx())).toBe(false);
    expect(canView([deny("g"), allow("mods")], ctx(["mods"]))).toBe(true);
    // Role allow beats role deny when the bot has both roles.
    expect(canView([deny("g"), allow("mods"), deny("viewers")], ctx(["mods", "viewers"]))).toBe(true);
    // Overwrites for roles the bot doesn't have don't count.
    expect(canView([deny("g"), allow("mods")], ctx())).toBe(false);
    expect(canView([allow("g"), deny("bot", 1)], ctx())).toBe(false);
    expect(canView([deny("g"), allow("bot", 1)], ctx())).toBe(true);
    // The older string form of overwrite types.
    expect(canView([deny("g", "role" as any)], ctx())).toBe(false);
  });

  it("lets administrators see everything", () => {
    expect(canView([deny("g"), deny("bot", 1)], ctx(["admin"]))).toBe(true);
  });
});

describe("hidden channels", () => {
  it("are never archived, nor are threads under them", () => {
    const channels = new Map<string, ChannelInfo>([
      ["10", { id: "10", type: 0, parentId: null, flags: 0, deleted: false, hidden: true }],
      ["11", { id: "11", type: 11, parentId: "10", flags: 0, deleted: false, hidden: false }],
      ["12", { id: "12", type: 0, parentId: null, flags: 0, deleted: false, hidden: false }],
    ]);
    const cfg = { channels: "all" as const, exclude: [] } as any;
    expect(isArchived("10", channels, cfg)).toBe(false);
    expect(isArchived("11", channels, cfg)).toBe(false);
    expect(isArchived("12", channels, cfg)).toBe(true);
  });
});

describe("lineScope", () => {
  it("files lines under the channel or thread they concern, else the guild", () => {
    expect(lineScope("MESSAGE_CREATE", { channel_id: "11" })).toBe("11");
    expect(lineScope("MESSAGE_REACTION_ADD", { channel_id: "11" })).toBe("11");
    expect(lineScope("THREAD_CREATE", { id: "12", parent_id: "11" })).toBe("12");
    expect(lineScope("CHANNEL_UPDATE", { id: "11" })).toBe("11");
    expect(lineScope("CHANNEL_SELECTED", { channel: { id: "11" } })).toBe("11");
    expect(lineScope("CHANNEL_UNSELECTED", { id: "11" })).toBe("11");
    expect(lineScope("BACKFILL_END", { channel_id: "11" })).toBe("11");
    expect(lineScope("GUILD_SNAPSHOT", { id: "1", system_channel_id: "11" })).toBe("guild");
    expect(lineScope("MEMBER_SNAPSHOT", { user_id: "7" })).toBe("guild");
    // Never a path from untrusted input.
    expect(lineScope("MESSAGE_CREATE", { channel_id: "../../x" })).toBe("guild");
  });
});
