import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutboxEvent } from "../../src/env";
import { installFakes, type FakeDiscord, type FakeGitHub, type FakeRepo } from "./fakes";

// Config (see vitest.config.ts): channels ["10"] (a category), exclude ["13"]; backfill off for 101.
const CATEGORY = { id: "10", type: 4, name: "Archived category" };
const GENERAL = { id: "11", type: 0, name: "general", parent_id: "10", last_message_id: "1554541602075316245" };
const EXCLUDED = { id: "13", type: 0, name: "excluded-secret", parent_id: "10" };
const OTHER = { id: "20", type: 0, name: "other-secret" };

const T0 = Date.UTC(2026, 8, 29, 12, 0);
// A snowflake created at 2026-09-29T17:13Z, and one from 2026-09-01.
const MSG_ID = "1554541602075316245";
const OLD_MSG_ID = String(((BigInt(Date.UTC(2026, 8, 1, 8)) - 1420070400000n) << 22n) + 1n);

let fakeGitHub: FakeGitHub;
let github: FakeRepo;
let discord: FakeDiscord;
let restore: () => void;

// Installed once per file: DO alarms keep firing in the background between tests.
beforeAll(() => {
  ({ github: fakeGitHub, discord, restore } = installFakes());
});
// Stop background alarms before the fakes go away.
afterAll(async () => {
  await abortAllDurableObjects();
  restore();
});

function events(sid: string, list: [string, unknown][], startSeq = 1): OutboxEvent[] {
  return list.map(([t, d], i) => ({ sid, s: startSeq + i, t, d: JSON.stringify(d), at: T0 + i }));
}

function guildCreate(guildId: string, extra: Record<string, unknown> = {}) {
  return {
    id: guildId,
    name: "Test server",
    icon: null,
    roles: [],
    emojis: [],
    stickers: [],
    channels: [CATEGORY, GENERAL, EXCLUDED, OTHER],
    threads: [],
    members: [{ user: { id: "999" } }],
    stage_instances: [{ topic: "leaky" }],
    ...extra,
  };
}

function message(id: string, channelId: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, channel_id: channelId, content, author: { id: "7", username: "u", avatar: "abc" }, attachments: [], embeds: [], ...extra };
}

/** Runs the guild's alarm until everything is committed. */
async function settle(guildId: string): Promise<void> {
  const stub = env.GUILD.get(env.GUILD.idFromName(guildId));
  for (let i = 0; i < 50; i++) {
    await runDurableObjectAlarm(stub);
    const st = await stub.status();
    if (st.lastError) throw new Error(`flush failed: ${st.lastError.error}`);
    if (!st.pendingLines && !st.mediaPending && !st.restCursors) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("archive did not settle");
}

/** Selects the fake repo a guild writes to (see vitest.config.ts). */
function useGuild(g: string): void {
  github = fakeGitHub.repo(`r${g}`);
  discord.messages.clear();
  discord.requests.length = 0;
}

function rawLines(files: Record<string, string>): any[] {
  return Object.keys(files)
    .filter((p) => p.startsWith("raw/"))
    .sort()
    .flatMap((p) => files[p].trimEnd().split("\n").map((l) => JSON.parse(l)));
}

describe("GuildArchive", () => {
  it("archives selected channels only, with media, into an empty repo", async () => {
    useGuild("101");
    const stub = env.GUILD.get(env.GUILD.idFromName("101"));
    await stub.ingest(
      "101",
      events("s1", [
        ["SESSION_START", { session_id: "s1" }],
        ["GUILD_CREATE", guildCreate("101")],
        ["MESSAGE_CREATE", message(MSG_ID, "11", "hello <:e:55>", { guild_id: "101", attachments: [{ id: "3", url: "https://cdn.discordapp.com/attachments/11/3/pic.png?ex=1" }] })],
        ["MESSAGE_CREATE", message("1554541602075316246", "20", "secret stuff", { guild_id: "101" })],
        ["MESSAGE_CREATE", message("1554541602075316247", "13", "excluded stuff", { guild_id: "101" })],
        ["MESSAGE_REACTION_ADD", { channel_id: "11", message_id: MSG_ID, emoji: { id: "66", name: "x" }, guild_id: "101" }],
      ]),
    );
    await settle("101");

    // The empty repo got seeded, the archive branch created, and nothing leaked.
    expect(github.files("main")["README.md"]).toContain("rejgau");
    const files = github.files("archive");
    expect(JSON.parse(files["archive.json"])).toMatchObject({ format: 1, guild_id: "101" });
    const all = Object.values(files).join("\n");
    for (const secret of ["secret stuff", "excluded stuff", "other-secret", "excluded-secret", "leaky", '"members"']) expect(all).not.toContain(secret);

    const lines = rawLines(files);
    const types = lines.map((l) => l.t);
    const order = ["SESSION_START", "GUILD_SNAPSHOT", "CHANNEL_SELECTED", "MESSAGE_CREATE"].map((t) => types.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(types).toContain("CONFIG");
    expect(lines.filter((l) => l.t === "CHANNEL_SELECTED")).toHaveLength(1);
    const selected = lines.find((l) => l.t === "CHANNEL_SELECTED").d;
    expect(selected.channel.id).toBe("11");
    expect(selected.ancestors).toMatchObject([CATEGORY]);
    const msg = lines.find((l) => l.t === "MESSAGE_CREATE");
    expect(msg).toMatchObject({ src: "gw", sid: "s1", s: 3, d: { content: "hello <:e:55>" } });
    expect(types).toContain("MESSAGE_REACTION_ADD");

    // Media: attachment, avatar and both emoji, in a release tagged on the media-root commit.
    const stored = lines.filter((l) => l.t === "MEDIA_STORED").map((l) => l.d.key).sort();
    expect(stored).toEqual(["att-3-pic.png", "avatar-7-abc.png", "emoji-55.png", "emoji-66.png"]);
    expect(github.releases.map((r) => r.tag_name)).toEqual(["media-2026-09"]);
    expect(github.refs.get("tags/media-2026-09")).toBe(github.refs.get("tags/media-root"));
    const rootCommit = github.commits.get(github.refs.get("tags/media-root")!)!;
    expect(rootCommit.parents).toEqual([]);

    // Backfill is off for guild 101: no history requests.
    expect(discord.requests.filter((r) => r.includes("/messages"))).toEqual([]);
  });

  it("ignores replayed events", async () => {
    useGuild("102");
    const stub = env.GUILD.get(env.GUILD.idFromName("102"));
    const batch = events("s1", [
      ["GUILD_CREATE", guildCreate("102")],
      ["MESSAGE_CREATE", message(MSG_ID, "11", "once", { guild_id: "102" })],
    ]);
    await stub.ingest("102", batch);
    await stub.ingest("102", batch);
    await settle("102");
    expect(rawLines(github.files("archive")).filter((l) => l.t === "MESSAGE_CREATE")).toHaveLength(1);
  });

  it("backfills history into the days messages were created", async () => {
    useGuild("103");
    discord.messages.set("11", [message(OLD_MSG_ID, "11", "old news")]);
    const stub = env.GUILD.get(env.GUILD.idFromName("103"));
    await stub.ingest("103", events("s1", [["GUILD_CREATE", guildCreate("103")]]));
    await settle("103");
    const files = github.files("archive");
    expect(files["raw/2026/09/01.jsonl"]).toContain("old news");
    const lines = rawLines(files);
    expect(lines.find((l) => l.src === "rest")).toMatchObject({ t: "MESSAGE_CREATE", d: { id: OLD_MSG_ID } });
    expect(lines.some((l) => l.t === "BACKFILL_END" && l.d.channel_id === "11")).toBe(true);
  });

  it("catches up after a new session", async () => {
    const g = "104";
    useGuild(g);
    const s = env.GUILD.get(env.GUILD.idFromName(g));
    await s.ingest(g, events("s1", [["GUILD_CREATE", guildCreate(g)], ["MESSAGE_CREATE", message(MSG_ID, "11", "live", { guild_id: g })]]));
    await settle(g);
    discord.requests.length = 0;
    // Messages posted while disconnected:
    discord.messages.set("11", [message(MSG_ID, "11", "live"), message("1554541602075316300", "11", "missed")]);
    await s.ingest(g, events("s2", [["SESSION_START", { session_id: "s2" }], ["GUILD_CREATE", guildCreate(g)]]));
    await settle(g);
    expect(discord.requests).toContain(`/api/v10/channels/11/messages?limit=100&after=${MSG_ID}`);
    const lines = rawLines(github.files("archive"));
    expect(lines.filter((l) => l.src === "rest").map((l) => l.d.content)).toEqual(["missed"]);
    expect(lines.map((l) => l.t)).toEqual(expect.arrayContaining(["CATCHUP_BEGIN", "CATCHUP_END"]));
  });

  it("builds on the admin's rewritten history instead of its own", async () => {
    const g = "105";
    useGuild(g);
    const s = env.GUILD.get(env.GUILD.idFromName(g));
    await s.ingest(g, events("s1", [["GUILD_CREATE", guildCreate(g)], ["MESSAGE_CREATE", message(MSG_ID, "11", "to be redacted", { guild_id: g })]]));
    await settle(g);
    const day = "raw/2026/09/29.jsonl";
    expect(github.files("archive")[day]).toContain("to be redacted");

    // The admin force-pushes a rewritten history without that message.
    const redacted = github.files("archive")[day].split("\n").filter((l) => !l.includes("to be redacted")).join("\n");
    github.forcePush("archive", { ...github.files("archive"), [day]: redacted });
    // …and the branch also moves once more while the bot is mid-flush.
    github.beforeRefUpdate = () => {
      const files = github.files("archive");
      github.forcePush("archive", { ...files, "README.md": "admin note" }, github.refs.get("heads/archive")!);
    };

    await s.ingest(g, events("s1", [["MESSAGE_CREATE", message("1554541602075316400", "11", "after rewrite", { guild_id: g })]], 10));
    await settle(g);
    const files = github.files("archive");
    expect(files[day]).toContain("after rewrite");
    expect(files[day]).not.toContain("to be redacted");
    expect(files["README.md"]).toBe("admin note");
  });

  it("records selection changes when a channel moves into the archived category", async () => {
    const g = "106";
    useGuild(g);
    const s = env.GUILD.get(env.GUILD.idFromName(g));
    await s.ingest(g, events("s1", [
      ["GUILD_CREATE", guildCreate(g)],
      ["CHANNEL_UPDATE", { ...OTHER, parent_id: "10", guild_id: g }],
      ["MESSAGE_CREATE", message(MSG_ID, "20", "now archived", { guild_id: g })],
      ["CHANNEL_UPDATE", { ...OTHER, parent_id: null, guild_id: g }],
      ["MESSAGE_CREATE", message("1554541602075316401", "20", "not anymore", { guild_id: g })],
    ]));
    await settle(g);
    const lines = rawLines(github.files("archive"));
    expect(lines.filter((l) => l.t.startsWith("CHANNEL_")).map((l) => `${l.t}:${l.d.channel?.id ?? l.d.id}`)).toEqual([
      "CHANNEL_SELECTED:11",
      "CHANNEL_SELECTED:20",
      "CHANNEL_UPDATE:20",
      "CHANNEL_UNSELECTED:20",
      "CHANNEL_UPDATE:20",
    ]);
    const all = JSON.stringify(lines);
    expect(all).toContain("now archived");
    expect(all).not.toContain("not anymore");
  });
});
