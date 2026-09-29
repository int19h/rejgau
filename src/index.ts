// Worker entry point: admin HTTP endpoints and the cron trigger that keeps the Gateway session up.

import { parseConfig } from "./config";
import type { Env } from "./env";
import { errorMessage } from "./util";

export { GatewaySession } from "./gateway";
export { GuildArchive } from "./archive";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Constant-time comparison of the presented admin key. */
async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_KEY) return false;
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? new URL(request.url).searchParams.get("key") ?? "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(presented)), crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_KEY))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function gateway(env: Env) {
  return env.GATEWAY.get(env.GATEWAY.idFromName("main"));
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!(await authorized(request, env))) return new Response("not found", { status: 404 });
    const url = new URL(request.url);
    const guildId = url.searchParams.get("guild");
    let config;
    try {
      config = parseConfig(env.REJGAU_CONFIG);
    } catch (e) {
      if (url.pathname !== "/status") return json({ error: errorMessage(e) }, 500);
    }
    const guilds = guildId ? [guildId] : [...(config?.guilds.keys() ?? [])];
    const archive = (id: string) => env.GUILD.get(env.GUILD.idFromName(id));
    const post = request.method === "POST";

    switch (url.pathname) {
      case "/status": {
        const perGuild: Record<string, unknown> = {};
        for (const id of guilds) perGuild[id] = await archive(id).status().catch((e) => ({ error: errorMessage(e) }));
        return json({ config: config ? "ok" : "invalid", gateway: await gateway(env).status(), guilds: perGuild });
      }
      case "/start":
        if (!post) break;
        await gateway(env).ensureRunning({ clearFatal: true });
        return json({ ok: true });
      case "/stop":
        if (!post) break;
        await gateway(env).stop();
        return json({ ok: true });
      case "/flush":
      case "/pause":
      case "/resume": {
        if (!post) break;
        const out: Record<string, unknown> = {};
        for (const id of guilds) {
          const stub = archive(id);
          if (url.pathname === "/flush") out[id] = await stub.flushNow();
          else {
            await stub.setPaused(url.pathname === "/pause");
            out[id] = { paused: url.pathname === "/pause" };
          }
        }
        return json(out);
      }
    }
    return json({ error: "unknown route", routes: ["GET /status", "POST /start", "POST /stop", "POST /flush", "POST /pause", "POST /resume"] }, 404);
  },

  async scheduled(_controller, env): Promise<void> {
    await gateway(env).ensureRunning();
  },
} satisfies ExportedHandler<Env>;
