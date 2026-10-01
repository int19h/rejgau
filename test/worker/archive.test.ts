import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutboxEvent } from "../../src/env";
import { publicSessionId } from "../../src/sanitize";
import { installFakes, type FakeDiscord, type FakeGitHub, type FakeRepo } from "./fakes";

// Config (see vitest.config.ts): channels ["10"] (a category), exclude ["13"]; backfill off for 101.
const CATEGORY = { id: "10", type: 4, name: "Archived category" };
const GENERAL = { id: "11", type: 0, name: "general", parent_id: "10", last_message_id: "1554541602075316245" };
const EXCLUDED = { id: "13", type: 0, name: "excluded-secret", parent_id: "10" };
const OTHER = { id: "20", type: 0, name: "other-secret" };

const T0 = Date.UTC(2026, 8, 29, 12, 0);
const VIEW_CHANNEL = 1 << 10;
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
    roles: [{ id: guildId, name: "@everyone", permissions: String(VIEW_CHANNEL) }],
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
    if (!st.pendingLines && !st.mediaPending && !st.restCursors && !st.membersPending) return;
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

/** All raw lines in time order (a day's guild.jsonl first on ties, as the reader build does). */
function rawLines(files: Record<string, string>): any[] {
  const key = (p: string) => p.replace(/\/guild\.jsonl$/, "/!guild.jsonl");
  return Object.keys(files)
    .filter((p) => p.startsWith("raw/"))
    .sort((a, b) => (key(a) < key(b) ? -1 : 1))
    .flatMap((p) => files[p].trimEnd().split("\n").map((l) => JSON.parse(l)))
    .map((l, i) => ({ l, i }))
    .sort((a, b) => Date.parse(a.l.at) - Date.parse(b.l.at) || a.i - b.i)
    .map((x) => x.l);
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
    expect(msg).toMatchObject({ src: "gw", sid: publicSessionId("s1"), s: 3, d: { content: "hello <:e:55>" } });
    expect(all).not.toContain('"s1"'); // real session IDs are never published
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
    // Guild 102 has "pages": true: the Pages workflow was notified once.
    expect(github.dispatches).toEqual(["archive-updated"]);
  });

  it("backfills history into the days messages were created, with members snapshotted", async () => {
    useGuild("103");
    discord.messages.set("11", [message(OLD_MSG_ID, "11", "old news"), message(String(BigInt(OLD_MSG_ID) + 1n), "11", "from someone who left", { author: { id: "8", username: "gone" } })]);
    discord.members.set("7", {
      user: { id: "7", username: "u", discriminator: "0", flags: 123 },
      nick: "Nick", roles: ["5"], joined_at: "2024-01-01T00:00:00Z", premium_since: null, avatar: null,
      communication_disabled_until: "2030-01-01T00:00:00Z", mute: true, deaf: false, flags: 2, unusual_dm_activity_until: "x",
    });
    const stub = env.GUILD.get(env.GUILD.idFromName("103"));
    await stub.ingest("103", events("s1", [["GUILD_CREATE", guildCreate("103")]]));
    await settle("103");
    const files = github.files("archive");
    expect(files["raw/2026/09/01/11.jsonl"]).toContain("old news");
    const lines = rawLines(files);
    expect(lines.find((l) => l.src === "rest")).toMatchObject({ t: "MESSAGE_CREATE", d: { id: OLD_MSG_ID } });
    expect(lines.some((l) => l.t === "BACKFILL_END" && l.d.channel_id === "11")).toBe(true);
    const snaps = Object.fromEntries(lines.filter((l) => l.t === "MEMBER_SNAPSHOT").map((l) => [l.d.user_id, l.d.member]));
    expect(snaps).toEqual({
      "7": { user: { id: "7", username: "u", discriminator: "0" }, nick: "Nick", roles: ["5"], joined_at: "2024-01-01T00:00:00Z", premium_since: null, avatar: null },
      "8": null,
    });
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
    const day = "raw/2026/09/29/11.jsonl";
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

describe("channels the bot can't view", () => {
  it("are never selected or named, and become archived when the bot gains access", async () => {
    const g = "110";
    useGuild(g);
    const SECRET = {
      id: "12", type: 0, name: "mods-only", topic: "secret topic", parent_id: "10",
      permission_overwrites: [
        { id: g, type: 0, allow: "0", deny: String(VIEW_CHANNEL) },
        { id: "77", type: 0, allow: String(VIEW_CHANNEL), deny: "0" },
      ],
    };
    const roles = [{ id: g, name: "@everyone", permissions: String(VIEW_CHANNEL) }, { id: "77", name: "mods", permissions: "0" }];
    const s = env.GUILD.get(env.GUILD.idFromName(g));
    await s.ingest(g, events("s1", [["GUILD_CREATE", guildCreate(g, { channels: [CATEGORY, GENERAL, SECRET], roles })]]));
    await settle(g);
    let all = Object.values(github.files("archive")).join("\n");
    expect(all).toContain('"name":"general"');
    expect(all).not.toContain("mods-only");
    expect(all).not.toContain("secret topic");
    expect(await s.status()).toMatchObject({ permissionsKnown: true, hiddenChannels: 1 });

    // The bot is given the mods role: the channel becomes visible and is selected from then on.
    await s.ingest(g, events("s1", [["GUILD_MEMBER_UPDATE", { guild_id: g, user: { id: discord.botId }, roles: ["77"] }]], 10));
    await settle(g);
    all = Object.values(github.files("archive")).join("\n");
    expect(rawLines(github.files("archive")).filter((l) => l.t === "CHANNEL_SELECTED").map((l) => l.d.channel.id)).toEqual(["11", "12"]);
    expect(await s.status()).toMatchObject({ hiddenChannels: 0 });

    // A role change that removes access unselects it again.
    await s.ingest(g, events("s1", [["GUILD_ROLE_UPDATE", { guild_id: g, role: { id: g, name: "@everyone", permissions: "0" } }]], 20));
    await settle(g);
    const unselected = rawLines(github.files("archive")).filter((l) => l.t === "CHANNEL_UNSELECTED").map((l) => l.d.id);
    expect(unselected).toEqual(["11"]); // the mods role still grants #mods-only
  });

  it("files lines per channel per day, with server-wide records in guild.jsonl", () => {
    const files = github.files("archive");
    const raw = Object.keys(files).filter((p) => p.startsWith("raw/"));
    expect(raw).toContain("raw/2026/09/29/guild.jsonl");
    for (const path of raw) {
      const scope = /^raw\/\d{4}\/\d{2}\/\d{2}\/(\d+|guild)\.jsonl$/.exec(path)?.[1];
      expect(scope, path).toBeDefined();
      for (const line of files[path].trimEnd().split("\n").map((l) => JSON.parse(l))) {
        const concerns = line.t === "CHANNEL_SELECTED" ? line.d.channel.id : line.t === "CHANNEL_UNSELECTED" ? line.d.id : line.d.channel_id;
        expect(`${line.t}:${concerns ?? "guild"}`).toBe(`${line.t}:${scope}`);
      }
    }
  });
});
