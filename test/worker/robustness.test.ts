// Failure-mode tests: archiving before any GUILD_CREATE, odd downloads, GitHub rate limits.

import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutboxEvent } from "../../src/env";
import { installFakes, type FakeDiscord, type FakeGitHub } from "./fakes";

let github: FakeGitHub;
let discord: FakeDiscord;
let restore: () => void;
beforeAll(() => ({ github, discord, restore } = installFakes()));
afterAll(async () => {
  await abortAllDurableObjects();
  restore();
});

const T0 = Date.UTC(2026, 8, 29, 12, 0);
const events = (sid: string, list: [string, unknown][], startSeq = 1): OutboxEvent[] =>
  list.map(([t, d], i) => ({ sid, s: startSeq + i, t, d: JSON.stringify(d), at: T0 + i }));
const message = (id: string, channelId: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, channel_id: channelId, content, author: { id: "7", username: "u" }, attachments: [], embeds: [], ...extra,
});
const stub = (g: string) => env.GUILD.get(env.GUILD.idFromName(g));

async function settle(g: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await runDurableObjectAlarm(stub(g));
    const st = await stub(g).status();
    if (st.lastError) throw new Error(`flush failed: ${st.lastError.error}`);
    if (!st.pendingLines && !st.mediaPending && !st.restCursors && !st.membersPending) return;
  }
  throw new Error("archive did not settle");
}

const committed = (g: string) => Object.values(github.repo(`r${g}`).files("archive")).join("\n");

// Channel tree served over REST: category 10 > 11, category 30 > 31, top-level 40.
const TREE = [
  { id: "10", type: 4, name: "cat-a" },
  { id: "11", type: 0, name: "in-a", parent_id: "10" },
  { id: "30", type: 4, name: "cat-excluded" },
  { id: "31", type: 0, name: "in-excluded", parent_id: "30" },
  { id: "40", type: 0, name: "top" },
];

describe("events before any GUILD_CREATE (guild added to config during a resumed session)", () => {
  beforeAll(() => {
    for (const g of ["108", "109"]) discord.guilds.set(g, { id: g, name: `guild ${g}`, channels: TREE, threads: [], members: [{ secret: 1 }] });
  });

  it("bootstraps over REST and honors category exclusion (channels: all, exclude: [30])", async () => {
    await stub("108").ingest("108", events("s9", [
      ["MESSAGE_CREATE", message("1554541602075316245", "31", "must not leak", { guild_id: "108" })],
      ["MESSAGE_CREATE", message("1554541602075316246", "11", "archived a", { guild_id: "108" })],
      ["MESSAGE_CREATE", message("1554541602075316247", "40", "archived top", { guild_id: "108" })],
    ], 50));
    await settle("108");
    const all = committed("108");
    expect(all).toContain("archived a");
    expect(all).toContain("archived top");
    expect(all).not.toContain("must not leak");
    expect(all).not.toContain("in-excluded");
    expect(all).not.toContain('"secret"');
    expect(all).toMatch(/"src":"rest","t":"GUILD_SNAPSHOT"/);
  });

  it("bootstraps over REST and honors category selection (channels: [10])", async () => {
    await stub("109").ingest("109", events("s9", [
      ["MESSAGE_CREATE", message("1554541602075316245", "11", "archived a", { guild_id: "109" })],
      ["MESSAGE_CREATE", message("1554541602075316246", "40", "not selected", { guild_id: "109" })],
    ], 50));
    await settle("109");
    const all = committed("109");
    expect(all).toContain("archived a");
    expect(all).not.toContain("not selected");
  });

  it("resolves an unknown thread's parent chain before deciding", async () => {
    discord.channels.set("32", { id: "32", type: 11, name: "thread-under-excluded", parent_id: "31" });
    discord.channels.set("12", { id: "12", type: 11, name: "thread-under-a", parent_id: "11" });
    await stub("108").ingest("108", events("s9", [
      ["MESSAGE_CREATE", message("1554541602075316300", "32", "thread must not leak", { guild_id: "108" })],
      ["MESSAGE_CREATE", message("1554541602075316301", "12", "thread archived", { guild_id: "108" })],
    ], 60));
    await settle("108");
    const all = committed("108");
    expect(all).toContain("thread archived");
    expect(all).not.toContain("thread must not leak");
  });
});

describe("media edge cases", () => {
  it("uploads the decoded size when Content-Length is missing or counts encoded bytes", async () => {
    await stub("109").ingest("109", events("s9", [
      ["MESSAGE_CREATE", message("1554541602075316400", "11", "files", {
        guild_id: "109",
        attachments: [
          { id: "91", url: "https://cdn.discordapp.com/attachments/11/91/nolength.png" },
          { id: "92", url: "https://cdn.discordapp.com/attachments/11/92/gzipped.png" },
        ],
      })],
    ], 70));
    await settle("109");
    const assets = github.repo("r109").releases.flatMap((r) => r.assets);
    expect(assets.map((a) => [a.name, a.size]).sort()).toEqual([["att-91-nolength.png", 10], ["att-92-gzipped.png", 10]]);
  });

  it("handles downloads without a usable Content-Length, and rate limits without failing items", async () => {
    github.repo("r108").rateLimitUploads = 1;
    await stub("108").ingest("108", events("s9", [
      ["MESSAGE_CREATE", message("1554541602075316400", "40", "files", {
        guild_id: "108",
        attachments: [
          { id: "91", url: "https://cdn.discordapp.com/attachments/40/91/nolength.png" },
          { id: "92", url: "https://cdn.discordapp.com/attachments/40/92/gzipped.png" },
        ],
      })],
    ], 70));
    // The first upload hits the (fake) secondary rate limit: nothing fails, the guild backs off.
    for (let i = 0; i < 5; i++) await runDurableObjectAlarm(stub("108"));
    const st = await stub("108").status();
    expect(st.githubBackoffUntil).not.toBeNull();
    expect(st.mediaFailed).toBe(0);
    expect(st.mediaPending).toBe(2);
    expect(github.repo("r108").releases.flatMap((r) => r.assets)).toEqual([]);
  });
});

describe("failure classification", () => {
  it("reports a transient failure with how far it got, and succeeds on retry", async () => {
    discord.channels.set("33", { id: "33", type: 11, name: "thread-flaky", parent_id: "11" });
    discord.failures.set("/api/v10/channels/33", 503);
    const batch = events("s9", [
      ["MESSAGE_CREATE", message("1554541602075316500", "11", "before flaky", { guild_id: "109" })],
      ["MESSAGE_CREATE", message("1554541602075316501", "33", "in flaky thread", { guild_id: "109" })],
    ], 80);
    const first = await stub("109").ingest("109", batch);
    expect(first).toMatchObject({ handled: 1, failed: { retryable: true } });
    discord.failures.delete("/api/v10/channels/33");
    // The pump resends from the failing event.
    expect(await stub("109").ingest("109", batch.slice(first.handled))).toEqual({ handled: 1 });
    await settle("109");
    expect(committed("109")).toContain("in flaky thread");
    expect(committed("109").match(/before flaky/g)).toHaveLength(1);
  });

  it("drops events (fail closed) and reports why when bootstrap is refused for good", async () => {
    discord.failures.set("/api/v10/guilds/102", 403);
    const result = await stub("102").ingest("102", events("s9", [["MESSAGE_CREATE", message("1554541602075316600", "11", "unknowable", { guild_id: "102" })]], 90));
    expect(result).toEqual({ handled: 1 });
    expect((await stub("102").status()).bootstrapError).toMatch(/403/);
    discord.failures.delete("/api/v10/guilds/102");
  });
});

describe("reset", () => {
  it("wipes buffered lines and state for good, and starts again without waiting for an event", async () => {
    await stub("109").setPaused(true); // keep the line buffered (background alarms would commit it)
    await stub("109").ingest("109", events("s9", [["MESSAGE_CREATE", message("1554541602075316700", "11", "buffered before reset", { guild_id: "109" })]], 100));
    expect((await stub("109").status()).pendingLines).toBeGreaterThan(0);
    await stub("109").reset().catch(() => {}); // the object aborts itself after wiping
    const st = await stub("109").status();
    expect(st).toMatchObject({ paused: false, pendingLines: 0, selectedChannels: 0, lastCommit: null });
    await runDurableObjectAlarm(stub("109"));
    expect(committed("109")).not.toContain("buffered before reset");

    const snapshots = () => committed("109").match(/"t":"GUILD_SNAPSHOT"/g)?.length ?? 0;
    const before = snapshots();
    expect(await stub("109").start("109")).toEqual({ started: true });
    expect(await stub("109").flushNow("109")).toMatchObject({ committed: expect.any(Number) });
    expect(snapshots()).toBe(before + 1);
    expect(committed("109")).toMatch(/"t":"CHANNEL_SELECTED".*"id":"11"/);

    await stub("109").ingest("109", events("s10", [["MESSAGE_CREATE", message("1554541602075316701", "11", "after reset", { guild_id: "109" })]], 1));
    await settle("109");
    expect(committed("109")).toContain("after reset");
    expect(snapshots()).toBe(before + 1);
  });
});

describe("permission refresh failures", () => {
  const VIEW = String(1 << 10);
  const tree = [
    { id: "10", type: 4, name: "cat-a" },
    { id: "11", type: 0, name: "open", parent_id: "10" },
    { id: "12", type: 0, name: "closed", parent_id: "10", permission_overwrites: [{ id: "111", type: 0, allow: "0", deny: VIEW }] },
  ];

  it("retry the whole batch while permissions are unknown (and Discord is failing), instead of failing an event", async () => {
    discord.guilds.set("111", { id: "111", name: "g", roles: [{ id: "111", permissions: VIEW }], channels: tree, threads: [] });
    discord.failures.set("/api/v10/guilds/111/roles", 503);
    const batch = events("s9", [["MESSAGE_CREATE", message("1554541602075316800", "11", "kept", { guild_id: "111" })]], 200);
    expect(await stub("111").ingest("111", batch)).toMatchObject({ handled: 0, failed: { retryable: true } });
    discord.failures.delete("/api/v10/guilds/111/roles");
    expect(await stub("111").ingest("111", batch)).toEqual({ handled: 1 });
    await settle("111");
    expect(committed("111")).toContain("kept");
    expect(committed("111")).not.toContain('"closed"');
  });

  it("keep the known permissions when a refresh fails, without holding up events", async () => {
    discord.failures.set("/api/v10/guilds/111/roles", 403);
    const before = discord.requests.filter((r) => r.endsWith("/guilds/111/roles")).length;
    // An event from a channel believed hidden forces a refresh, which fails: it's logged, not fatal.
    const result = await stub("111").ingest("111", events("s9", [
      ["MESSAGE_CREATE", message("1554541602075316801", "12", "from closed", { guild_id: "111" })],
      ["MESSAGE_CREATE", message("1554541602075316802", "11", "still archived", { guild_id: "111" })],
      ["MESSAGE_CREATE", message("1554541602075316803", "12", "again", { guild_id: "111" })],
    ], 201));
    expect(result).toEqual({ handled: 3 });
    expect(discord.requests.filter((r) => r.endsWith("/guilds/111/roles")).length - before).toBe(1);
    discord.failures.delete("/api/v10/guilds/111/roles");
    await settle("111");
    expect(committed("111")).toContain("still archived");
    expect(committed("111")).not.toContain("from closed");
  });
});

describe("a guild whose permissions are refused for good", () => {
  it("doesn't hold up the pump: its batches are dropped and the error reported, then retried later", async () => {
    // E.g. a configured guild the bot isn't in: every batch is just session markers.
    discord.failures.set("/api/v10/guilds/112/roles", 404);
    const marker = events("s9", [["SESSION_RESUMED", {}]], 300);
    expect(await stub("112").ingest("112", marker)).toEqual({ handled: 1 });
    expect((await stub("112").status()).permissionsError).toMatch(/404/);
    const calls = discord.requests.filter((r) => r.endsWith("/guilds/112/roles")).length;
    // Within the wait, no new attempts (and still no failure reported to the pump).
    expect(await stub("112").ingest("112", events("s9", [["SESSION_RESUMED", {}]], 301))).toEqual({ handled: 1 });
    expect(discord.requests.filter((r) => r.endsWith("/guilds/112/roles")).length).toBe(calls);
    discord.failures.delete("/api/v10/guilds/112/roles");
  });
});
