// GatewaySession stores the bot connection and routes events to each guild.
// Dispatch writes and sequence updates run together without an intervening await.
// Each guild keeps its own delivery order, retry deadline, and quarantine.
// One alarm serves connection recovery, heartbeats, and delivery retries.

import { DurableObject } from "cloudflare:workers";
import { parseConfig, type Config } from "./config";
import type { IngestResult } from "./archive";
import type { Env, OutboxEvent } from "./env";
import { errorMessage, log } from "./util";
import { GatewayOutbox, type DeadLetterRetry } from "./gateway-outbox";
import { DiscordCooldowns, type DiscordLimitObservation } from "./discord-limits";

const GATEWAY_URL = "wss://gateway.discord.gg";
const GATEWAY_QUERY = "?v=10&encoding=json";

// GUILDS | GUILD_EXPRESSIONS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | MESSAGE_CONTENT | GUILD_MESSAGE_POLLS
export const INTENTS = (1 << 0) | (1 << 3) | (1 << 9) | (1 << 10) | (1 << 15) | (1 << 24);

/** Close codes after which reconnecting can't help; the session stays stopped until /start. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Events that carry their guild in `d.id` rather than `d.guild_id`. */
const GUILD_ID_IN_ID = new Set(["GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE"]);

const PUMP_CONCURRENCY = 4;
/** Discord resets the token after 1000 IDENTIFYs a day; stay far below that even in a crash loop. */
const IDENTIFY_BUDGET_PER_DAY = 50;

export class GatewaySession extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private sql: SqlStorage;
  private awaitingAck = false;
  private outbox!: GatewayOutbox;
  private cooldowns!: DiscordCooldowns;
  private activeGuilds = new Set<string>();
  private connectionGeneration = 0;
  private connectionAbort: AbortController | null = null;
  private connecting = false;
  private bootstrapping = false;
  private alarmChain: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
      this.outbox = new GatewayOutbox(ctx.storage);
      this.cooldowns = new DiscordCooldowns(this.sql);
      if (this.get("desiredRunning") === null) this.set("desiredRunning", this.get("running") === "0" ? "0" : "1");
      this.bump("boots");
      if (this.get("running") === "1" && (this.get("connectionWakeKind") !== "reconnect" || this.get("connectionWakeAt") === null)) {
        this.connectionWake(Date.now() + 1000, "reconnect");
      }
      await this.scheduleAlarm();
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

  private connectionWake(at: number, kind: "heartbeat" | "reconnect"): void {
    this.set("connectionWakeAt", String(at));
    this.set("connectionWakeKind", kind);
  }

  // --- RPC ---

  /** Explicit starts clear fatal state. Scheduled recovery respects a stop. */
  async ensureRunning(opts: { clearFatal?: boolean } = {}): Promise<void> {
    if (opts.clearFatal) {
      this.set("desiredRunning", "1");
      this.set("lastFatal", null);
    }
    if (this.get("desiredRunning") !== "1" || this.get("lastFatal")) return;
    this.set("running", "1");
    if (!this.ws && this.get("connectionWakeAt") === null) this.connectionWake(Date.now() + 500, "reconnect");
    this.kickPump();
    if (this.get("sessionId")) this.ctx.waitUntil(this.startConfiguredGuilds());
    await this.scheduleAlarm();
  }

  private async startConfiguredGuilds(): Promise<void> {
    if (this.bootstrapping) return;
    const cfg = this.config();
    if (!cfg) return;
    this.bootstrapping = true;
    try {
      for (const { k } of this.sql.exec<{ k: string }>(`SELECT k FROM kv WHERE k LIKE 'guildStart:%'`)) {
        if (!cfg.guilds.has(k.slice("guildStart:".length))) this.set(k, null);
      }
      const guilds = [...cfg.guilds.keys()];
      for (let i = 0; i < guilds.length; i += PUMP_CONCURRENCY) {
        if (this.get("desiredRunning") !== "1") return;
        await Promise.all(guilds.slice(i, i + PUMP_CONCURRENCY).map(async (guild) => {
          const signature = JSON.stringify(cfg.guilds.get(guild));
          if (this.get(`guildStart:${guild}`) === signature) return;
          try {
            const result = await this.env.GUILD.get(this.env.GUILD.idFromName(guild)).start(guild);
            if (result.started) this.set(`guildStart:${guild}`, signature);
          } catch (e) {
            log("guild_start_error", { guild, error: errorMessage(e) });
          }
        }));
      }
    } finally {
      this.bootstrapping = false;
    }
  }

  async stop(): Promise<void> {
    this.set("desiredRunning", "0");
    this.set("running", "0");
    this.set("connectionWakeAt", null);
    this.connectionGeneration++;
    this.connectionAbort?.abort();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000, "stopped"); } catch {}
    this.set("sessionId", null);
    this.set("seq", null);
    await this.scheduleAlarm();
  }

  async status(): Promise<Record<string, string | number | boolean | null>> {
    const kv = Object.fromEntries(this.sql.exec<{ k: string; v: string }>(`SELECT k, v FROM kv`).toArray().map((r) => [r.k, r.v]));
    delete kv.sessionId;
    delete kv.resumeUrl;
    for (const key of Object.keys(kv)) if (key.startsWith("guildStart:")) delete kv[key];
    return { connected: this.ws !== null, ...this.outbox.counts(), ...kv };
  }

  async listDeadLetters(opts: { guild?: string; after?: number; limit?: number } = {}) {
    return this.outbox.list(opts);
  }

  async retryDeadLetter(target: { id: number; guild: string }): Promise<DeadLetterRetry> {
    const result = this.outbox.retry(target);
    if (result.requeued) this.kickPump();
    await this.scheduleAlarm();
    return result;
  }

  async discordCooldown(path: string): Promise<number> {
    return this.cooldowns.deadlineFor(path);
  }

  async observeDiscordLimit(observation: DiscordLimitObservation): Promise<number> {
    return this.cooldowns.observe(observation);
  }

  // --- connection ---

  private async openSocket(): Promise<void> {
    if (!this.config()) {
      log("gateway_config_invalid", { error: this.get("configError") });
      this.connectionWake(Date.now() + 60_000, "reconnect");
      await this.scheduleAlarm();
      return;
    }
    this.set("configError", null);
    const resume = this.get("sessionId") !== null;
    if (!resume) {
      const recent = (JSON.parse(this.get("identifyTimes") ?? "[]") as number[]).filter((t) => t > Date.now() - 86_400_000);
      if (recent.length >= IDENTIFY_BUDGET_PER_DAY) {
        this.set("identifyThrottled", new Date().toISOString());
        log("identify_budget_exhausted", { recent: recent.length });
        this.connectionWake(Date.now() + 3_600_000, "reconnect");
        await this.scheduleAlarm();
        return;
      }
      this.set("identifyThrottled", null);
      this.set("identifyTimes", JSON.stringify([...recent, Date.now()]));
    }
    const base = (resume && this.get("resumeUrl")) || GATEWAY_URL;
    const generation = this.connectionGeneration;
    const controller = new AbortController();
    this.connectionAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let resp: Response;
    try {
      resp = await fetch(base.replace("wss://", "https://") + "/" + GATEWAY_QUERY, { headers: { Upgrade: "websocket" }, signal: controller.signal });
    } catch (e) {
      if (generation === this.connectionGeneration && this.get("running") === "1") {
        this.set("lastConnectError", errorMessage(e));
        await this.scheduleReconnect();
      }
      return;
    } finally {
      clearTimeout(timeout);
      if (this.connectionAbort === controller) this.connectionAbort = null;
    }
    const ws = resp.webSocket;
    if (generation !== this.connectionGeneration || this.get("running") !== "1") {
      try { if (ws) { ws.accept(); ws.close(1000, "stopped"); } } catch {}
      await resp.body?.cancel();
      return;
    }
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
    this.connectionWake(Date.now() + 30_000, "heartbeat");
    await this.scheduleAlarm();
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
        this.connectionWake(Date.now() + Math.max(1, Math.floor(interval * Math.random())), "heartbeat");
        this.ctx.waitUntil(this.scheduleAlarm());
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
        this.onDispatch(msg.t!, msg.s, msg.d);
        return;
    }
  }

  /** Synchronous by design: the outbox write and the seq update must not be separated by an await. */
  private onDispatch(t: string, s: number | null, d: any): void {
    const cfg = this.config();
    const at = Date.now();
    if (t === "READY" || t === "RESUMED") this.set("connectFailures", null);
    if (t === "READY") {
      this.set("sessionId", d.session_id);
      this.set("resumeUrl", d.resume_gateway_url);
      this.set("readyAt", new Date(at).toISOString());
    } else if (t === "RESUMED") {
      this.bump("resumes");
    }
    const sid = this.get("sessionId") ?? "";
    // Dispatches always carry a sequence number; be defensive and never let a missing one clobber `seq`.
    const seq = typeof s === "number" ? s : Number(this.get("seq") ?? "0");
    const enqueue = (guild: string, type: string, payload: string) =>
      this.outbox.enqueue(guild, { sid, s: seq, t: type, d: payload, at });

    if (t === "READY" || t === "RESUMED") {
      // Never forward READY itself (it lists every guild the bot is in); tell each guild instead.
      const marker = t === "READY" ? "SESSION_START" : "SESSION_RESUMED";
      for (const guild of cfg?.guilds.keys() ?? []) enqueue(guild, marker, JSON.stringify({ session_id: sid }));
    } else {
      const guild: string | undefined = GUILD_ID_IN_ID.has(t) ? d?.id : d?.guild_id;
      if (guild && cfg?.guilds.has(guild)) enqueue(guild, t, JSON.stringify(d));
    }
    if (typeof s === "number") this.set("seq", String(s));
    this.kickPump();
  }

  private kickPump(): void {
    const room = PUMP_CONCURRENCY - this.activeGuilds.size;
    if (room <= 0) return;
    for (const guild of this.outbox.dueGuilds(Date.now(), this.activeGuilds, room)) {
      this.activeGuilds.add(guild);
      this.ctx.waitUntil(this.pumpGuild(guild));
    }
    this.ctx.waitUntil(this.scheduleAlarm());
  }

  private async pumpGuild(guild: string): Promise<void> {
    try {
      const rows = this.outbox.batch(guild);
      if (!rows.length) return;
      const events: OutboxEvent[] = rows.map(({ sid, s, t, d, at }) => ({ sid, s, t, d, at }));
      let result: IngestResult;
      try {
        result = await this.env.GUILD.get(this.env.GUILD.idFromName(guild)).ingest(guild, events);
      } catch (e) {
        result = { handled: 0, failed: { retryable: true, error: errorMessage(e) } };
      }
      if (!Number.isInteger(result.handled) || result.handled < 0 || result.handled > rows.length || (!result.failed && result.handled === 0)) {
        result = { handled: 0, failed: { retryable: true, error: "The archive returned an invalid delivery result." } };
      }
      if (result.handled > 0) this.outbox.accept(guild, rows, result.handled);
      if (result.failed && result.handled < rows.length) {
        this.set("lastPumpError", result.failed.error.slice(0, 500));
        this.outbox.fail(rows[result.handled], result.failed, Date.now());
        log("pump_error", { guild, n: rows[result.handled].n, retryable: result.failed.retryable, error: result.failed.error });
      } else this.outbox.accept(guild, rows, result.handled);
    } finally {
      this.activeGuilds.delete(guild);
      this.kickPump();
    }
  }

  /** One alarm serves the connection and every guild retry deadline. */
  private scheduleAlarm(): Promise<void> {
    const run = this.alarmChain.then(async () => {
      const connection = this.get("running") === "1" && !this.connecting ? this.get("connectionWakeAt") : null;
      const delivery = this.activeGuilds.size < PUMP_CONCURRENCY ? this.outbox.nextDeadline(this.activeGuilds) : null;
      const deadlines = [connection === null ? null : Number(connection), delivery].filter((v): v is number => v !== null);
      if (!deadlines.length) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...deadlines)));
    });
    this.alarmChain = run.catch(() => {});
    return run;
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
      this.set("connectionWakeAt", null);
      this.ctx.waitUntil(this.scheduleAlarm());
      this.set("lastFatal", JSON.stringify({ code, reason }));
      log("gateway_fatal", { code, reason });
      return;
    }
    // 4007 (invalid seq) and 4009 (session timed out) require a fresh IDENTIFY.
    if (code === 4007 || code === 4009) { this.set("sessionId", null); this.set("seq", null); }
    this.ctx.waitUntil(this.scheduleReconnect());
  }

  /** Reconnects with exponential backoff (1 s … 5 min, jittered); reset by READY/RESUMED. */
  private async scheduleReconnect(): Promise<void> {
    if (this.get("running") !== "1") return;
    const failures = Number(this.get("connectFailures") ?? "0");
    this.set("connectFailures", String(failures + 1));
    const delay = Math.min(300_000, 1000 * 2 ** failures);
    this.connectionWake(Date.now() + delay + Math.floor(Math.random() * Math.min(delay, 4000)), "reconnect");
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> {
    this.kickPump();
    try {
      if (this.get("running") !== "1" || this.connecting) return;
      if (Number(this.get("connectionWakeAt") ?? "0") > Date.now()) return;
      if (!this.ws) {
        this.bump("reconnects");
        this.connecting = true;
        try { await this.openSocket(); } finally { this.connecting = false; }
        return;
      }
      if (this.awaitingAck) {
        this.bump("zombies");
        this.drop(this.ws, "zombie");
        return;
      }
      this.heartbeat(this.ws);
      this.connectionWake(Date.now() + Number(this.get("heartbeatInterval") ?? "41250"), "heartbeat");
    } finally {
      await this.scheduleAlarm();
    }
  }
}
