// Build readable logs from raw records. A manifest identifies files that the builder owns.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgs, provenance, reportSkipped, type BuildOptions } from "./buildargs";
import { fold } from "./fold";
import { buildLogs } from "./logs";
import { publishOutput, writeOutputFile } from "./output";
import { readRawArchive } from "./raw";

export async function buildLogArchive(archive: string, out: string, options: BuildOptions = {}): Promise<{ files: number; lines: number }> {
  const raw = readRawArchive(archive, options);
  reportSkipped(raw);
  const metadata = provenance(raw, archive, fileURLToPath(new URL("..", import.meta.url)), options);
  const source = options.source ?? `archive@${metadata.archive_revision ?? raw.digest}`;
  const files = buildLogs(fold(raw.lines), { source });
  files.set("build-info.json", `${JSON.stringify(metadata, null, 2)}\n`);
  await publishOutput(out, "logs", async (stage) => {
    for (const [path, text] of files) writeOutputFile(stage, path, text);
  }, options);
  return { files: files.size, lines: raw.lines.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = async () => {
    const { archive, out, options } = buildArgs();
    const result = await buildLogArchive(archive, out, options);
    console.log(`rendered ${result.files} files from ${result.lines} records into ${out}`);
  };
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
