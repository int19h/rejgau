import { describe, expect, it } from "vitest";
import { fold, type RawLine } from "../../tools/fold";
import { buildSiteData } from "../../tools/sitedata";

const line = (t: string, d: any, i: number, src: RawLine["src"] = "gw"): RawLine => ({ at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(), src, t, d });
const M = (id: string, channel: string, extra: any = {}) => ({ id, channel_id: channel, content: `msg ${id}`, author: { id: "7", username: "u", avatar: "abc" }, ...extra });
// Snowflakes created in September 2026.
const ID1 = "1554541602075316245";
const ID2 = "1554541602075316246";

describe("buildSiteData", () => {
  const lines: RawLine[] = [
    line("GUILD_SNAPSHOT", { id: "g", name: "G", roles: [] }, 0, "rejgau"),
    line("CHANNEL_SELECTED", { channel: { id: "11", name: "general", type: 0, parent_id: "10" }, ancestors: [{ id: "10", name: "cat", type: 4 }] }, 1, "rejgau"),
    line("CHANNEL_SELECTED", { channel: { id: "20", name: "gone", type: 0 } }, 2, "rejgau"),
    line("MESSAGE_CREATE", M(ID1, "11", { attachments: [{ id: "3", url: "https://cdn.discordapp.com/attachments/11/3/p.png?ex=1", content_type: "image/png" }] }), 3),
    line("MESSAGE_CREATE", M(ID2, "20"), 4, "rest"),
    line("CHANNEL_UNSELECTED", { id: "20" }, 5, "rejgau"),
    line("MEDIA_STORED", { key: "att-3-p.png", url: "https://github.com/o/r/releases/download/media-2026-09/att-3-p.png" }, 6, "rejgau"),
    line("MEMBER_SNAPSHOT", { user_id: "7", member: { nick: "Nick", roles: [] } }, 7, "rejgau"),
  ];
  const { files } = buildSiteData(fold(lines), "2026-09-30T00:00:00Z");

  it("writes month files only for selected channels, with resolved media", () => {
    expect([...files.keys()].filter((k) => k.startsWith("c/"))).toEqual([`c/11/2026-09.json`]);
    const month: any = files.get("c/11/2026-09.json");
    expect(month.media["att-3-p.png"]).toMatch(/releases\/download/);
    expect(month.media["avatar-7-abc.png"]).toBeNull(); // referenced but not archived
    expect(month.messages[0].content).toBe(`msg ${ID1}`);
  });

  it("lists selected channels with ancestors, and search rows", () => {
    const archive: any = files.get("archive.json");
    expect(Object.keys(archive.channels).sort()).toEqual(["10", "11"]);
    expect(archive.channels["11"].months).toEqual({ "2026-09": 1 });
    const rows: any = files.get("search/2026-09.json");
    expect(rows).toEqual([expect.objectContaining({ id: ID1, c: "11", a: "7", has: ["file", "image"] })]);
  });

  it("collects every name a user had", () => {
    const users: any = files.get("users.json");
    expect(users.users["7"].names).toContain("u");
  });
});

describe("deleted and edited messages", () => {
  it("are published only as their current, undeleted versions", () => {
    const lines: RawLine[] = [
      line("CHANNEL_SELECTED", { channel: { id: "11", name: "general", type: 0 } }, 0, "rejgau"),
      line("MESSAGE_CREATE", M(ID1, "11", { content: "regret this" }), 1),
      line("MESSAGE_DELETE", { id: ID1, channel_id: "11" }, 2),
      line("MESSAGE_CREATE", M(ID2, "11", { type: 19, content: "edited later", message_reference: { message_id: ID1 }, referenced_message: M(ID1, "11", { content: "regret this" }) }), 3),
      line("MESSAGE_UPDATE", M(ID2, "11", { type: 19, content: "now this", edited_timestamp: "2026-09-01T00:00:10Z" }), 4),
    ];
    const { files } = buildSiteData(fold(lines), "2026-09-30T00:00:00Z");
    const month: any = files.get("c/11/2026-09.json");
    expect(month.messages.map((m: any) => m.id)).toEqual([ID2]);
    expect(month.messages[0]).toMatchObject({ content: "now this", referenced: { deleted: true } });
    expect(month.messages[0].edits).toBeUndefined();
    const all = JSON.stringify([...files.values()]);
    expect(all).not.toContain("regret this");
    expect(all).not.toContain("edited later");
  });
});
