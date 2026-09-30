import { describe, expect, it } from "vitest";
import { isEmojiOnly, parseMarkdown } from "../../reader/src/markdown";
import { safeUrl } from "../../reader/src/url";

const types = (s: string) => parseMarkdown(s).map((n) => n.type);

describe("markdown", () => {
  it("parses Discord's line-start syntax only at line start", () => {
    expect(types("- a\n- b")).toEqual(["listItem", "listItem"]);
    expect(types("not - a list")).toEqual(["text", "text"]);
    expect(types("x\n# h")).toEqual(["text", "br", "heading"]);
    expect(types("-# small")).toEqual(["subtext"]);
  });

  it("recognizes mentions, emoji and timestamps", () => {
    const id = "930217754894667906";
    expect(types(`<@${id}> <#${id}> <:toaq:671420902344491018> <t:1700000000:R>`).filter((t) => t !== "text")).toEqual(["user", "channel", "emoji", "timestamp"]);
  });

  it("detects emoji-only messages", () => {
    expect(isEmojiOnly(parseMarkdown("<:toaq:671420902344491018> 😀"))).toBe(true);
    expect(isEmojiOnly(parseMarkdown("hi 😀"))).toBe(false);
  });

  it("only allows http(s) URLs", () => {
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,<b>")).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});
