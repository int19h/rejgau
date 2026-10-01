import { describe, expect, it } from "vitest";
import { fold, type RawLine } from "../../tools/fold";
import { buildLogs } from "../../tools/logs";

const line = (t: string, d: any, i: number, src: RawLine["src"] = "gw"): RawLine => ({ at: new Date(Date.UTC(2026, 8, 29) + i * 1000).toISOString(), src, t, d });
const author = { id: "7", username: "alice", global_name: "Alice" };
const M = (id: string, channel: string, extra: any = {}) => ({ id, channel_id: channel, type: 0, content: `msg ${id}`, author, ...extra });
// Snowflakes: ID1/ID2 on 2026-09-29, ID3 on 2026-09-30 (UTC).
const ID1 = "1554541602075316245";
const ID2 = "1554541602075316246";
const ID3 = "1554900000000000000";
const THREAD = "1554541602075316300";

const lines: RawLine[] = [
  line("GUILD_SNAPSHOT", { id: "g", name: "Guild <b>", roles: [] }, 0, "rejgau"),
  line("CHANNEL_SELECTED", { channel: { id: "11", name: "general", type: 0, parent_id: "10", position: 1 }, ancestors: [{ id: "10", name: "Text", type: 4 }] }, 1, "rejgau"),
  line("CHANNEL_SELECTED", { channel: { id: "12", name: "General", type: 2, position: 2 } }, 2, "rejgau"),
  line("CHANNEL_SELECTED", { channel: { id: "13", name: "unreadable", type: 0 } }, 3, "rejgau"),
  line("CHANNEL_SELECTED", { channel: { id: THREAD, name: "a thread", type: 11, parent_id: "11" } }, 4, "rejgau"),
  line("MESSAGE_CREATE", M(ID1, "11", { content: "hello ||secret||", attachments: [{ id: "3", filename: "p.png", url: "https://cdn.discordapp.com/attachments/11/3/p.png?ex=1", content_type: "image/png" }] }), 5),
  line("MESSAGE_CREATE", M(ID2, "11", { type: 19, content: "a reply", message_reference: { message_id: ID1, channel_id: "11" }, referenced_message: M(ID1, "11", { content: "hello" }) }), 6),
  line("MESSAGE_UPDATE", M(ID2, "11", { type: 19, content: "a reply, edited", edited_timestamp: "2026-09-29T12:00:00Z" }), 7),
  line("MESSAGE_CREATE", M(ID3, "11", { thread: { id: THREAD, name: "a thread" } }), 8),
  line("MESSAGE_DELETE", { id: ID3, channel_id: "11" }, 9),
  line("MESSAGE_CREATE", M("1554541602075316400", THREAD, { content: "in thread" }), 10),
  line("MESSAGE_CREATE", M("1554541602075316500", "12", { content: "voice chat" }), 11),
  line("MEDIA_STORED", { key: "att-3-p.png", url: "https://github.com/o/r/releases/download/media-2026-09/att-3-p.png" }, 12, "rejgau"),
];
const files = buildLogs(fold(lines), "2026-10-01T00:00:00Z");

describe("buildLogs", () => {
  it("lays out channels, threads and days; skips channels with nothing archived; avoids folder clashes", () => {
    expect([...files.keys()].sort()).toEqual([
      "General-12/2026/09/29.md",
      "General-12/README.md",
      "README.md",
      "general/2026/09/29.md",
      "general/2026/09/30.md",
      "general/README.md",
      "general/threads/a-thread/2026/09/29.md",
      "general/threads/a-thread/README.md",
    ]);
    const root = files.get("README.md")!;
    expect(root).toContain("# Guild \\<b\\>");
    expect(root).toContain("## Text\n\n- [#general](general/README.md) · 3 messages");
    expect(files.get("general/README.md")).toContain("- [a thread](threads/a-thread/README.md) · 1 message");
  });

  it("renders a day with anchors, navigation and archived media; folds messages with spoilers", () => {
    const day = files.get("general/2026/09/29.md")!;
    expect(day).toContain("[#general](../../README.md) · [2026-09-30 →](30.md)");
    expect(day).toContain(`**Alice** · 17:13 <a id="m${ID1}"></a>\n\n<details><summary>Spoiler</summary>\n\nhello ||secret||\n\n![p.png](<https://github.com/o/r/releases/download/media-2026-09/att-3-p.png>)\n\n</details>`);
  });

  it("links replies to the original, and keeps earlier versions of edited messages", () => {
    const day = files.get("general/2026/09/29.md")!;
    expect(day).toContain(`> ↪ replying to **Alice**: [hello](29.md#m${ID1})`);
    expect(day).toContain("<sub>edited 2026-09-29 12:00 UTC</sub>");
    expect(day).toContain("<details><summary>1 earlier version</summary>");
    expect(day).toContain("a reply, edited");
  });

  it("marks deleted messages and links threads", () => {
    const day = files.get("general/2026/09/30.md")!;
    expect(day).toMatch(/🗑 deleted 2026-09-29 \d\d:\d\d UTC/);
    expect(day).toContain("🧵 [a thread](../../threads/a-thread/README.md) · 1 message");
  });
});
