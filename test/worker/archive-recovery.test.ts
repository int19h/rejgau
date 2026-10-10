import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GitHub } from "../../src/github";
import { RequestTimeoutError } from "../../src/http";
import { parseConfig } from "../../src/config";
import { MAX_FLUSH_BYTES, MAX_COMMIT_BYTES } from "../../src/archive-committer";
import { initializeArchiveStorage, readPendingBatch } from "../../src/archive-storage";
import { installFakes, type FakeDiscord, type FakeGitHub } from "./fakes";

let github: FakeGitHub, discord: FakeDiscord, restore: () => void;
beforeAll(() => { ({ github, discord, restore } = installFakes()); });
afterAll(async () => { await abortAllDurableObjects(); restore(); });
const GUILD = "109";
const MESSAGE = "1554541602075316400";
const stub = () => env.GUILD.get(env.GUILD.idFromName(GUILD));
const category = { id: "10", type: 4, name: "category" };
const channel = { id: "11", type: 0, parent_id: "10", name: "public" };
const event = (s: number, t: string, d: unknown) => ({ sid: "audit", s, t, d: JSON.stringify(d), at: Date.now() });
const message = (extra: Record<string, unknown> = {}) => ({ id: MESSAGE, channel_id: "11", guild_id: GUILD, content: "audit-message", author: { id: "7", username: "audit" }, attachments: [], embeds: [], ...extra });
const conf = () => parseConfig(env.REJGAU_CONFIG);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
async function initialize(extra: Record<string, unknown> = {}) {
  await stub().reset();
  github.repos.delete("r109");
  discord.failures.clear();
  discord.guilds.set(GUILD, { id: GUILD, name: "audit", channels: [category, channel], threads: [] });
  await stub().setPaused(true);
  await stub().ingest(GUILD, [event(1, "MESSAGE_CREATE", message(extra))]);
}
const attachment = { id: "91", url: "https://cdn.discordapp.com/attachments/11/91/expired.png" };

it("retries a transient failure while refreshing an expired attachment", async () => {
  await initialize({ attachments: [attachment] });
  discord.failures.set("/attachments/11/91/expired.png", 403);
  discord.failures.set(`/api/v10/channels/11/messages/${MESSAGE}`, 503);
  await runInDurableObject(stub(), async (instance, ctx) => {
    await (instance as any).media.work(conf(), conf().guilds.get(GUILD));
    const row = ctx.storage.sql.exec<{ status: string; attempts: number; next_at: number }>("SELECT status, attempts, next_at FROM media").one();
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row.next_at).toBeGreaterThan(Date.now());
  });
  expect(await stub().status()).toMatchObject({ mediaFailed: 0, mediaPending: 1 });
});

it("commits due logs before waiting for an external image and drains before pause success", async () => {
  await initialize({ embeds: [{ image: { url: "https://slow.example/image.png" } }] });
  await runInDurableObject(stub(), async (instance, ctx) => {
    const original = globalThis.fetch;
    const entered = deferred(), response = deferred();
    let pauseDone = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://slow.example/image.png") {
        expect(init?.signal).toBeDefined();
        entered.resolve();
        await response.promise;
        return new Response("image", { headers: { "content-type": "image/png", "content-length": "5" } });
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      (instance as any).set("paused", null);
      (instance as any).set("dirtySince", String(Date.now() - 10000));
      const alarm = instance.alarm();
      await entered.promise;
      expect(Object.values(github.repo("r109").files("archive")).join("\n")).toContain("audit-message");
      const pause = instance.setPaused(true).then(() => { pauseDone = true; });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await instance.status()).paused).toBe(true);
      expect(pauseDone).toBe(false);
      response.resolve();
      await Promise.all([alarm, pause]);
      expect(pauseDone).toBe(true);
      expect((await instance.flushNow(GUILD)).complete).toBe(true);
    } finally { globalThis.fetch = original; response.resolve(); }
  });
});

it("waits for an active GitHub write before acknowledging pause or resetting state", async () => {
  await initialize();
  await runInDurableObject(stub(), async (instance, ctx) => {
    const original = globalThis.fetch;
    const entered = deferred(), response = deferred();
    let pauseDone = false, resetDone = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/repos/o/r109/git/ref/heads/archive")) {
        entered.resolve();
        await response.promise;
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      const flush = instance.flushNow(GUILD);
      await entered.promise;
      const pause = instance.setPaused(true).then(() => { pauseDone = true; });
      const reset = instance.reset().then(() => { resetDone = true; });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(pauseDone).toBe(false);
      expect(resetDone).toBe(false);
      response.resolve();
      await Promise.all([flush, pause, reset]);
      expect(await instance.status()).toMatchObject({ pendingLines: 0, selectedChannels: 0, lastCommit: null });
    } finally { globalThis.fetch = original; response.resolve(); }
  });
});

it("bounds queue iteration by UTF-8 bytes without materializing the backlog", async () => {
  await initialize();
  await runInDurableObject(stub(), async (instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec("DELETE FROM pending");
    for (let n = 0; n < 3000; n++) sql.exec("INSERT INTO pending(path,line,at) VALUES(?,?,?)", "raw/2026/10/02/11.jsonl", "x".repeat(4096), Date.now());
    const batch = readPendingBatch(sql, MAX_FLUSH_BYTES, 40);
    expect(batch.byPath.get("raw/2026/10/02/11.jsonl")).toHaveLength(Math.floor(MAX_FLUSH_BYTES / 4097));
    expect(batch.bytes).toBeLessThanOrEqual(MAX_FLUSH_BYTES);
    sql.exec("DELETE FROM pending");
    sql.exec("INSERT INTO pending(path,line,at) VALUES(?,?,?)", "a", "😀😀", Date.now());
    sql.exec("INSERT INTO pending(path,line,at) VALUES(?,?,?)", "b", "ok", Date.now());
    const small = readPendingBatch(sql, 8, 40);
    expect(small.oversized).toHaveLength(1);
    expect(small.byPath.get("b")).toHaveLength(1);
    expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n).toBe(2);
  });
});

it("preserves an oversized existing path while draining other paths and reporting an incomplete flush", async () => {
  await initialize();
  const large = "raw/2026/10/02/11.jsonl", small = "raw/2026/10/02/12.jsonl";
  github.repo("r109").forcePush("archive", { [large]: "x".repeat(MAX_COMMIT_BYTES), "archive.json": "{}" });
  await runInDurableObject(stub(), async (instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec("DELETE FROM pending");
    sql.exec("INSERT INTO pending(path,line,at) VALUES(?,?,?)", large, "preserve-me", Date.now());
    sql.exec("INSERT INTO pending(path,line,at) VALUES(?,?,?)", small, "publish-me", Date.now());
    const result = await instance.flushNow(GUILD);
    expect(result).toMatchObject({ committed: 1, remaining: 1, complete: false });
    expect(result.error).toContain("incomplete");
    expect(github.repo("r109").files("archive")[small]).toBe("publish-me\n");
    expect(sql.exec<{ line: string }>("SELECT line FROM pending").one().line).toBe("preserve-me");
    expect((await instance.status()).blockedPaths[0]).toMatchObject({ path: large });
    (instance as any).set("paused", null);
    await (instance as any).scheduleAlarm();
    expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now() + 60_000);
    (instance as any).set("paused", "1");
  });
});

it("drains only the rows captured by an explicit flush", async () => {
  await initialize();
  await runInDurableObject(stub(), async (instance, ctx) => {
    const original = globalThis.fetch;
    const entered = deferred(), response = deferred();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/repos/o/r109/git/ref/heads/archive")) { entered.resolve(); await response.promise; }
      return original(input, init);
    }) as typeof fetch;
    try {
      const flush = instance.flushNow(GUILD);
      await entered.promise;
      ctx.storage.sql.exec("INSERT INTO pending(path,line,at) VALUES(?,?,?)", "raw/2026/10/02/11.jsonl", "later-row", Date.now());
      response.resolve();
      expect(await flush).toMatchObject({ remaining: 0, complete: true });
      expect(ctx.storage.sql.exec<{ line: string }>("SELECT line FROM pending").one().line).toBe("later-row");
    } finally { globalThis.fetch = original; response.resolve(); }
  });
});

it("rebuilds release ownership after a repository change and ignores legacy cache entries", async () => {
  await initialize({ attachments: [attachment] });
  await runInDurableObject(stub(), async (instance, ctx) => {
    const archive = instance as any;
    const old = conf().guilds.get(GUILD)!;
    await archive.media.work(conf(), old);
    const oldRelease = github.repo("r109").releases[0];
    archive.set("releaseId:media-2026-09", String(oldRelease.id));
    archive.set("releaseCount:media-2026-09", "1");
    const next = { ...old, repo: "o/new-destination" };
    const result = await archive.media.release(archive.gh(next), "2026-09", "new.png");
    expect(result.id).toBe(github.repo("new-destination").releases[0].id);
    expect(github.repo("new-destination").requests).toContain("POST /repos/o/r/releases");
    expect(github.repo("new-destination").releases).toHaveLength(1);
    expect(archive.get("releaseId:o/new-destination:media-2026-09")).toBe(String(result.id));
  });
});

it("reconciles a full release and reuses a completed upload after a lost response", async () => {
  await initialize({ attachments: [attachment] });
  await runInDurableObject(stub(), async (instance, ctx) => {
    const archive = instance as any;
    const guild = conf().guilds.get(GUILD)!;
    await archive.media.work(conf(), guild);
    const release = github.repo("r109").releases[0];
    const existing = release.assets[0];
    for (let n = release.assets.length; n < 1000; n++) release.assets.push({ ...existing, id: n + 10000, name: `other-${n}.png` });
    archive.set("releaseCount:o/r109:media-2026-09", "0");
    const reused = await archive.media.release(archive.gh(guild), "2026-09", existing.name);
    expect(reused.asset.name).toBe(existing.name);
    expect(reused.tag).toBe("media-2026-09");
    const next = await archive.media.release(archive.gh(guild), "2026-09", "new.png");
    expect(next.tag).toBe("media-2026-09.2");
    expect(archive.get("releaseCount:o/r109:media-2026-09")).toBe("1000");
  });
});

it("unselects missing snapshot channels but preserves an absent archived thread", async () => {
  await initialize();
  await stub().ingest(GUILD, [event(2, "THREAD_CREATE", { id: "12", type: 11, parent_id: "11", name: "thread", newly_created: true })]);
  await stub().ingest(GUILD, [event(3, "GUILD_CREATE", { id: GUILD, channels: [category, channel], threads: [] })]);
  expect((await stub().status()).selectedChannels).toBe(2);
  await stub().ingest(GUILD, [event(4, "GUILD_CREATE", { id: GUILD, channels: [category], threads: [] }), event(5, "MESSAGE_CREATE", message({ content: "must-not-publish" }))]);
  expect((await stub().status()).selectedChannels).toBe(0);
  await runInDurableObject(stub(), async (instance, ctx) => {
    const content = ctx.storage.sql.exec<{ line: string }>("SELECT line FROM pending").toArray().map((row) => row.line).join("\n");
    expect(content).not.toContain("must-not-publish");
  });
  await stub().ingest(GUILD, [event(6, "CHANNEL_UPDATE", channel)]);
  expect((await stub().status()).selectedChannels).toBe(2);
});

it("adds snapshot state and queue indexes without losing legacy rows", async () => {
  await initialize();
  await runInDurableObject(stub(), async (instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec("ALTER TABLE channels DROP COLUMN missing");
    initializeArchiveStorage(sql);
    initializeArchiveStorage(sql);
    expect(sql.exec<{ id: string; missing: number }>("SELECT id, missing FROM channels WHERE id = '11'").one()).toEqual({ id: "11", missing: 0 });
    const indexes = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").toArray().map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["media_due", "members_pending", "channels_due"]));
    expect((await instance.status()).pendingLines).toBeGreaterThan(0);
  });
});

it("does not bootstrap a paused guild when the recovery sweep calls start", async () => {
  await stub().reset();
  await stub().setPaused(true);
  const before = discord.requests.length;
  expect(await stub().start(GUILD)).toEqual({ started: false, paused: true });
  expect(discord.requests).toHaveLength(before);
});


it("aborts both an upload request and its stalled input stream", async () => {
  const original = globalThis.fetch;
  let canceled = false;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://uploads.github.com/")) {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const client = new GitHub(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!, "o/r109", 20);
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { canceled = true; },
    });
    await expect(client.uploadAsset(1, "slow.bin", "application/octet-stream", 2, source)).rejects.toBeInstanceOf(RequestTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signal?.aborted).toBe(true);
    expect(canceled).toBe(true);
  } finally { globalThis.fetch = original; }
});

it.each([422, 500])("cancels an unfinished source after an early upload response (%s)", async (status) => {
  const original = globalThis.fetch;
  let canceled = false;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://uploads.github.com/")) {
      signal = init?.signal ?? undefined;
      return Response.json({ errors: [{ code: "already_exists" }] }, { status });
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const client = new GitHub(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!, "o/r109", 100);
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { canceled = true; },
    });
    if (status === 422) expect(await client.uploadAsset(1, "early.bin", "application/octet-stream", 2, source)).toBeNull();
    else await expect(client.uploadAsset(1, "early.bin", "application/octet-stream", 2, source)).rejects.toThrow("500");
    expect(signal?.aborted).toBe(true);
    expect(canceled).toBe(true);
  } finally { globalThis.fetch = original; }
});

it("reports an incomplete drain when the explicit flush reaches its batch limit", async () => {
  await initialize();
  await runInDurableObject(stub(), async (instance, ctx) => {
    ctx.storage.sql.exec("DELETE FROM pending");
    for (let n = 0; n < 801; n++) ctx.storage.sql.exec("INSERT INTO pending(path,line,at) VALUES(?,?,?)", `raw/2026/10/02/${n}.jsonl`, "row", Date.now());
    expect(await instance.flushNow(GUILD)).toMatchObject({ committed: 800, remaining: 1, complete: false });
    expect(await instance.flushNow(GUILD)).toMatchObject({ committed: 1, remaining: 0, complete: true });
  });
});

it("defers media, REST, members, and ingest at the shared Discord deadline without failed attempts", async () => {
  await initialize({ attachments: [attachment] });
  discord.failures.set("/attachments/11/91/expired.png", 403);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith(`/channels/11/messages/${MESSAGE}`)) {
      return Response.json({ retry_after: 120, global: true }, { status: 429 });
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    await runInDurableObject(stub(), async (instance, ctx) => {
      const archive = instance as any;
      const guild = conf().guilds.get(GUILD)!;
      const before = Date.now();
      await archive.media.work(conf(), guild);
      const media = ctx.storage.sql.exec<{ attempts: number; next_at: number; status: string }>("SELECT attempts, next_at, status FROM media").one();
      expect(media).toMatchObject({ attempts: 0, status: "pending" });
      expect(media.next_at).toBeGreaterThanOrEqual(before + 120000);
      ctx.storage.sql.exec("UPDATE channels SET cursor = '0', cursor_kind = 'backfill', rest_next_at = 0 WHERE id = '11'");
      await archive.restWork(guild);
      const channel = ctx.storage.sql.exec<{ rest_failures: number; rest_next_at: number }>("SELECT rest_failures, rest_next_at FROM channels WHERE id = '11'").one();
      expect(channel).toEqual({ rest_failures: 0, rest_next_at: media.next_at });
      ctx.storage.sql.exec("INSERT INTO members(user_id) VALUES('7')");
      await archive.memberWork(guild);
      expect(Number(archive.get("memberRetryAt"))).toBe(media.next_at);
      const result = await instance.ingest(GUILD, [event(2, "MESSAGE_CREATE", message({ channel_id: "99" }))]);
      expect(result).toMatchObject({ handled: 0, failed: { retryable: true, retryAt: media.next_at } });
    });
  } finally { globalThis.fetch = original; }
});
