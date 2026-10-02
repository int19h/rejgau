import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, expect, it } from "vitest";
import worker from "../../src/index";
import { GatewayOutbox } from "../../src/gateway-outbox";
import { DiscordCooldowns } from "../../src/discord-limits";

async function settled(o: any): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!o.activeGuilds.size) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("The delivery pump did not settle.");
}

function dispatch(o: any, guild: string, seq: number): void {
  o.onDispatch("MESSAGE_CREATE", seq, { guild_id: guild, channel_id: "11", id: String(seq), content: "private test payload" });
}

afterAll(async () => { await abortAllDurableObjects(); });

it("keeps retry deadlines across traffic and restarts while other guilds progress", async () => {
  let stub = env.GATEWAY.get(env.GATEWAY.idFromName("retry-isolation"));
  const first = await runInDurableObject(stub, async (object, state) => {
    const o = object as any;
    const calls: string[] = [];
    o.env = { ...o.env, GUILD: { idFromName: (id: string) => id, get: () => ({ ingest: async (guild: string, events: unknown[]) => {
      calls.push(guild);
      return guild === "107" ? { handled: 0, failed: { retryable: true, error: "temporary outage" } } : { handled: events.length };
    } }) } };
    dispatch(o, "107", 1);
    await settled(o);
    for (let s = 2; s <= 101; s++) dispatch(o, "107", s);
    dispatch(o, "108", 102);
    await settled(o);
    const retry = state.storage.sql.exec<{ attempts: number; next_at: number }>(`SELECT attempts, next_at FROM delivery_retry WHERE guild = '107'`).one();
    expect(calls.filter((g) => g === "107")).toHaveLength(1);
    expect(calls.filter((g) => g === "108")).toHaveLength(1);
    expect(await o.status()).toMatchObject({ outbox: 101, deadLetters: 0, retryGuilds: 1 });
    expect(retry.attempts).toBe(1);
    expect(retry.next_at).toBeGreaterThan(Date.now());
    return retry;
  });
  await abortAllDurableObjects();
  stub = env.GATEWAY.get(env.GATEWAY.idFromName("retry-isolation"));
  await runInDurableObject(stub, async (object, state) => {
    const o = object as any;
    expect(state.storage.sql.exec(`SELECT attempts, next_at FROM delivery_retry WHERE guild = '107'`).one()).toEqual(first);
    o.env = { ...o.env, GUILD: { idFromName: (id: string) => id, get: () => ({ ingest: async () => ({ handled: 0, failed: { retryable: true, error: "still unavailable" } }) }) } };
    state.storage.sql.exec(`UPDATE delivery_retry SET next_at = 0 WHERE guild = '107'`);
    o.kickPump();
    await settled(o);
    expect(state.storage.sql.exec<{ attempts: number }>(`SELECT attempts FROM delivery_retry WHERE guild = '107'`).one().attempts).toBe(2);
    expect((await o.status()).deadLetters).toBe(0);
  });
});

it("defers rate limits without increasing the delivery failure count", async () => {
  const stub = env.GATEWAY.get(env.GATEWAY.idFromName("rate-deferred"));
  await runInDurableObject(stub, async (object, state) => {
    const o = object as any;
    const retryAt = Date.now() + 120_000;
    o.env = { ...o.env, GUILD: { idFromName: (id: string) => id, get: () => ({ ingest: async () => ({ handled: 0, failed: { retryable: true, retryAt, error: "rate limit" } }) }) } };
    dispatch(o, "107", 1);
    await settled(o);
    expect(state.storage.sql.exec(`SELECT attempts, next_at FROM delivery_retry`).one()).toEqual({ attempts: 0, next_at: retryAt });
  });
});

it("quarantines one guild and restores its original order through exact retry", async () => {
  const stub = env.GATEWAY.get(env.GATEWAY.idFromName("permanent-isolation"));
  const letters = await runInDurableObject(stub, async (object) => {
    const o = object as any;
    o.delivered = [];
    o.env = { ...o.env, GUILD: { idFromName: (id: string) => id, get: () => ({ ingest: async (guild: string, events: { s: number }[]) => {
      if (guild === "107") return { handled: 0, failed: { retryable: false, error: "unsupported event" } };
      o.delivered.push(...events.map((e) => [guild, e.s]));
      return { handled: events.length };
    } }) } };
    dispatch(o, "107", 1);
    await settled(o);
    dispatch(o, "107", 2);
    dispatch(o, "108", 3);
    await settled(o);
    expect(o.delivered).toEqual([["108", 3]]);
    expect(await o.status()).toMatchObject({ outbox: 1, deadLetters: 1, blockedGuilds: 1 });
    return o.listDeadLetters({ guild: "107", limit: 1 });
  });
  expect(letters.items).toHaveLength(1);
  expect(letters.items[0].canRetry).toBe(true);
  expect(Object.keys(letters.items[0]).sort()).toEqual(["canRetry", "error", "eventType", "guild", "id", "receivedAt", "sequence"]);
  expect(JSON.stringify(letters)).not.toContain("private test payload");
  expect(await stub.retryDeadLetter({ id: letters.items[0].id, guild: "108" })).toMatchObject({ requeued: false, reason: "not_found" });
  await runInDurableObject(stub, async (object) => {
    const o = object as any;
    o.env = { ...o.env, GUILD: { idFromName: (id: string) => id, get: () => ({ ingest: async (guild: string, events: { s: number }[]) => {
      o.delivered.push(...events.map((e) => [guild, e.s]));
      return { handled: events.length };
    } }) } };
    expect(await o.retryDeadLetter({ id: letters.items[0].id, guild: "107" })).toMatchObject({ requeued: true });
    await settled(o);
    expect(o.delivered).toEqual([["108", 3], ["107", 1], ["107", 2]]);
    expect(await o.status()).toMatchObject({ outbox: 0, deadLetters: 0, blockedGuilds: 0 });
  });
});

it("migrates legacy dead letters without replaying obsolete events", async () => {
  const stub = env.GATEWAY.get(env.GATEWAY.idFromName("legacy-quarantine"));
  await runInDurableObject(stub, (_object, state) => {
    state.storage.sql.exec(`DROP TABLE dead`);
    state.storage.sql.exec(`CREATE TABLE dead (n INTEGER PRIMARY KEY, guild TEXT NOT NULL, sid TEXT NOT NULL, s INTEGER NOT NULL, t TEXT NOT NULL, d TEXT NOT NULL, at INTEGER NOT NULL, error TEXT)`);
    state.storage.sql.exec(`INSERT INTO dead VALUES (7, '107', 'secret-session', 5, 'MESSAGE_CREATE', '{}', 1, 'old error')`);
    const outbox = new GatewayOutbox(state.storage);
    expect(outbox.list().items[0]).toMatchObject({ id: 7, canRetry: false });
    expect(outbox.retry({ id: 7, guild: "107" })).toMatchObject({ requeued: false, reason: "legacy" });
    expect(outbox.counts()).toMatchObject({ deadLetters: 1, blockedGuilds: 0 });
  });
});

it("preserves an explicit stop across cron and a restart", async () => {
  let stub = env.GATEWAY.get(env.GATEWAY.idFromName("main"));
  await stub.stop();
  await worker.scheduled({} as ScheduledController, env);
  expect(await stub.status()).toMatchObject({ running: "0", desiredRunning: "0" });
  await abortAllDurableObjects();
  stub = env.GATEWAY.get(env.GATEWAY.idFromName("main"));
  await stub.ensureRunning();
  expect(await stub.status()).toMatchObject({ running: "0", desiredRunning: "0" });
  await stub.ensureRunning({ clearFatal: true });
  expect(await stub.status()).toMatchObject({ running: "1", desiredRunning: "1" });
  await stub.stop();
});

it("rejects a handshake that finishes after a stop", async () => {
  const stub = env.GATEWAY.get(env.GATEWAY.idFromName("stop-handshake"));
  await runInDurableObject(stub, async (object) => {
    const o = object as any;
    const original = globalThis.fetch;
    let complete!: (value: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { complete = resolve; })) as typeof fetch;
    try {
      o.set("running", "1");
      const connect = o.openSocket();
      await o.stop();
      const pair = new WebSocketPair();
      pair[1].accept();
      complete(new Response(null, { status: 101, webSocket: pair[0] }));
      await connect;
      expect(await o.status()).toMatchObject({ connected: false, running: "0", desiredRunning: "0" });
      pair[1].close(1000, "done");
    } finally { globalThis.fetch = original; }
  });
});

it("shares bucket deadlines by major resource and persists global cooldowns", async () => {
  let stub = env.GATEWAY.get(env.GATEWAY.idFromName("cooldowns"));
  const until = Date.now() + 120_000;
  await stub.observeDiscordLimit({ path: "/channels/11/messages/101", bucket: "messages", remaining: 1 });
  await stub.observeDiscordLimit({ path: "/channels/11/messages", bucket: "messages", remaining: 0, resetAt: until });
  expect(await stub.discordCooldown("/channels/11/messages/102")).toBe(until);
  expect(await stub.discordCooldown("/channels/12/messages/102")).toBe(0);
  await stub.observeDiscordLimit({ path: "/channels/11/messages", bucket: "messages", remaining: 0, resetAt: until - 10_000 });
  expect(await stub.discordCooldown("/channels/11/messages")).toBe(until);
  await stub.observeDiscordLimit({ path: "/users/@me", global: true, retryAt: until + 1000 });
  await abortAllDurableObjects();
  stub = env.GATEWAY.get(env.GATEWAY.idFromName("cooldowns"));
  expect(await stub.discordCooldown("/guilds/108/roles")).toBe(until + 1000);
  await runInDurableObject(stub, (_object, state) => {
    const cooldowns = new DiscordCooldowns(state.storage.sql);
    expect(() => cooldowns.observe({ path: "/users/@me", global: true, retryAt: Infinity })).toThrow(/finite/);
  });
});

it("uses the earliest connection or delivery deadline without resetting retry state", async () => {
  const stub = env.GATEWAY.get(env.GATEWAY.idFromName("combined-alarm"));
  await runInDurableObject(stub, async (object, state) => {
    const o = object as any;
    const now = Date.now();
    o.set("running", "1");
    o.connectionWake(now + 41_250, "heartbeat");
    const outbox = new GatewayOutbox(state.storage);
    outbox.enqueue("107", { sid: "s", s: 1, t: "MESSAGE_CREATE", d: "{}", at: now });
    const row = outbox.batch("107")[0];
    outbox.fail(row, { retryable: true, error: "temporary" }, now);
    await o.scheduleAlarm();
    expect(await state.storage.getAlarm()).toBe(now + 5000);
    outbox.fail(row, { retryable: true, retryAt: now + 120_000, error: "rate limit" }, now);
    await o.scheduleAlarm();
    expect(await state.storage.getAlarm()).toBe(now + 41_250);
    expect(state.storage.sql.exec<{ attempts: number }>(`SELECT attempts FROM delivery_retry`).one().attempts).toBe(1);
    await o.stop();
    expect(await state.storage.getAlarm()).toBe(now + 120_000);
  });
});

it("expires stale rate-limit state while preserving aliases for active shared buckets", async () => {
  const stub = env.GATEWAY.get(env.GATEWAY.idFromName("cooldown-expiry"));
  await runInDurableObject(stub, (_object, state) => {
    const sql = state.storage.sql;
    const now = Date.now();
    const limits = new DiscordCooldowns(sql);
    limits.observe({ path: "/channels/11/messages", bucket: "shared", remaining: 0, resetAt: now + 120_000 });
    limits.observe({ path: "/channels/11/messages/1", bucket: "shared", remaining: 1 });
    limits.observe({ path: "/channels/12/messages", bucket: "other", remaining: 0, resetAt: now - 1 });
    sql.exec(`UPDATE discord_bucket SET seen_at = ?`, now - 86_400_001);
    const restarted = new DiscordCooldowns(sql);
    expect(restarted.deadlineFor("/channels/11/messages/2")).toBe(now + 120_000);
    expect(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM discord_bucket`).one().n).toBe(2);
    expect(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM discord_cooldown WHERE until_at <= ?`, now).one().n).toBe(0);
  });
});

it("starts an idle newly configured guild without repeating successful bootstrap", async () => {
  const stub = env.GATEWAY.get(env.GATEWAY.idFromName("idle-bootstrap"));
  await runInDurableObject(stub, async (object) => {
    const o = object as any;
    const started: string[] = [];
    const configuration = { guilds: { "107": { repo: "o/r107", channels: "all" } } };
    o.env = { ...o.env, REJGAU_CONFIG: JSON.stringify(configuration), GUILD: { idFromName: (id: string) => id, get: () => ({ start: async (guild: string) => { started.push(guild); return { started: true }; } }) } };
    o.set("sessionId", "existing-session");
    await o.ensureRunning();
    while (o.bootstrapping) await new Promise((resolve) => setTimeout(resolve, 1));
    o.env.REJGAU_CONFIG = JSON.stringify({ guilds: { ...configuration.guilds, "108": { repo: "o/r108", channels: "all" } } });
    await o.ensureRunning();
    while (o.bootstrapping) await new Promise((resolve) => setTimeout(resolve, 1));
    await o.ensureRunning();
    while (o.bootstrapping) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(started).toEqual(["107", "108"]);
    expect(JSON.stringify(await o.status())).not.toContain("guildStart:");
    await o.stop();
  });
});

it("preserves a future reconnect deadline after a restart", async () => {
  let stub = env.GATEWAY.get(env.GATEWAY.idFromName("reconnect-restart"));
  const until = Date.now() + 120_000;
  await runInDurableObject(stub, async (object) => {
    const o = object as any;
    o.set("running", "1");
    o.connectionWake(until, "reconnect");
    await o.scheduleAlarm();
  });
  await abortAllDurableObjects();
  stub = env.GATEWAY.get(env.GATEWAY.idFromName("reconnect-restart"));
  expect((await stub.status()).connectionWakeAt).toBe(String(until));
  await stub.stop();
});
