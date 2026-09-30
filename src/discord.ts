// Minimal Discord REST client with rate-limit handling.

import { sleep } from "./util";

const API = "https://discord.com/api/v10";

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    path: string,
  ) {
    super(`Discord GET ${path} failed: ${status} ${body.slice(0, 200)}`);
  }
}

/** GET a Discord API path. Waits out 429s (a few times) and empty rate-limit buckets. */
export async function discordGet<T>(token: string, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      headers: { Authorization: `Bot ${token}`, "User-Agent": "DiscordBot (https://github.com/int19h/rejgau, 1)" },
    });
    if (res.status === 429 && attempt < 3) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.min(30, body.retry_after ?? 1) * 1000 + 100);
      continue;
    }
    if (!res.ok) throw new DiscordError(res.status, await res.text(), path);
    const data = (await res.json()) as T;
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset-after") ?? "1");
      await sleep(Math.min(10, reset) * 1000 + 100);
    }
    return data;
  }
}
