import { describe, expect, it } from "vitest";
import { codeBlock, escapeText, inlineCode, linkUrl, paragraphs, renderMarkdown, type GfmContext } from "../../tools/gfm";

const ctx: GfmContext = {
  user: (id) => (id === "123456789012345678" ? "Alice_B" : null),
  role: (id) => (id === "223456789012345678" ? "mods" : null),
  channel: (id) => (id === "323456789012345678" ? { name: "general", href: "general/README.md" } : null),
};
const md = (s: string) => renderMarkdown(s, ctx).md;

describe("escaping", () => {
  it("neutralizes GFM-only syntax: HTML, tables, footnotes, single-tilde strikethrough, entities", () => {
    expect(md("<script>x</script> a|b [^1] ~x~ &amp;")).toBe("\\<script\\>x\\</script\\> a\\|b \\[^1\\] \\~x\\~ \\&amp;");
  });

  it("escapes line-start constructs that Discord shows as text", () => {
    expect(escapeText("+ x", true)).toBe("\\+ x");
    expect(escapeText("2026. was a year", true)).toBe("2026\\. was a year");
    expect(escapeText("===", true)).toBe("\\===");
    expect(escapeText("    indented", true)).toBe("    indented");
    expect(escapeText("+ x", false)).toBe("+ x");
    // A "---" line under text would make a setext heading.
    expect(md("title\n---")).toBe("title\\\n\\---");
  });

  it("fences code that contains backticks", () => {
    expect(inlineCode("a`b")).toBe("``a`b``");
    expect(inlineCode("`x")).toBe("`` `x ``");
    expect(codeBlock("```\ninner\n```", "js")).toBe("````js\n```\ninner\n```\n````");
  });
});

describe("Discord markdown", () => {
  it("maps formatting, including strikethrough and underline", () => {
    expect(md("**b** *i* __u__ ~~s~~ `c`")).toBe("**b** *i* <ins>u</ins> ~~s~~ `c`");
  });

  it("keeps Discord line breaks as hard breaks, and blank lines as paragraphs", () => {
    expect(md("a\nb\n\nc")).toBe("a\\\nb\n\nc");
    expect(paragraphs("\n\na\n\n\n\nb\n")).toBe("a\n\nb");
  });

  it("renders block structures", () => {
    expect(md("> q1\n> q2\nafter")).toBe("> q1\\\n> q2\n\nafter");
    expect(md("```py\nprint(1)\n```")).toBe("```py\nprint(1)\n```");
    expect(md("# Title\ntext")).toBe("# Title\n\ntext");
    expect(md("-# small")).toBe("<sub>small</sub>");
    expect(md("- a\n  - b\n1. one")).toBe("- a\n    - b\n1. one");
  });

  it("resolves mentions, channels and timestamps", () => {
    expect(md("<@123456789012345678> <@&223456789012345678> <#323456789012345678> <@999999999999999999>")).toBe(
      "**@Alice\\_B** **@mods** [**#general**](general/README.md) **@unknown-user**",
    );
    expect(md("<t:1700000000:f> <t:1700000000:d>")).toBe("**2023-11-14 22:13 UTC** **2023-11-14**");
    expect(md("<:smile:123456789012345678> 😀")).toBe(":smile: 😀");
  });

  it("only links http(s) URLs", () => {
    expect(md("[x](https://a.b/c) https://e.f")).toBe("[x](<https://a.b/c>) <https://e.f/>");
    expect(linkUrl("https://a.b/<c>")).toBe("<https://a.b/%3Cc%3E>");
    expect(linkUrl("data:text/html,x")).toBeNull();
    expect(md("[x](javascript:alert(1))")).not.toContain("](");
  });

  it("reports spoilers so callers can fold the message", () => {
    expect(renderMarkdown("a ||secret|| b", ctx)).toEqual({ md: "a ||secret|| b", spoiler: true });
    expect(renderMarkdown("plain", ctx).spoiler).toBe(false);
  });
});
