import { fnv1a64 } from "./util";

// Removes values that don't belong in a public archive from Discord payloads before they're logged.
//
// The rule of thumb: keep what any member of the channel can see in the Discord client (content,
// names, avatars, badges, nicknames, roles, reactions and who reacted, poll votes, …). Drop
// moderation state, security configuration, safety-scanner output, app-internal identifiers, and
// fields that only describe the bot's own point of view. Decisions are listed per field below.

/** Keys dropped wherever they appear. */
const DROP_ANYWHERE = new Set([
  // Moderation state of a member: timeouts, voice mute/deafen, membership screening, DM-spam flag.
  "communication_disabled_until",
  "unusual_dm_activity_until",
  "mute",
  "deaf",
  "pending",
  // Security configuration: which roles/users may do what (overwrites also list user IDs with
  // explicit access to private channels), and role/interaction permission bitsets.
  "permission_overwrites",
  "permissions",
  // Output of Discord's safety scanner on attachments and embeds (e.g. explicit-content verdicts).
  "content_scan_metadata",
  "content_scan_version",
  // App-internal: component custom IDs are opaque state for the owning app and may embed user
  // IDs or signed tokens. The archive renders components as disabled, so they aren't needed.
  "custom_id",
  // Client-generated message nonce: meaningless outside the sender's client.
  "nonce",
  // Rich-presence invite messages: the party ID is effectively a join secret.
  "party_id",
  // The bot's own point of view (did *the bot* react/vote).
  "me",
  "me_burst",
  "burst_me",
  "me_voted",
  // Undocumented or irrelevant per-user extras.
  "vad_colors",
  "member_gaming_leaderboard_data",
]);

function isUser(o: Record<string, unknown>): boolean {
  return typeof o.id === "string" && typeof o.username === "string" && "discriminator" in o;
}

/** A guild emoji or sticker object (as in GUILD_CREATE and GUILD_EMOJIS/STICKERS_UPDATE). */
function isExpression(o: Record<string, unknown>): boolean {
  return typeof o.id === "string" && typeof o.name === "string" && ("require_colons" in o || "format_type" in o || "managed" in o && "animated" in o);
}

function isMember(o: Record<string, unknown>): boolean {
  return typeof o.joined_at === "string" && Array.isArray(o.roles);
}

/** Returns a copy of a Discord payload with non-public values removed. */
export function sanitize<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sanitize) as T;
  if (typeof value !== "object" || value === null) return value;
  const o = value as Record<string, unknown>;
  // `flags` on users includes private account flags (the public subset is `public_flags`); on
  // members it carries moderation state (rejoined, bypassed verification, AutoMod quarantine).
  // Message, channel, attachment and embed `flags` are presentational and kept.
  const dropFlags = isUser(o) || isMember(o);
  // Custom emoji and stickers name their uploader, which only server managers can see.
  const dropUploader = isExpression(o);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (DROP_ANYWHERE.has(k)) continue;
    if (k === "flags" && dropFlags) continue;
    if (k === "user" && dropUploader) continue;
    out[k] = sanitize(v);
  }
  return out as T;
}

/** Guild member fields kept in MEMBER_SNAPSHOT records (what a profile shows other members). */
export const MEMBER_FIELDS = ["user", "nick", "avatar", "banner", "roles", "joined_at", "premium_since"];

/** Opaque, stable stand-in for a Gateway session ID in public logs. Session IDs are only needed
 * to order and dedupe events; publishing the real one serves no purpose. */
export function publicSessionId(sid: string): string {
  return sid ? fnv1a64(`rejgau-session:${sid}`) : sid;
}
