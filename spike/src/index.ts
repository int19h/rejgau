// Throwaway feasibility spike for rejgau. Answers, from real Cloudflare egress:
//  1. Can a Durable Object open and hold a Discord Gateway WebSocket?
//  2. Can a Worker fetch Discord CDN media (attachments, avatars, emoji)?
//  3. What do other apps' command responses look like (interaction / interaction_metadata)?
//  4. How often does a long-lived DO get restarted?
//
// Every route requires ?key=<SPIKE_KEY>.

import { DurableObject } from "cloudflare:workers";

interface Env {
  SESSION: DurableObjectNamespace<GatewaySession>;
  SPIKE_KEY: string;
  DISCORD_TOKEN?: string;
}

const GATEWAY_URL = "wss://gateway.discord.gg";
const GATEWAY_QUERY = "?v=10&encoding=json";

// GUILDS | GUILD_EXPRESSIONS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | MESSAGE_CONTENT | GUILD_MESSAGE_POLLS
const INTENTS = (1 << 0) | (1 << 3) | (1 << 9) | (1 << 10) | (1 << 15) | (1 << 24);

// Close codes after which reconnecting is pointless.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const DEFAULT_CDN_PROBES = [
  "https://cdn.discordapp.com/embed/avatars/0.png",
  "https://media.discordapp.net/embed/avatars/0.png",
  // Unsigned/fake attachment: outside Cloudflare this is 404 "This content is no longer available."
  // A 403 here means the CDN is blocking Workers.
  "https://cdn.discordapp.com/attachments/1/2/test.png",
  "https://media.discordapp.net/attachments/1/2/test.png",
  "https://discord.com/api/v10/gateway",
];

type Probe = {
  url: string;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  ms: number;
  note: string | null;
};

async function probe(url: string): Promise<Probe> {
  const started = Date.now();
  try {
    const resp = await fetch(url, { redirect: "follow" });
    const buf = await resp.arrayBuffer();
    const ok = resp.status >= 200 && resp.status < 300;
    return {
      url,
      status: resp.status,
      contentType: resp.headers.get("content-type"),
      bytes: buf.byteLength,
      ms: Date.now() - started,
      note: ok ? null : new TextDecoder().decode(buf.slice(0, 300)),
    };
  } catch (e) {
    return { url, status: null, contentType: null, bytes: null, ms: Date.now() - started, note: String(e) };
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Opens a Gateway WebSocket, waits for HELLO, sends one heartbeat, waits for its ACK. No token needed.
async function gatewayHandshake(): Promise<unknown> {
  const started = Date.now();
  const resp = await fetch(GATEWAY_URL.replace("wss://", "https://") + "/" + GATEWAY_QUERY, {
    headers: { Upgrade: "websocket" },
  });
  const ws = resp.webSocket;
  if (!ws) {
    return {
      ok: false,
      stage: "upgrade",
      status: resp.status,
      headers: Object.fromEntries(resp.headers),
      body: (await resp.text()).slice(0, 500),
    };
  }
  ws.accept();
  const log: unknown[] = [];
  const result = await new Promise<{ ok: boolean; stage: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, stage: "timeout" }), 15_000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string);
      log.push({ at: Date.now() - started, op: msg.op, d: msg.d });
      if (msg.op === 10) ws.send(JSON.stringify({ op: 1, d: null }));
      if (msg.op === 11) {
        clearTimeout(timer);
        resolve({ ok: true, stage: "heartbeat-ack" });
      }
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      log.push({ at: Date.now() - started, close: ev.code, reason: ev.reason });
      resolve({ ok: false, stage: "closed" });
    });
  });
  try {
    ws.close(4000, "spike done");
  } catch {}
  return { ...result, ms: Date.now() - started, log };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!env.SPIKE_KEY || url.searchParams.get("key") !== env.SPIKE_KEY) {
      return new Response("not found", { status: 404 });
    }
    switch (url.pathname) {
      case "/cdn": {
        const extra = url.searchParams.getAll("url");
        const results = await Promise.all([...DEFAULT_CDN_PROBES, ...extra].map(probe));
        return json({ colo: request.cf?.colo, results });
      }
      case "/gateway/handshake":
        return json(await gatewayHandshake());
      case "/gateway/start":
      case "/gateway/stop":
      case "/gateway/status":
      case "/gateway/events":
      case "/gateway/probes": {
        const stub = env.SESSION.get(env.SESSION.idFromName("main"));
        return stub.fetch(request);
      }
      default:
        return json({
          routes: ["/cdn[?url=...]", "/gateway/handshake", "/gateway/start", "/gateway/stop", "/gateway/status", "/gateway/events[?limit=&t=]", "/gateway/probes"],
        });
    }
  },
} satisfies ExportedHandler<Env>;

// A single long-lived Gateway session. Heartbeats and reconnects are driven by alarms, so the
// session survives DO eviction: the alarm handler notices a missing socket and RESUMEs.
export class GatewaySession extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private sql: SqlStorage;
  private awaitingAck = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS events (n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, t TEXT, s INTEGER, d TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS probes (n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, result TEXT)`);
      this.bump("boots");
      this.set("lastBootAt", new Date().toISOString());
      if (this.get("running") === "1" && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + 1000);
      }
    });
  }

  private get(k: string): string | null {
    const row = this.sql.exec<{ v: string }>(`SELECT v FROM kv WHERE k = ?`, k).toArray()[0];
    return row ? row.v : null;
  }
  private set(k: string, v: string | null): void {
    if (v === null) this.sql.exec(`DELETE FROM kv WHERE k = ?`, k);
    else this.sql.exec(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }
  private bump(k: string): void {
    this.set(k, String(Number(this.get(k) ?? "0") + 1));
  }
  private note(k: string, v: unknown): void {
    this.set(k, JSON.stringify({ at: new Date().toISOString(), v }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/gateway/start":
        if (!this.env.DISCORD_TOKEN) return json({ error: "DISCORD_TOKEN secret not set" }, 400);
        this.set("running", "1");
        this.set("lastFatal", null);
        if (!this.ws) await this.openSocket();
        return json({ started: true });
      case "/gateway/stop":
        this.set("running", "0");
        await this.ctx.storage.deleteAlarm();
        this.ws?.close(1000, "stopped");
        this.ws = null;
        this.set("sessionId", null);
        return json({ stopped: true });
      case "/gateway/status": {
        const kv = Object.fromEntries(
          this.sql.exec<{ k: string; v: string }>(`SELECT k, v FROM kv`).toArray().map((r) => [r.k, r.v]),
        );
        const counts = this.sql.exec(`SELECT t, COUNT(*) AS n FROM events GROUP BY t ORDER BY n DESC`).toArray();
        return json({ socketInMemory: this.ws !== null, alarm: await this.ctx.storage.getAlarm(), kv, counts });
      }
      case "/gateway/events": {
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const t = url.searchParams.get("t");
        const rows = t
          ? this.sql.exec(`SELECT * FROM events WHERE t = ? ORDER BY n DESC LIMIT ?`, t, limit).toArray()
          : this.sql.exec(`SELECT * FROM events ORDER BY n DESC LIMIT ?`, limit).toArray();
        return json(rows.map((r) => ({ ...r, d: JSON.parse(r.d as string) })));
      }
      case "/gateway/probes": {
        const rows = this.sql.exec(`SELECT * FROM probes ORDER BY n DESC LIMIT 100`).toArray();
        return json(rows.map((r) => ({ ...r, result: JSON.parse(r.result as string) })));
      }
    }
    return json({ error: "unknown route" }, 404);
  }

  private async openSocket(): Promise<void> {
    const resume = this.get("sessionId") !== null;
    const base = (resume && this.get("resumeUrl")) || GATEWAY_URL;
    this.bump(resume ? "resumeAttempts" : "identifyAttempts");
    let resp: Response;
    try {
      resp = await fetch(base.replace("wss://", "https://") + "/" + GATEWAY_QUERY, { headers: { Upgrade: "websocket" } });
    } catch (e) {
      this.note("lastConnectError", String(e));
      await this.scheduleReconnect();
      return;
    }
    const ws = resp.webSocket;
    if (!ws) {
      this.note("lastConnectError", { status: resp.status, body: (await resp.text()).slice(0, 500) });
      await this.scheduleReconnect();
      return;
    }
    ws.accept();
    this.ws = ws;
    this.awaitingAck = false;
    this.note("connectedAt", { resume, base });
    ws.addEventListener("message", (ev) => this.onMessage(ws, ev.data as string));
    ws.addEventListener("close", (ev) => this.onClose(ws, ev.code, ev.reason));
    ws.addEventListener("error", (ev) => this.note("lastSocketError", String((ev as ErrorEvent).message ?? ev)));
    // Watchdog in case HELLO never arrives; HELLO reschedules the alarm for the first heartbeat.
    await this.ctx.storage.setAlarm(Date.now() + 45_000);
  }

  private send(ws: WebSocket, payload: unknown): void {
    ws.send(JSON.stringify(payload));
  }

  private heartbeat(ws: WebSocket): void {
    const seq = this.get("seq");
    this.send(ws, { op: 1, d: seq === null ? null : Number(seq) });
    this.awaitingAck = true;
    this.set("lastHeartbeatAt", new Date().toISOString());
  }

  private onMessage(ws: WebSocket, data: string): void {
    if (ws !== this.ws) return;
    const msg = JSON.parse(data) as { op: number; d: any; s: number | null; t: string | null };
    this.bump("framesReceived");
    switch (msg.op) {
      case 10: {
        const interval = msg.d.heartbeat_interval as number;
        this.set("heartbeatInterval", String(interval));
        const sessionId = this.get("sessionId");
        if (sessionId) {
          this.send(ws, { op: 6, d: { token: this.env.DISCORD_TOKEN, session_id: sessionId, seq: Number(this.get("seq")) } });
        } else {
          this.send(ws, {
            op: 2,
            d: { token: this.env.DISCORD_TOKEN, intents: INTENTS, properties: { os: "linux", browser: "rejgau", device: "rejgau" } },
          });
        }
        this.ctx.storage.setAlarm(Date.now() + Math.floor(interval * Math.random()));
        return;
      }
      case 11:
        this.awaitingAck = false;
        this.set("lastAckAt", new Date().toISOString());
        return;
      case 1:
        this.heartbeat(ws);
        return;
      case 7:
        this.bump("reconnectRequests");
        this.drop(ws, "reconnect requested");
        return;
      case 9:
        this.bump("invalidSessions");
        if (!msg.d) {
          this.set("sessionId", null);
          this.set("seq", null);
        }
        this.drop(ws, "invalid session");
        return;
      case 0:
        this.onDispatch(msg.t!, msg.s!, msg.d);
        return;
    }
  }

  private onDispatch(t: string, s: number, d: any): void {
    this.set("seq", String(s));
    if (t === "READY") {
      this.set("sessionId", d.session_id);
      this.set("resumeUrl", d.resume_gateway_url);
      this.note("ready", { user: d.user?.username, guilds: d.guilds?.length });
    } else if (t === "RESUMED") {
      this.bump("resumes");
    }
    let stored = JSON.stringify(d);
    if (stored.length > 64_000) stored = JSON.stringify({ truncated: stored.length, keys: Object.keys(d ?? {}) });
    this.sql.exec(`INSERT INTO events (at, t, s, d) VALUES (?, ?, ?, ?)`, new Date().toISOString(), t, s, stored);
    this.sql.exec(`DELETE FROM events WHERE n <= (SELECT MAX(n) - 2000 FROM events)`);

    if ((t === "MESSAGE_CREATE" || t === "MESSAGE_UPDATE") && d) {
      const urls: string[] = [];
      for (const a of d.attachments ?? []) {
        urls.push(a.url);
        if (a.proxy_url) urls.push(a.proxy_url);
      }
      for (const e of d.embeds ?? []) {
        if (e.image?.proxy_url) urls.push(e.image.proxy_url);
        if (e.thumbnail?.proxy_url) urls.push(e.thumbnail.proxy_url);
      }
      if (d.author?.avatar) urls.push(`https://cdn.discordapp.com/avatars/${d.author.id}/${d.author.avatar}.png`);
      for (const m of String(d.content ?? "").matchAll(/<a?:\w+:(\d+)>/g)) urls.push(`https://cdn.discordapp.com/emojis/${m[1]}.webp`);
      for (const st of d.sticker_items ?? []) urls.push(`https://media.discordapp.net/stickers/${st.id}.png`);
      if (urls.length) this.ctx.waitUntil(this.probeAll(t, [...new Set(urls)]));
    }
  }

  private async probeAll(kind: string, urls: string[]): Promise<void> {
    for (const r of await Promise.all(urls.map(probe))) {
      this.sql.exec(`INSERT INTO probes (at, kind, result) VALUES (?, ?, ?)`, new Date().toISOString(), kind, JSON.stringify(r));
    }
  }

  // Abandons a socket without waiting for its close event. Code 4000 keeps the session resumable.
  private drop(ws: WebSocket, reason: string): void {
    if (ws === this.ws) this.ws = null;
    try {
      ws.close(4000, reason);
    } catch {}
    this.ctx.waitUntil(this.scheduleReconnect());
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.bump("closes");
    this.note("lastClose", { code, reason });
    if (FATAL_CLOSE_CODES.has(code)) {
      this.set("running", "0");
      this.note("lastFatal", { code, reason });
      return;
    }
    // 4007 (invalid seq) and 4009 (session timed out) require a fresh IDENTIFY.
    if (code === 4007 || code === 4009) this.set("sessionId", null);
    this.ctx.waitUntil(this.scheduleReconnect());
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.get("running") !== "1") return;
    await this.ctx.storage.setAlarm(Date.now() + 1000 + Math.floor(Math.random() * 4000));
  }

  async alarm(): Promise<void> {
    if (this.get("running") !== "1") return;
    this.bump("alarms");
    const interval = Number(this.get("heartbeatInterval") ?? "41250");
    if (!this.ws) {
      // Either first start after eviction/restart, or a scheduled reconnect.
      if (this.get("connectedAt")) this.bump("reconnects");
      await this.openSocket();
      return;
    }
    if (this.awaitingAck) {
      // Zombie connection: no ACK since the last heartbeat. Close with a non-1000 code to keep the session resumable.
      this.bump("zombies");
      this.drop(this.ws, "zombie");
      return;
    }
    this.heartbeat(this.ws);
    await this.ctx.storage.setAlarm(Date.now() + interval);
  }
}
