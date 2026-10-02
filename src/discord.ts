import type { Env } from "./env";
import { withDeadline } from "./http";
import type { DiscordLimitObservation } from "./discord-limits";

const API = "https://discord.com/api/v10";
type DiscordEnv = Pick<Env, "DISCORD_TOKEN" | "GATEWAY">;

export class DiscordError extends Error {
  constructor(readonly status: number, readonly body: string, path: string) {
    super(`Discord GET ${path} failed: ${status} ${body.slice(0, 200)}`);
  }
}

/** A rate limit defers work until its absolute deadline. */
export class DiscordRateLimitError extends DiscordError {
  constructor(path: string, readonly retryAt: number) {
    super(429, `Retry after ${new Date(retryAt).toISOString()}`, path);
  }
}

function deadline(seconds: unknown, now: number): number | undefined {
  if (seconds === null || seconds === undefined || seconds === "") return undefined;
  const value = Number(seconds);
  const at = Math.ceil(now + value * 1000 + 100);
  return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(at) && at <= 8.64e15 ? at : undefined;
}

/** GET a Discord API path. The caller persists rate-limit deferrals. */
export async function discordGet<T>(env: DiscordEnv, path: string): Promise<T> {
  const coordinator = env.GATEWAY.get(env.GATEWAY.idFromName("main"));
  const blockedUntil = await coordinator.discordCooldown(path);
  if (blockedUntil > Date.now()) throw new DiscordRateLimitError(path, blockedUntil);
  return withDeadline(async (signal) => {
    const res = await fetch(API + path, {
      signal,
      headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "User-Agent": "DiscordBot (https://github.com/int19h/rejgau, 1)" },
    });
    const now = Date.now();
    const resetAfter = deadline(res.headers.get("x-ratelimit-reset-after"), now);
    const resetEpoch = Number(res.headers.get("x-ratelimit-reset"));
    const resetAt = res.headers.has("x-ratelimit-reset") ? deadline(resetEpoch - now / 1000, now) : undefined;
    const observation: DiscordLimitObservation = {
      path,
      bucket: res.headers.get("x-ratelimit-bucket"),
      remaining: res.headers.has("x-ratelimit-remaining") ? Number(res.headers.get("x-ratelimit-remaining")) : null,
      resetAt: resetAfter ?? resetAt,
    };
    if (res.status === 429) {
      const body = await res.json().catch(() => ({})) as { retry_after?: unknown; global?: unknown };
      observation.global = body.global === true || res.headers.get("x-ratelimit-global") === "true" || res.headers.get("x-ratelimit-scope") === "global";
      observation.retryAt = Math.max(deadline(body.retry_after, now) ?? 0, deadline(res.headers.get("retry-after"), now) ?? 0, observation.resetAt ?? 0, now + 1000);
      const retryAt = await coordinator.observeDiscordLimit(observation);
      throw new DiscordRateLimitError(path, retryAt);
    }
    await coordinator.observeDiscordLimit(observation);
    if (!res.ok) throw new DiscordError(res.status, await res.text(), path);
    return await res.json() as T;
  });
}
