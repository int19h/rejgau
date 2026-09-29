import { describe, expect, it } from "vitest";
import { publicSessionId, sanitize } from "../../src/sanitize";

describe("sanitize", () => {
  it("drops moderation, security, scanner and bot-perspective fields, keeping what members can see", () => {
    const msg = {
      id: "1",
      content: "hi",
      flags: 4, // message flags: kept
      nonce: "123",
      author: { id: "7", username: "u", discriminator: "0", global_name: "U", avatar: "a", public_flags: 64, flags: 1 << 20, vad_colors: null },
      member: {
        nick: "N", roles: ["1"], joined_at: "2024-01-01", premium_since: null, flags: 2,
        communication_disabled_until: "2030-01-01", mute: false, deaf: false, pending: false,
      },
      attachments: [{ id: "2", url: "u", flags: 16, content_scan_version: 4 }],
      components: [{ type: 1, components: [{ type: 2, label: "Go", custom_id: "secret:state" }] }],
      reactions: [{ count: 2, me: true, me_burst: false, burst_me: false, emoji: { name: "👍" } }],
      poll: { results: { answer_counts: [{ id: 1, count: 3, me_voted: true }] } },
    };
    expect(sanitize(msg)).toEqual({
      id: "1",
      content: "hi",
      flags: 4,
      author: { id: "7", username: "u", discriminator: "0", global_name: "U", avatar: "a", public_flags: 64 },
      member: { nick: "N", roles: ["1"], joined_at: "2024-01-01", premium_since: null },
      attachments: [{ id: "2", url: "u", flags: 16 }],
      components: [{ type: 1, components: [{ type: 2, label: "Go" }] }],
      reactions: [{ count: 2, emoji: { name: "👍" } }],
      poll: { results: { answer_counts: [{ id: 1, count: 3 }] } },
    });
  });

  it("drops channel permission overwrites and role permissions", () => {
    expect(sanitize({ id: "1", name: "c", topic: "t", permission_overwrites: [{ id: "9", type: 1, allow: "1024" }] })).toEqual({ id: "1", name: "c", topic: "t" });
    expect(sanitize({ roles: [{ id: "1", name: "Mod", color: 5, permissions: "8" }] })).toEqual({ roles: [{ id: "1", name: "Mod", color: 5 }] });
  });

  it("drops who uploaded emoji and stickers, and rich-presence party IDs", () => {
    const uploader = { id: "7", username: "u", discriminator: "0" };
    expect(sanitize({ emojis: [{ id: "1", name: "e", require_colons: true, managed: false, animated: false, user: uploader }] })).toEqual({
      emojis: [{ id: "1", name: "e", require_colons: true, managed: false, animated: false }],
    });
    expect(sanitize({ stickers: [{ id: "2", name: "s", format_type: 1, user: uploader }] })).toEqual({ stickers: [{ id: "2", name: "s", format_type: 1 }] });
    expect(sanitize({ activity: { type: 1, party_id: "spotify:123" } })).toEqual({ activity: { type: 1 } });
    // A message's `user`-shaped fields elsewhere are untouched.
    expect(sanitize({ interaction_metadata: { user: uploader } })).toEqual({ interaction_metadata: { user: uploader } });
  });

  it("does not modify its input", () => {
    const input = { nonce: "x", a: [{ me: true }] };
    sanitize(input);
    expect(input).toEqual({ nonce: "x", a: [{ me: true }] });
  });

  it("masks session IDs stably", () => {
    expect(publicSessionId("abc")).toBe(publicSessionId("abc"));
    expect(publicSessionId("abc")).not.toContain("abc");
    expect(publicSessionId("abc")).toMatch(/^[0-9a-f]{16}$/);
  });
});
