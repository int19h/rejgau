// Discord-flavoured markdown parsing: discord-markdown-parser plus a list rule it lacks. Shared by
// the reader (markdown.tsx) and the pre-rendered logs (tools/gfm.ts).

import { rulesExtended, SimpleMarkdown } from "discord-markdown-parser";

// Discord supports "- item", "* item" and "1. item" lists at the start of a line (nesting by indent).
const LIST_ITEM = /^( *)([-*]|\d{1,9}\.) +([^\n]*)(?:\n|$)/;
const listItem = {
  order: (SimpleMarkdown.defaultRules.heading as any).order - 0.4,
  match(source: string, state: any) {
    // Same line-start test the package uses for headings and subtext.
    if (state.prevCapture == null || state.prevCapture.slice(-1)[0] === "\n" || String(state.prevCapture[0]).endsWith("\n")) {
      return LIST_ITEM.exec(source);
    }
    return null;
  },
  parse(capture: string[], parse: any, state: any) {
    return {
      indent: Math.floor(capture[1].length / 2),
      ordered: capture[2].endsWith("."),
      start: capture[2].endsWith(".") ? Number(capture[2].slice(0, -1)) : undefined,
      content: parse(capture[3], state),
    };
  },
};

const parser = SimpleMarkdown.parserFor({ ...rulesExtended, listItem } as any);

export interface MdNode {
  type: string;
  [k: string]: any;
}

export function parseMarkdown(src: string): MdNode[] {
  return parser(src, { inline: true }) as MdNode[];
}
