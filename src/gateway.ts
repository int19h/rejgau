// GatewaySession: one Durable Object holding the bot's Discord Gateway connection.
//
// Durability contract: when a dispatch arrives, it is written to the SQLite outbox together with
// its sequence number, synchronously and before any await. So the persisted `seq` never runs ahead
// of stored events, and a RESUME from it replays exactly what might be missing. A single pump
// forwards outbox rows in order to the owning GuildArchive and deletes them once acknowledged.
// GuildArchive dedupes on (session, seq), so redelivery after a crash is harmless.
//
// Heartbeats and reconnects are driven by the DO alarm, because the runtime restarts DOs routinely
// (roughly hourly, per the spike). After a restart the alarm finds session state but no socket,
// and RESUMEs.

import { DurableObject } from "cloudflare:workers";
import { parseConfig, type Config } from "./config";
import type { Env, OutboxEvent } from "./env";
import { errorMessage, log } from "./util";

const GATEWAY_URL = "wss://gateway.discord.gg";
const GATEWAY_QUERY = "?v=10&encoding=json";

// GUILDS | GUILD_EXPRESSIONS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | MESSAGE_CONTENT | GUILD_MESSAGE_POLLS
export const INTENTS = (1 << 0) | (1 << 3) | (1 << 9) | (1 << 10) | (1 << 15) | (1 << 24);

/** Close codes after which reconnecting can't help; the session stays stopped until /start. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Events that carry their guild in `d.id` rather than `d.guild_id`. */
const GUILD_ID_IN_ID = new Set(["GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE"]);

const PUMP_BATCH = 100;

export class GatewaySession extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private sql: SqlStorage;
  private awaitingAck = false;
  private pumping = false;
  private pumpRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS outbox (n INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT NOT NULL, sid TEXT NOT NULL, s INTEGER NOT NULL, t TEXT NOT NULL, d TEXT NOT NULL, at INTEGER NOT NULL)`);
      this.bump("boots");
      if (this.get("running") === "1" && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + 1000);
      }
    });
  }

  // --- small persistent key/value helpers ---

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

  private config(): Config | null {
    try {
      return parseConfig(this.env.REJGAU_CONFIG);
    } catch (e) {
      this.set("configError", errorMessage(e));
      return null;
    }
  }

  // --- RPC ---

  /** Starts the session if it isn't running. Called by the cron trigger and /start. */
  async ensureRunning(opts: { clearFatal?: boolean } = {}): Promise<void> {
    if (opts.clearFatal) this.set("lastFatal", null);
    if (this.get("lastFatal")) return;
    this.set("running", "1");
    if (!this.ws && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 500);
    this.kickPump();
  }

  async stop(): Promise<void> {
    this.set("running", "0");
    await this.ctx.storage.deleteAlarm();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "stopped"); // 1000 deliberately invalidates the session.
    } catch {}
    this.set("sessionId", null);
    this.set("seq", null);
  }

  async status(): Promise<Record<string, string | number | boolean | null>> {
    const kv = Object.fromEntries(this.sql.exec<{ k: string; v: string }>(`SELECT k, v FROM kv`).toArray().map((r) => [r.k, r.v]));
    delete kv.sessionId;
    delete kv.resumeUrl;
    const outbox = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`).one().n;
    return { connected: this.ws !== null, outbox, ...kv };
  }

  // --- connection ---

  private async openSocket(): Promise<void> {
    if (!this.config()) {
      log("gateway_config_invalid", { error: this.get("configError") });
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    this.set("configError", null);
    const resume = this.get("sessionId") !== null;
    const base = (resume && this.get("resumeUrl")) || GATEWAY_URL;
    let resp: Response;
    try {
      resp = await fetch(base.replace("wss://", "https://") + "/" + GATEWAY_QUERY, { headers: { Upgrade: "websocket" } });
    } catch (e) {
      this.set("lastConnectError", errorMessage(e));
      await this.scheduleReconnect();
      return;
    }
    const ws = resp.webSocket;
    if (!ws) {
      this.set("lastConnectError", `HTTP ${resp.status}`);
      await resp.body?.cancel();
      await this.scheduleReconnect();
      return;
    }
    ws.accept();
    this.ws = ws;
    this.awaitingAck = false;
    this.set("connectedAt", new Date().toISOString());
    ws.addEventListener("message", (ev) => this.onMessage(ws, ev.data as string));
    ws.addEventListener("close", (ev) => this.onClose(ws, ev.code, ev.reason));
    // Watchdog in case HELLO never arrives; HELLO reschedules the alarm for the first heartbeat.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  private send(ws: WebSocket, payload: unknown): void {
    ws.send(JSON.stringify(payload));
  }

  private heartbeat(ws: WebSocket): void {
    const seq = this.get("seq");
    this.send(ws, { op: 1, d: seq === null ? null : Number(seq) });
    this.awaitingAck = true;
  }

  private onMessage(ws: WebSocket, data: string): void {
    if (ws !== this.ws) return;
    const msg = JSON.parse(data) as { op: number; d: any; s: number | null; t: string | null };
    switch (msg.op) {
      case 10: {
        const interval = msg.d.heartbeat_interval as number;
        this.set("heartbeatInterval", String(interval));
        const sessionId = this.get("sessionId");
        const token = this.env.DISCORD_TOKEN;
        if (sessionId) {
          this.send(ws, { op: 6, d: { token, session_id: sessionId, seq: Number(this.get("seq") ?? 0) } });
        } else {
          this.bump("identifies");
          this.send(ws, { op: 2, d: { token, intents: INTENTS, properties: { os: "linux", browser: "rejgau", device: "rejgau" } } });
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

  /** Synchronous by design: the outbox write and the seq update must not be separated by an await. */
  private onDispatch(t: string, s: number, d: any): void {
    const cfg = this.config();
    const at = Date.now();
    if (t === "READY") {
      this.set("sessionId", d.session_id);
      this.set("resumeUrl", d.resume_gateway_url);
      this.set("readyAt", new Date(at).toISOString());
    } else if (t === "RESUMED") {
      this.bump("resumes");
    }
    const sid = this.get("sessionId") ?? "";
    const enqueue = (guild: string, type: string, payload: string) =>
      this.sql.exec(`INSERT INTO outbox (guild, sid, s, t, d, at) VALUES (?, ?, ?, ?, ?, ?)`, guild, sid, s, type, payload, at);

    if (t === "READY" || t === "RESUMED") {
      // Never forward READY itself (it lists every guild the bot is in); tell each guild instead.
      const marker = t === "READY" ? "SESSION_START" : "SESSION_RESUMED";
      for (const guild of cfg?.guilds.keys() ?? []) enqueue(guild, marker, JSON.stringify({ session_id: sid }));
    } else {
      const guild: string | undefined = GUILD_ID_IN_ID.has(t) ? d?.id : d?.guild_id;
      if (guild && cfg?.guilds.has(guild)) enqueue(guild, t, JSON.stringify(d));
    }
    this.set("seq", String(s));
    this.kickPump();
  }

  private kickPump(): void {
    if (!this.pumping) this.ctx.waitUntil(this.pump());
  }

  /** Forwards outbox rows, in order, to the owning GuildArchive. Only one pump runs at a time. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const head = this.sql.exec<{ guild: string }>(`SELECT guild FROM outbox ORDER BY n LIMIT 1`).toArray()[0];
        if (!head) return;
        // The longest run of rows for the same guild, preserving global order.
        const rows = this.sql
          .exec<{ n: number; guild: string; sid: string; s: number; t: string; d: string; at: number }>(
            `SELECT * FROM outbox ORDER BY n LIMIT ?`,
            PUMP_BATCH,
          )
          .toArray();
        const run = [];
        for (const r of rows) {
          if (r.guild !== head.guild) break;
          run.push(r);
        }
        const events: OutboxEvent[] = run.map(({ sid, s, t, d, at }) => ({ sid, s, t, d, at }));
        try {
          await this.env.GUILD.get(this.env.GUILD.idFromName(head.guild)).ingest(head.guild, events);
        } catch (e) {
          this.set("lastPumpError", errorMessage(e));
          log("pump_error", { error: errorMessage(e) });
          if (!this.pumpRetry) {
            this.pumpRetry = setTimeout(() => {
              this.pumpRetry = null;
              this.kickPump();
            }, 5000);
          }
          return;
        }
        this.sql.exec(`DELETE FROM outbox WHERE n <= ? AND guild = ?`, run[run.length - 1].n, head.guild);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Abandons a socket without waiting for its close event. Code 4000 keeps the session resumable. */
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
    this.set("lastClose", JSON.stringify({ code, reason, at: new Date().toISOString() }));
    if (FATAL_CLOSE_CODES.has(code)) {
      this.set("running", "0");
      this.set("lastFatal", JSON.stringify({ code, reason }));
      log("gateway_fatal", { code, reason });
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
    this.kickPump();
    if (this.get("running") !== "1") return;
    const interval = Number(this.get("heartbeatInterval") ?? "41250");
    if (!this.ws) {
      this.bump("reconnects");
      await this.openSocket();
      return;
    }
    if (this.awaitingAck) {
      // Zombie connection: no ACK since the last heartbeat.
      this.bump("zombies");
      this.drop(this.ws, "zombie");
      return;
    }
    this.heartbeat(this.ws);
    await this.ctx.storage.setAlarm(Date.now() + interval);
  }
}
