// Renders an archive as human-readable GFM logs:
//   npx tsx tools/buildlogs.ts --archive <archive folder> --out <dir> [--source <text>]
// Reads <archive>/raw/**/*.jsonl and writes the files described in tools/logs.ts into <dir>.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readRaw } from "./build";
import { fold } from "./fold";
import { buildLogs } from "./logs";

function arg(name: string, optional = false): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && !optional) throw new Error(`missing --${name}`);
  return v;
}

const archive = arg("archive")!;
const out = arg("out")!;
const lines = readRaw(archive);
const files = buildLogs(fold(lines), { source: arg("source", true) });
for (const [path, text] of files) {
  const target = join(out, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
console.log(`rendered ${files.size} files from ${lines.length} lines into ${out}`);
