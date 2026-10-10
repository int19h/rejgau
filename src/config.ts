// Parsing and validation of the REJGAU_CONFIG variable.

export interface GuildConfig {
  guildId: string;
  /** "owner/name" of the GitHub archive repo. */
  repo: string;
  /** Branch the logs are committed to. */
  branch: string;
  /** Folder inside the branch; "" means the repo root. No leading/trailing slashes. */
  path: string;
  /** "all" = every channel the bot can see; otherwise channel and/or category IDs. */
  channels: "all" | string[];
  /** Channel or category IDs to skip, applied after `channels`. */
  exclude: string[];
  /** Fetch each newly selected channel's full history on first sight. */
  backfill: boolean;
  /** Send a repository_dispatch ("archive-updated") after commits, for the Pages workflow. */
  pages: boolean;
  /**
   * Archive private threads the bot is in. Off by default: anyone in a private thread can add the
   * bot by mentioning it, which would otherwise publish the whole thread.
   */
  privateThreads: boolean;
}

export interface Config {
  guilds: Map<string, GuildConfig>;
  /** Flush after this long without new events. */
  flushIdleMs: number;
  /** Flush at the latest this long after the first pending event. */
  flushMaxMs: number;
  maxMediaBytes: number;
  /** Minimum time between release uploads (GitHub's content-creation limits). */
  mediaSpacingMs: number;
}

const SNOWFLAKE = /^\d{1,20}$/;

export class ConfigError extends Error {}

function snowflakes(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && SNOWFLAKE.test(v))) {
    throw new ConfigError(`${where} must be an array of ID strings`);
  }
  return value as string[];
}

export function parseConfig(raw: string | undefined): Config {
  if (!raw) throw new ConfigError("REJGAU_CONFIG is not set");
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`REJGAU_CONFIG is not valid JSON: ${e}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json) || typeof json.guilds !== "object" || json.guilds === null || Array.isArray(json.guilds)) {
    throw new ConfigError('REJGAU_CONFIG must be an object with a "guilds" object');
  }
  const guilds = new Map<string, GuildConfig>();
  for (const [guildId, g] of Object.entries<any>(json.guilds)) {
    const where = `guilds["${guildId}"]`;
    if (!SNOWFLAKE.test(guildId)) throw new ConfigError(`${where}: key must be a guild ID`);
    if (typeof g !== "object" || g === null || Array.isArray(g)) throw new ConfigError(`${where} must be an object`);
    if (typeof g.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(g.repo)) {
      throw new ConfigError(`${where}.repo must be "owner/name"`);
    }
    const branch = g.branch ?? "archive";
    if (typeof branch !== "string" || !branch || branch.startsWith("/") || branch.includes("..")) {
      throw new ConfigError(`${where}.branch is invalid`);
    }
    if (g.path !== undefined && typeof g.path !== "string") throw new ConfigError(`${where}.path must be a string`);
    const path: string = (g.path ?? "").replace(/^\/+|\/+$/g, "");
    if (path.split("/").some((seg) => seg === "." || seg === "..")) throw new ConfigError(`${where}.path is invalid`);
    const channels = g.channels === "all" ? "all" : snowflakes(g.channels, `${where}.channels`);
    const exclude = g.exclude === undefined ? [] : snowflakes(g.exclude, `${where}.exclude`);
    const boolean = (name: string, dflt: boolean): boolean => {
      if (g[name] === undefined) return dflt;
      if (typeof g[name] !== "boolean") throw new ConfigError(`${where}.${name} must be a boolean`);
      return g[name];
    };
    guilds.set(guildId, { guildId, repo: g.repo, branch, path, channels, exclude, backfill: boolean("backfill", true), pages: boolean("pages", false), privateThreads: boolean("privateThreads", false) });
  }
  const num = (v: unknown, dflt: number, name: string, max: number) => {
    if (v === undefined) return dflt;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) throw new ConfigError(`${name} must be a finite number between 0 and ${max}`);
    return v;
  };
  return {
    guilds,
    flushIdleMs: num(json.flushIdleSeconds, 120, "flushIdleSeconds", 86_400) * 1000,
    flushMaxMs: num(json.flushMaxSeconds, 600, "flushMaxSeconds", 86_400) * 1000,
    maxMediaBytes: num(json.maxMediaMegabytes, 100, "maxMediaMegabytes", 2048) * 1024 * 1024,
    mediaSpacingMs: num(json.mediaUploadSpacingSeconds, 8, "mediaUploadSpacingSeconds", 86_400) * 1000,
  };
}
