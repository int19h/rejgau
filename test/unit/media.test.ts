import { describe, expect, it } from "vitest";
import { emojiRefsInText, mediaInMessage, refForUrl, sanitizeName, stickerRef } from "../../src/media";

describe("refForUrl", () => {
  it("keeps malformed attachment escapes from aborting media extraction", () => {
    expect(refForUrl("https://cdn.discordapp.com/attachments/1/2/%FF.png")).toMatchObject({ key: "att-2-FF.png" });
    expect(refForUrl("https://cdn.discordapp.com/attachments/1/2/my%20pic.png")).toMatchObject({ key: "att-2-my_pic.png" });
  });
  it("keys attachments by ID and rewrites the blocked media proxy to the CDN", () => {
    const r = refForUrl("https://media.discordapp.net/attachments/1/2/my%20pic.png?ex=a&is=b&hm=c&", { channelId: "1", messageId: "9" });
    expect(r).toEqual({ key: "att-2-my_pic.png", url: "https://cdn.discordapp.com/attachments/1/2/my%20pic.png?ex=a&is=b&hm=c&", channelId: "1", messageId: "9" });
  });

  it("unwraps Discord's external image proxy", () => {
    const r = refForUrl("https://images-ext-1.discordapp.net/external/abc/https/i.ytimg.com/vi/x/maxresdefault.jpg");
    expect(r?.url).toBe("https://i.ytimg.com/vi/x/maxresdefault.jpg");
    expect(r?.key).toMatch(/^ext-[0-9a-f]{16}\.jpg$/);
  });

  it("keys external URLs by a stable hash", () => {
    const a = refForUrl("https://example.com/a.png");
    expect(a).toEqual(refForUrl("https://example.com/a.png"));
    expect(a?.key).not.toBe(refForUrl("https://example.com/b.png")?.key);
  });

  it("ignores non-http URLs", () => {
    expect(refForUrl("attachment://x.png")).toBeNull();
    expect(refForUrl("not a url")).toBeNull();
  });
});

describe("helpers", () => {
  it("sanitizes names", () => {
    expect(sanitizeName("..héllo wörld!.png")).toBe("h_llo_w_rld_.png");
    expect(sanitizeName("")).toBe("file");
  });

  it("finds custom emoji", () => {
    expect(emojiRefsInText("hi <:toaq:671420902344491018> <a:spin:123>").map((r) => r.key)).toEqual([
      "emoji-671420902344491018.png",
      "emoji-123.gif",
    ]);
  });

  it("marks GIF stickers unfetchable", () => {
    expect(stickerRef("5", 4).url).toBeNull();
    expect(stickerRef("5", 1).url).toBe("https://cdn.discordapp.com/stickers/5.png");
  });
});

describe("mediaInMessage", () => {
  it("collects everything a message references, deduplicated", () => {
    const msg = {
      id: "900",
      channel_id: "800",
      content: "<:e:1>",
      author: { id: "7", avatar: "a_abc" },
      member: { avatar: "def" },
      attachments: [{ id: "2", url: "https://cdn.discordapp.com/attachments/800/2/f.txt?ex=1" }],
      embeds: [{ image: { url: "https://example.com/i.png", proxy_url: "https://images-ext-1.discordapp.net/x" }, description: "<:e:1>" }],
      sticker_items: [{ id: "3", format_type: 3 }],
      components: [
        { type: 17, components: [{ type: 10, content: "<a:z:4>" }, { type: 12, items: [{ media: { url: "https://cdn.discordapp.com/attachments/800/5/g.png" } }] }] },
      ],
      message_snapshots: [{ message: { attachments: [{ id: "6", url: "https://cdn.discordapp.com/attachments/801/6/h.png" }] } }],
      reactions: [{ emoji: { id: "8", animated: false } }],
      interaction_metadata: { user: { id: "7", avatar: "a_abc" } },
      poll: { question: { text: "?" }, answers: [{ poll_media: { emoji: { id: "9" } } }] },
    };
    const keys = mediaInMessage(msg, "100").map((r) => r.key);
    expect(keys.sort()).toEqual(
      [
        "emoji-1.png", "att-2-f.txt", refForUrl("https://example.com/i.png")!.key, "sticker-3.json", "emoji-4.gif", "att-5-g.png",
        "att-6-h.png", "emoji-8.png", "avatar-7-a_abc.gif", "gavatar-100-7-def.png", "emoji-9.png",
      ].sort(),
    );
    // Attachments carry what's needed to refresh an expired signed URL.
    expect(mediaInMessage(msg, "100").find((r) => r.key === "att-2-f.txt")).toMatchObject({ channelId: "800", messageId: "900" });
  });
});
