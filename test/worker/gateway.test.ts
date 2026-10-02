import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { INTENTS } from "../../src/gateway";
import { installFakes, type FakeGateway, type FakeGitHub } from "./fakes";

let gateway: FakeGateway;
let github: FakeGitHub;
let restore: () => void;
beforeAll(() => ({ gateway, github, restore } = installFakes()));
// Stop background alarms before the fakes go away.
afterAll(async () => {
  await abortAllDurableObjects();
  restore();
});

async function until(cond: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

it("identifies, forwards configured guilds' events through the outbox, and resumes after a drop", async () => {
  gateway.dispatches = [
    ["GUILD_CREATE", { id: "107", name: "g", channels: [{ id: "11", type: 0, parent_id: "10" }, { id: "10", type: 4 }], threads: [] }],
    ["GUILD_CREATE", { id: "999", name: "not configured", channels: [], threads: [] }],
    ["MESSAGE_CREATE", { id: "1554541602075316245", channel_id: "11", guild_id: "107", content: "hi", author: { id: "7" } }],
  ];
  const gw = env.GATEWAY.get(env.GATEWAY.idFromName("main"));
  await gw.ensureRunning();
  await runInDurableObject(gw, (object) => { (object as any).set("connectionWakeAt", "0"); });
  await runDurableObjectAlarm(gw);

  await until(() => gateway.identifies.length === 1, "IDENTIFY");
  expect(gateway.identifies[0]).toMatchObject({ token: "discord-token", intents: INTENTS });

  const guild = env.GUILD.get(env.GUILD.idFromName("107"));
  await until(async () => (await gw.status()).seq === "4" && (await gw.status()).outbox === 0, "outbox drained");
  // The guild's flush interval is ~0 in tests, so its events land in the (fake) repo right away.
  const committed = () => Object.values(github.repo("r107").files("archive")).join("\n");
  await until(async () => (await runDurableObjectAlarm(guild), committed().includes('"content":"hi"')), "events archived");
  for (const t of ["SESSION_START", "GUILD_SNAPSHOT", "CHANNEL_SELECTED", "MESSAGE_CREATE"]) expect(committed()).toContain(`"t":"${t}"`);
  expect(committed()).not.toContain("not configured");
  // Guild 999 isn't configured: nothing was ever created for it.
  expect((await env.GUILD.get(env.GUILD.idFromName("999")).status()).pendingLines).toBe(0);

  // The connection drops without a clean close: the alarm reconnects and RESUMEs from seq 4.
  // (The fake's socket belongs to the GatewaySession's I/O context, so close it from there.)
  await runInDurableObject(gw, () => gateway.server!.close(4000, "test drop"));
  await until(async () => !(await gw.status()).connected, "disconnect noticed");
  await runInDurableObject(gw, (object) => { (object as any).set("connectionWakeAt", "0"); });
  await runDurableObjectAlarm(gw);
  await until(() => gateway.resumes.length === 1, "RESUME");
  expect(gateway.resumes[0]).toEqual({ token: "discord-token", session_id: "sess-1", seq: 4 });
  expect(gateway.urls.at(-1)).toMatch(/^https:\/\/gateway-resume\.discord\.gg\/\?v=10&encoding=json$/);

  await gw.stop();
});
