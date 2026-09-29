// Builds the reader site for an archive:
//   npx tsx tools/build.ts --archive <archive folder> --out <dir>
// Reads <archive>/raw/**/*.jsonl, folds it, writes <out>/data/…, and bundles the reader into <out>.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fold, type RawLine } from "./fold";
import { buildSiteData } from "./sitedata";
import { bundleReader } from "./bundle";

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : dflt;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

function* jsonlFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* jsonlFiles(p);
    else if (name.endsWith(".jsonl")) yield p;
  }
}

export function readRaw(archive: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const file of jsonlFiles(join(archive, "raw"))) {
    const text = readFileSync(file, "utf8");
    let n = 0;
    for (const line of text.split("\n")) {
      n++;
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // A hand-edited file with a broken line shouldn't stop the build; report it.
        console.warn(`skipping unparseable line ${file}:${n}`);
      }
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const archive = arg("archive");
  const out = arg("out");
  const lines = readRaw(archive);
  const state = fold(lines);
  const { files } = buildSiteData(state);
  for (const [path, value] of files) {
    const target = join(out, "data", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value));
  }
  await bundleReader(out);
  console.log(`built ${files.size} data files from ${lines.length} lines into ${out}`);
}

if (process.argv[1]?.endsWith("build.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
