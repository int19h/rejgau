import type { GatewaySession } from "./gateway";
import type { GuildArchive } from "./archive";

export interface Env {
  GATEWAY: DurableObjectNamespace<GatewaySession>;
  GUILD: DurableObjectNamespace<GuildArchive>;
  DISCORD_TOKEN: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  ADMIN_KEY: string;
  REJGAU_CONFIG: string;
}

/** One queued Gateway dispatch, as forwarded from GatewaySession to GuildArchive. */
export interface OutboxEvent {
  /** Gateway session ID. */
  sid: string;
  /** Gateway sequence number. */
  s: number;
  t: string;
  /** The dispatch's `d`, exactly as received (JSON text). */
  d: string;
  /** Receive time, ms since epoch. */
  at: number;
}
