import { describe, expect, it } from "vitest";
import { fold, type RawLine } from "../../tools/fold";
import { buildSiteData } from "../../tools/sitedata";
import { buildLogs } from "../../tools/logs";

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

describe("publication privacy regressions", () => {
  it.each(["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"])("suppresses an original known only through a reply after %s", (event) => {
    const deletion = event === "MESSAGE_DELETE" ? { id: ID1 } : { ids: [ID1] };
    const st = fold([
      line("CHANNEL_SELECTED", { channel: { id: "11", name: "general", type: 0 } }, 0, "rejgau"),
      line("MESSAGE_CREATE", M(ID2, "11", { type: 19, content: "visible reply", referenced_message: M(ID1, "11", { content: "private original", author: { id: "8", username: "deleted author" } }), message_reference: { message_id: ID1 } }), 1),
      line(event, { ...deletion, channel_id: "11" }, 2),
      line("MESSAGE_CREATE", M(ID1, "11", { content: "private original" }), 3, "rest"),
    ]);
    const { files } = buildSiteData(st);
    const month: any = files.get("c/11/2026-09.json");
    expect(month.messages).toHaveLength(1);
    expect(month.messages[0].referenced).toEqual({ deleted: true });
    expect(JSON.stringify([...files.values()])).not.toMatch(/private original|deleted author/);
    expect([...buildLogs(st).values()].join("\n")).not.toMatch(/private original|deleted author/);
  });

  it("preserves an intentional forwarded snapshot when its source message is deleted", () => {
    const { files } = buildSiteData(fold([
      line("CHANNEL_SELECTED", { channel: { id: "11", type: 0 } }, 0, "rejgau"),
      line("MESSAGE_DELETE", { id: ID1, channel_id: "11" }, 1),
      line("MESSAGE_CREATE", M(ID2, "11", { message_reference: { type: 1, message_id: ID1 }, message_snapshots: [{ message: { content: "intentional forward" } }] }), 2),
    ]));
    const month: any = files.get("c/11/2026-09.json");
    expect(month.messages[0].message_snapshots[0].message.content).toBe("intentional forward");
  });

  it.each(["unselected", "deleted", "removed"])("omits reactor profiles and media after the only usage is %s", (action) => {
    const lines = [
      line("CHANNEL_SELECTED", { channel: { id: "11", type: 0 } }, 0, "rejgau"),
      line("MESSAGE_CREATE", M(ID1, "11"), 1),
      line("MESSAGE_REACTION_ADD", { message_id: ID1, user_id: "99", emoji: { name: "a" }, member: { nick: "Hidden nickname", roles: ["3"], user: { id: "99", username: "OnlyHidden", avatar: "hidden" } } }, 2),
    ];
    if (action === "unselected") lines.push(line("CHANNEL_UNSELECTED", { id: "11" }, 3, "rejgau"));
    if (action === "deleted") lines.push(line("MESSAGE_DELETE", { id: ID1 }, 3));
    if (action === "removed") lines.push(line("MESSAGE_REACTION_REMOVE", { message_id: ID1, user_id: "99", emoji: { name: "a" } }, 3));
    const output = JSON.stringify([...buildSiteData(fold(lines)).files.values()]);
    expect(output).not.toMatch(/OnlyHidden|Hidden nickname|avatar-99-hidden/);
  });

  it("keeps visible reactor and voter profiles without importing a hidden message's newer profile", () => {
    const { files } = buildSiteData(fold([
      line("CHANNEL_SELECTED", { channel: { id: "11", type: 0 } }, 0, "rejgau"),
      line("CHANNEL_SELECTED", { channel: { id: "12", type: 0 } }, 1, "rejgau"),
      line("MESSAGE_CREATE", M(ID1, "11"), 2),
      line("MESSAGE_CREATE", M(ID2, "12"), 3),
      line("MESSAGE_REACTION_ADD", { message_id: ID1, user_id: "99", emoji: { name: "a" }, member: { user: { id: "99", username: "Visible name" } } }, 4),
      line("MESSAGE_POLL_VOTE_ADD", { message_id: ID1, user_id: "99", answer_id: 1 }, 5),
      line("MESSAGE_REACTION_REMOVE", { message_id: ID1, user_id: "99", emoji: { name: "a" } }, 6),
      line("MESSAGE_REACTION_ADD", { message_id: ID2, user_id: "99", emoji: { name: "a" }, member: { user: { id: "99", username: "Hidden name" } } }, 7),
      line("CHANNEL_UNSELECTED", { id: "12" }, 8, "rejgau"),
    ]));
    const users: any = files.get("users.json");
    expect(users.users["99"].username).toBe("Visible name");
    expect(JSON.stringify([...files.values()])).not.toContain("Hidden name");
  });
});
