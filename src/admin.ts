import { parseConfig } from "./config";
import type { Env } from "./env";
import { errorMessage } from "./util";

const METHODS: Record<string, string> = {
  "/status": "GET", "/start": "POST", "/stop": "POST", "/reset": "POST",
  "/retry-media": "POST", "/flush": "POST", "/pause": "POST", "/resume": "POST",
  "/dead-letters": "GET", "/retry-dead-letter": "POST",
};

class ParameterError extends Error {}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_KEY) return false;
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_KEY)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function integerParam(url: URL, name: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ParameterError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env))) return new Response("not found", { status: 404 });
  const url = new URL(request.url);
  const method = METHODS[url.pathname];
  if (!method) return json({ error: "unknown route", routes: Object.entries(METHODS).map(([path, verb]) => `${verb} ${path}`) }, 404);
  if (request.method !== method) return json({ error: `${method} required` }, 405, { Allow: method });

  let config;
  try {
    config = parseConfig(env.REJGAU_CONFIG);
  } catch (e) {
    if (url.pathname !== "/status" && url.pathname !== "/stop") return json({ error: errorMessage(e) }, 500);
  }
  const guildId = url.searchParams.get("guild");
  if (guildId !== null && (!/^\d{1,20}$/.test(guildId) || (config && !config.guilds.has(guildId)))) {
    return json({ error: "guild must name a configured guild" }, 400);
  }
  const guilds = guildId ? [guildId] : [...(config?.guilds.keys() ?? [])];
  const gateway = env.GATEWAY.get(env.GATEWAY.idFromName("main"));
  const archive = (id: string) => env.GUILD.get(env.GUILD.idFromName(id));

  try {
    switch (url.pathname) {
      case "/status": {
        const perGuild: Record<string, unknown> = {};
        for (const id of guilds) perGuild[id] = await archive(id).status().catch((e) => ({ error: errorMessage(e) }));
        return json({ config: config ? "ok" : "invalid", gateway: await gateway.status(), guilds: perGuild });
      }
      case "/start":
        await gateway.ensureRunning({ clearFatal: true });
        return json({ ok: true });
      case "/stop":
        await gateway.stop();
        return json({ ok: true });
      case "/reset": {
        if (!guildId) return json({ error: "POST /reset?guild=<id> required" }, 400);
        await archive(guildId).reset();
        const result = await archive(guildId).start(guildId);
        return json({ reset: guildId, ...result }, result.started ? 200 : 503);
      }
      case "/dead-letters":
        return json(await gateway.listDeadLetters({
          guild: guildId ?? undefined,
          after: integerParam(url, "after"),
          limit: integerParam(url, "limit", 100),
        }));
      case "/retry-dead-letter": {
        const id = integerParam(url, "id");
        if (!guildId || id === undefined) return json({ error: "POST /retry-dead-letter?guild=<id>&id=<event-id> required" }, 400);
        const result = await gateway.retryDeadLetter({ id, guild: guildId });
        return json(result, result.requeued ? 200 : result.reason === "not_found" ? 404 : 409);
      }
      default: {
        const out: Record<string, unknown> = {};
        let status = 200;
        for (const id of guilds) {
          try {
            const stub = archive(id);
            if (url.pathname === "/flush") {
              const result = await stub.flushNow(id);
              out[id] = result;
              if (result.error || !result.complete) status = 503;
            } else if (url.pathname === "/retry-media") {
              out[id] = await stub.retryFailedMedia();
            } else {
              const paused = url.pathname === "/pause";
              await stub.setPaused(paused);
              out[id] = { paused };
            }
          } catch (e) {
            out[id] = { error: errorMessage(e) };
            status = 503;
          }
        }
        return json(out, status);
      }
    }
  } catch (e) {
    return json({ error: errorMessage(e) }, e instanceof ParameterError ? 400 : 503);
  }
}
