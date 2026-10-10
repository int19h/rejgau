// Build a reader site from raw logs. Input parsing is strict unless --skip-bad-lines is explicit.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PUBLICATION_FILE_BYTES, parseArchive, parseMonthFile, parseSearchRows, parseUsersFile } from "../shared/publication";
import { buildArgs, provenance, reportSkipped, type BuildOptions } from "./buildargs";
import { bundleReader } from "./bundle";
import { fold } from "./fold";
import { publishOutput, writeOutputFile } from "./output";
import { readRawArchive } from "./raw";
import { buildSiteData } from "./sitedata";

export { readRaw } from "./raw";
export { MAX_PUBLICATION_FILE_BYTES } from "../shared/publication";

export async function buildSite(archive: string, out: string, options: BuildOptions = {}, bundle = bundleReader): Promise<{ files: number; lines: number; generation: string }> {
  const raw = readRawArchive(archive, options);
  reportSkipped(raw);
  const { files } = buildSiteData(fold(raw.lines));
  const descriptor = parseArchive(files.get("archive.json"));
  descriptor.provenance = provenance(raw, archive, fileURLToPath(new URL("..", import.meta.url)), options);
  const serialized = new Map<string, string>();
  for (const [path, value] of files) {
    if (path === "archive.json") continue;
    if (path === "users.json") parseUsersFile(value);
    else if (path.startsWith("c/")) parseMonthFile(value);
    else if (path.startsWith("search/")) parseSearchRows(value);
    else throw new Error(`Unknown publication file: ${path}`);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_PUBLICATION_FILE_BYTES) throw new Error(`${path} exceeds the reader limit of ${MAX_PUBLICATION_FILE_BYTES} bytes. Split the archive before publication.`);
    serialized.set(path, json);
  }
  let generation = "";
  await publishOutput(out, "site", async (stage) => {
    const bundled = await bundle(stage);
    const digest = createHash("sha256").update("rejgau-publication-generation-v1\0").update(bundled.fingerprint);
    digest.update(JSON.stringify({ ...descriptor, built_at: undefined }));
    for (const [path, text] of [...serialized].sort(([a], [b]) => a.localeCompare(b))) digest.update(`${Buffer.byteLength(path)}:${path}:${Buffer.byteLength(text)}:`).update(text);
    generation = digest.digest("hex");
    for (const [path, text] of serialized) writeOutputFile(stage, `data/generations/${generation}/${path}`, text);
    descriptor.generation = generation;
    descriptor.data_root = `generations/${generation}/`;
    parseArchive(descriptor);
    const json = JSON.stringify(descriptor);
    if (Buffer.byteLength(json) > MAX_PUBLICATION_FILE_BYTES) throw new Error("archive.json exceeds the reader size limit");
    writeOutputFile(stage, "data/archive.json", json);
  }, options);
  return { files: files.size, lines: raw.lines.length, generation };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = async () => {
    const { archive, out, options } = buildArgs();
    const result = await buildSite(archive, out, options);
    console.log(`built ${result.files} data files from ${result.lines} records into ${out} (generation ${result.generation})`);
  };
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
