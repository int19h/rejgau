import { afterEach, expect, it, vi } from "vitest";
import { discordGet, DiscordRateLimitError } from "../../src/discord";
import { discordRoute, type DiscordLimitObservation } from "../../src/discord-limits";
import type { Env } from "../../src/env";

function environment() {
  let until = 0;
  const observations: DiscordLimitObservation[] = [];
  const coordinator = {
    discordCooldown: async () => until,
    observeDiscordLimit: async (input: DiscordLimitObservation) => {
      observations.push(input);
      until = Math.max(until, input.retryAt ?? 0, input.remaining === 0 ? input.resetAt ?? 0 : 0);
      return until;
    },
  };
  const env = { DISCORD_TOKEN: "test-token", GATEWAY: { idFromName: () => "main", get: () => coordinator } } as unknown as Pick<Env, "DISCORD_TOKEN" | "GATEWAY">;
  return { env, observations };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("persists the full 429 deadline and refuses another request before it", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const { env, observations } = environment();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ retry_after: 120, global: true }), { status: 429 }));
  vi.stubGlobal("fetch", fetch);
  const error = await discordGet(env, "/users/@me").catch((e) => e);
  expect(error).toBeInstanceOf(DiscordRateLimitError);
  if (!(error instanceof DiscordRateLimitError)) throw new Error("Expected a Discord rate limit.");
  expect(error.retryAt).toBe(now + 120_100);
  expect(observations[0]).toMatchObject({ global: true, retryAt: now + 120_100 });
  await expect(discordGet(env, "/guilds/107/roles")).rejects.toBeInstanceOf(DiscordRateLimitError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("returns successful data promptly and preserves the full exhausted-bucket deadline", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const { env, observations } = environment();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "65", "x-ratelimit-bucket": "example" } })));
  expect(await discordGet(env, "/channels/11/messages")).toEqual({ ok: true });
  expect(Date.now()).toBe(now);
  expect(observations[0]).toMatchObject({ bucket: "example", remaining: 0, resetAt: now + 65_100 });
});

it("uses the longer retry header and rejects nonfinite server delays", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const { env } = environment();
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"retry_after":1e400}', { status: 429, headers: { "retry-after": "90" } })));
  const error = await discordGet(env, "/channels/11/messages").catch((e) => e);
  if (!(error instanceof DiscordRateLimitError)) throw new Error("Expected a Discord rate limit.");
  expect(error.retryAt).toBe(now + 90_100);
});

it("groups minor IDs while keeping the channel or guild identity", () => {
  expect(discordRoute("/channels/11/messages/100?limit=1")).toEqual({ route: "GET /channels/11/messages/:id", major: "channels:11" });
  expect(discordRoute("/guilds/12/members/200")).toEqual({ route: "GET /guilds/12/members/:id", major: "guilds:12" });
  expect(discordRoute("/users/@me")).toEqual({ route: "GET /users/@me", major: "none" });
});
