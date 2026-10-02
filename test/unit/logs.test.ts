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
const DELETED = "1554541602075316247";
const REPLY_TO_EDITED = "1554541602075316248";
const REPLY_TO_DELETED = "1554541602075316249";

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
  line("MESSAGE_CREATE", M(DELETED, "11", { content: "regret this" }), 8),
  line("MESSAGE_DELETE", { id: DELETED, channel_id: "11" }, 9),
  // Replies embed the message they reply to as it was then.
  line("MESSAGE_CREATE", M(REPLY_TO_EDITED, "11", { type: 19, message_reference: { message_id: ID2 }, referenced_message: M(ID2, "11", { content: "a reply" }) }), 9),
  line("MESSAGE_CREATE", M(REPLY_TO_DELETED, "11", { type: 19, message_reference: { message_id: DELETED }, referenced_message: M(DELETED, "11", { content: "regret this" }) }), 9),
  line("MESSAGE_CREATE", M("1554541602075316400", THREAD, { content: "in thread" }), 10),
  line("MESSAGE_CREATE", M("1554541602075316500", "12", { content: "voice chat" }), 11),
  line("MEDIA_STORED", { key: "att-3-p.png", url: "https://github.com/o/r/releases/download/media-2026-09/att-3-p.png" }, 12, "rejgau"),
];
const files = buildLogs(fold(lines), { source: "archive@abc1234" });

describe("buildLogs", () => {
  it("lays out channels, threads and days; skips channels with nothing archived; avoids folder clashes", () => {
    expect([...files.keys()].sort()).toEqual([
      "General-12/2026/09/29.md",
      "General-12/README.md",
      "README.md",
      "general/2026/09/29.md",
      "general/2026/09/29/a-thread.md",
      "general/2026/09/30.md",
      "general/README.md",
    ]);
    const root = files.get("README.md")!;
    expect(root).toContain("# Guild \\<b\\>");
    expect(root).toContain("Rendered by rejgau from the raw logs (`archive@abc1234`).");
    expect(root).toContain("## Text\n\n- [#general](general/README.md) · 5 messages");
    expect(files.get("general/README.md")).toContain("- **a thread** · 1 message · [2026-09-29](2026/09/29/a-thread.md)");
    const thread = files.get("general/2026/09/29/a-thread.md")!;
    expect(thread).toContain("# 🧵 a thread · 2026-09-29\n\n<sub>thread started 2026-09-29 17:13 UTC · times are UTC</sub>\n\n[#general](../29.md)");
    expect(files.get("general/2026/09/29.md")).toContain("🧵 [a thread](29/a-thread.md)");
  });

  it("renders a day with anchors, navigation and archived media; folds messages with spoilers", () => {
    const day = files.get("general/2026/09/29.md")!;
    expect(day).toContain("[#general](../../README.md) · [2026-09-30 →](30.md)");
    expect(day).toContain(`<p align="center"><a id="m${ID1}" href="#m${ID1}"><tt><b>Alice</b> · 17:13</tt></a></p>\n\n<details><summary>Spoiler</summary>\n\nhello ||secret||\n\n![p.png](<https://github.com/o/r/releases/download/media-2026-09/att-3-p.png>)\n\n</details>`);
  });

  it("links replies to the original, showing only current versions", () => {
    const day = files.get("general/2026/09/29.md")!;
    // Previews show the current text, with spoilers masked.
    expect(day).toContain(`> ↪ replying to **Alice**: [hello \\[spoiler\\]](29.md#m${ID1})`);
    expect(day).toContain(`> ↪ replying to **Alice**: [a reply, edited](29.md#m${ID2})`);
    expect(day).toContain("<sub>edited 2026-09-29 12:00 UTC</sub>");
    expect(day).not.toContain("earlier version");
  });

  it("leaves out deleted messages, including from replies to them (raw/ keeps them)", () => {
    const day = files.get("general/2026/09/29.md")!;
    expect(day).not.toContain("regret this");
    expect(day).not.toContain(`m${DELETED}`);
    expect(day).toContain("> ↪ replying to a deleted message");
  });

  it("links threads from the message that started them", () => {
    expect(files.get("general/2026/09/30.md")).toContain("🧵 [a thread](29/a-thread.md) · 1 message");
  });
});

describe("message headers", () => {
  it("are HTML-escaped (no Markdown inside an HTML block) and carry badges", () => {
    const files = buildLogs(
      fold([
        line("CHANNEL_SELECTED", { channel: { id: "11", name: "general", type: 0 } }, 0, "rejgau"),
        line("MESSAGE_CREATE", M(ID1, "11", { author: { id: "8", username: "x", global_name: "<b>&co_*", bot: true } }), 1),
        line("MESSAGE_CREATE", M(ID2, "11", { type: 7 }), 2),
      ]),
    );
    const day = files.get("general/2026/09/29.md")!;
    expect(day).toContain(`<tt><b>&lt;b&gt;&amp;co_*</b> <kbd>APP</kbd> · 17:13</tt>`);
    expect(day).toContain(`<p align="center"><tt>→ <b>Alice</b> joined the server. · <a id="m${ID2}" href="#m${ID2}">17:13</a></tt></p>`);
  });
});

describe("threads", () => {
  it("split by day; a same-day name clash renames only the newer thread, only on that day", () => {
    const T1 = "1554541602075316300"; // 2026-09-29
    const T2 = "1554541602075316301";
    const NEXT_DAY = "1554900000000000000"; // 2026-09-30
    const files = buildLogs(
      fold([
        line("CHANNEL_SELECTED", { channel: { id: "11", name: "general", type: 0 } }, 0, "rejgau"),
        line("CHANNEL_SELECTED", { channel: { id: T1, name: "Topic", type: 11, parent_id: "11" } }, 1, "rejgau"),
        line("CHANNEL_SELECTED", { channel: { id: T2, name: "topic", type: 11, parent_id: "11" } }, 2, "rejgau"),
        line("MESSAGE_CREATE", M("1554541602075316400", T1), 3),
        line("MESSAGE_CREATE", M("1554541602075316401", T2), 4),
        line("MESSAGE_CREATE", M(NEXT_DAY, T2), 5),
      ]),
    );
    expect([...files.keys()].filter((k) => k.includes("/09/")).sort()).toEqual([
      "general/2026/09/29/Topic.md",
      `general/2026/09/29/topic-${T2}.md`,
      "general/2026/09/30/topic.md",
    ]);
    expect(files.get(`general/2026/09/29/topic-${T2}.md`)).toContain("[2026-09-30 →](../30/topic.md)");
  });
});

describe("hostile names", () => {
  const T = "1554541602075316300";
  const files = buildLogs(
    fold([
      line("CHANNEL_SELECTED", { channel: { id: "11", name: "README.md", type: 0 } }, 0, "rejgau"),
      line("CHANNEL_SELECTED", { channel: { id: T, name: "Q&A :)", type: 11, parent_id: "11" } }, 1, "rejgau"),
      line("MESSAGE_CREATE", M(ID1, "11", { author: { id: "8", username: "x", global_name: "Mallory\n\n# INJECTED [click](https://evil.example)" } }), 2),
      line("MESSAGE_CREATE", M("1554541602075316400", T), 3),
    ]),
  );

  it("can't take the index's name", () => {
    expect(files.get("README.md")).toContain("# Archive");
    expect(files.get("README.md-11/README.md")).toBeDefined();
  });

  it("stay on one line inside header HTML", () => {
    const day = files.get("README.md-11/2026/09/29.md")!;
    expect(day).toContain("<tt><b>Mallory # INJECTED [click](https://evil.example)</b> · 17:13</tt>");
    expect(day).not.toMatch(/^# INJECTED/m);
  });

  it("are fully percent-encoded in links", () => {
    expect(files.get("README.md-11/2026/09/29.md")).toContain("(29/Q%26A--%29.md)");
  });
});

describe("orphaned threads", () => {
  it("aren't published once their parent is unselected", () => {
    const T = "1554541602075316300";
    const files = buildLogs(
      fold([
        line("CHANNEL_SELECTED", { channel: { id: "11", name: "general", type: 0 } }, 0, "rejgau"),
        line("CHANNEL_SELECTED", { channel: { id: T, name: "a thread", type: 11, parent_id: "11" } }, 1, "rejgau"),
        line("MESSAGE_CREATE", M("1554541602075316400", T), 2),
        line("THREAD_DELETE", { id: T, parent_id: "11", type: 11 }, 3),
        line("CHANNEL_UNSELECTED", { id: "11" }, 4, "rejgau"),
      ]),
    );
    expect([...files.keys()]).toEqual(["README.md"]);
  });
});

describe("path collision chains", () => {
  it("keeps every channel and gives each index link a distinct target", () => {
    const inputs: RawLine[] = [];
    for (const [id, name, position] of [["11", "foo", 1], ["12", "foo-13", 2], ["14", "foo-13-2", 3], ["13", "foo", 4]] as const) {
      inputs.push(line("CHANNEL_SELECTED", { channel: { id, name, type: 0, position } }, 0, "rejgau"));
      inputs.push(line("MESSAGE_CREATE", M(String(BigInt(ID1) + BigInt(id)), id, { content: `marker-${id}` }), 1));
    }
    const output = buildLogs(fold(inputs));
    expect([...output.keys()].filter((path) => path.endsWith("/README.md"))).toEqual(["foo/README.md", "foo-13/README.md", "foo-13-2/README.md", "foo-13-3/README.md"]);
    for (const id of ["11", "12", "13", "14"]) expect([...output.values()].some((text) => text.includes(`marker-${id}`))).toBe(true);
    expect(output.get("README.md")).toContain("(foo-13-3/README.md)");
  });

  it("keeps thread collision chains distinct and limits UTF-8 segment lengths", () => {
    const t1 = "1554541602075316300";
    const t2 = "1554541602075316301";
    const t3 = "1554541602075316302";
    const inputs: RawLine[] = [line("CHANNEL_SELECTED", { channel: { id: "11", name: "雪".repeat(100), type: 0 } }, 0, "rejgau")];
    for (const [id, name] of [[t1, "topic"], [t2, `topic-${t3}`], [t3, "topic"]]) {
      inputs.push(line("CHANNEL_SELECTED", { channel: { id, name, type: 11, parent_id: "11" } }, 1, "rejgau"));
      inputs.push(line("MESSAGE_CREATE", M(String(BigInt(id) + 200n), id), 2));
    }
    const output = buildLogs(fold(inputs));
    const threadPaths = [...output.keys()].filter((path) => path.includes("/29/"));
    expect(new Set(threadPaths).size).toBe(3);
    expect(threadPaths.some((path) => path.endsWith(`topic-${t3}-2.md`))).toBe(true);
    for (const path of output.keys()) for (const part of path.split("/")) expect(Buffer.byteLength(part)).toBeLessThan(256);
  });
});
