import { expect, it, vi } from "vitest";
import { handleAdmin } from "../../src/admin";
import type { Env } from "../../src/env";

function fixture() {
  const guilds = new Map<string, ReturnType<typeof guild>>();
  function guild() {
    return {
      status: vi.fn(async () => ({ pendingLines: 0 })),
      reset: vi.fn(async () => {}),
      start: vi.fn(async () => ({ started: true })),
      flushNow: vi.fn(async () => ({ committed: 2, remaining: 0, complete: true })),
      setPaused: vi.fn(async (_paused: boolean) => {}),
      retryFailedMedia: vi.fn(async () => ({ retried: 0 })),
    };
  }
  for (const id of ["101", "102"]) guilds.set(id, guild());
  const gateway = {
    status: vi.fn(async () => ({ connected: true })),
    ensureRunning: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    listDeadLetters: vi.fn(async () => ({ items: [], next: null })),
    retryDeadLetter: vi.fn(async () => ({ requeued: false, reason: "legacy", error: "Legacy events need manual recovery." })),
  };
  const getGuild = vi.fn((id: string) => guilds.get(id));
  const env = {
    ADMIN_KEY: "test-admin-key",
    REJGAU_CONFIG: JSON.stringify({ guilds: { "101": { repo: "o/r101", channels: "all" }, "102": { repo: "o/r102", channels: "all" } } }),
    GATEWAY: { idFromName: (name: string) => name, get: () => gateway },
    GUILD: { idFromName: (name: string) => name, get: getGuild },
  } as unknown as Env;
  const request = (path: string, method = "POST", key = "test-admin-key") =>
    handleAdmin(new Request(`https://admin.example${path}`, { method, headers: { Authorization: `Bearer ${key}` } }), env);
  return { env, guilds, gateway, getGuild, request };
}

it("hides routes from callers without the key and rejects mutation through GET", async () => {
  const f = fixture();
  expect((await f.request("/reset?guild=101", "POST", "wrong")).status).toBe(404);
  const response = await f.request("/reset?guild=101", "GET");
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST");
  expect(f.getGuild).not.toHaveBeenCalled();
});

it("returns HTTP 503 for a partial flush and still flushes the other guilds", async () => {
  const f = fixture();
  f.guilds.get("101")!.flushNow.mockResolvedValue({ committed: 1, remaining: 5, complete: false });
  const response = await f.request("/flush");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    "101": { committed: 1, remaining: 5, complete: false },
    "102": { committed: 2, remaining: 0, complete: true },
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("reports a failed flush without skipping other configured guilds", async () => {
  const f = fixture();
  f.guilds.get("101")!.flushNow.mockRejectedValue(new Error("GitHub write failed"));
  const response = await f.request("/flush");
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ "101": { error: "GitHub write failed" }, "102": { complete: true } });
});

it("waits for the pause barrier before it returns success", async () => {
  const f = fixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  f.guilds.get("101")!.setPaused.mockImplementation(() => barrier);
  let finished = false;
  const response = f.request("/pause?guild=101").then((value) => { finished = true; return value; });
  await vi.waitFor(() => expect(f.guilds.get("101")!.setPaused).toHaveBeenCalledWith(true));
  expect(finished).toBe(false);
  release();
  expect((await response).status).toBe(200);
});

it("does not restart an archive after reset fails", async () => {
  const f = fixture();
  f.guilds.get("101")!.reset.mockRejectedValue(new Error("Storage write failed"));
  const response = await f.request("/reset?guild=101");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Storage write failed" });
  expect(f.guilds.get("101")!.start).not.toHaveBeenCalled();
});

it("rejects malformed or unconfigured guilds before it creates an archive stub", async () => {
  const f = fixture();
  for (const id of ["999", "../101", "", "101x"]) {
    expect((await f.request(`/pause?guild=${encodeURIComponent(id)}`)).status).toBe(400);
  }
  expect((await f.request("/reset")).status).toBe(400);
  expect(f.getGuild).not.toHaveBeenCalled();
});

it("bounds dead-letter queries and refuses unsafe legacy replay", async () => {
  const f = fixture();
  for (const query of ["limit=101", "after=1.2", "after=9007199254740992", "limit=-1"]) {
    expect((await f.request(`/dead-letters?${query}`, "GET")).status).toBe(400);
  }
  expect(f.gateway.listDeadLetters).not.toHaveBeenCalled();
  expect((await f.request("/retry-dead-letter?guild=101&id=7")).status).toBe(409);
  expect(f.gateway.retryDeadLetter).toHaveBeenCalledWith({ guild: "101", id: 7 });
});

it("reports remote TypeErrors as service failures", async () => {
  const f = fixture();
  f.gateway.ensureRunning.mockRejectedValue(new TypeError("Network request failed"));
  const response = await f.request("/start");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Network request failed" });
});

it("can stop the Gateway when the guild configuration is invalid", async () => {
  const f = fixture();
  f.env.REJGAU_CONFIG = "invalid JSON";
  expect((await f.request("/stop")).status).toBe(200);
  expect(f.gateway.stop).toHaveBeenCalledOnce();
  f.gateway.stop.mockRejectedValue(new Error("Storage write failed"));
  expect((await f.request("/stop")).status).toBe(503);
  expect((await f.request("/start")).status).toBe(500);
});
