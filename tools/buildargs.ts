import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { Provenance } from "../shared/publication";
import type { RawArchive, RawOptions } from "./raw";

export interface BuildOptions extends RawOptions {
  adoptExisting?: boolean;
  rendererRevision?: string;
  archiveRevision?: string;
  source?: string;
}

export function buildArgs(args = process.argv.slice(2)): { archive: string; out: string; options: BuildOptions } {
  const { values } = parseArgs({ args, options: {
    archive: { type: "string" }, out: { type: "string" }, source: { type: "string" },
    "renderer-revision": { type: "string" }, "archive-revision": { type: "string" },
    "adopt-existing": { type: "boolean", default: false }, "skip-bad-lines": { type: "boolean", default: false },
    "max-raw-bytes": { type: "string" }, "max-records": { type: "string" }, "max-line-bytes": { type: "string" },
    "max-files": { type: "string" }, "max-depth": { type: "string" },
  } });
  if (!values.archive || !values.out) throw new Error("Both --archive and --out are required");
  const limits: NonNullable<RawOptions["limits"]> = {};
  for (const [flag, key] of [["max-raw-bytes", "maxBytes"], ["max-records", "maxRecords"], ["max-line-bytes", "maxLineBytes"], ["max-files", "maxFiles"], ["max-depth", "maxDepth"]] as const) {
    const value = values[flag];
    if (value === undefined) continue;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${flag} requires a positive integer`);
    limits[key] = Number(value);
  }
  for (const flag of ["renderer-revision", "archive-revision"] as const) {
    const value = values[flag];
    if (value !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error(`--${flag} requires a full lowercase Git commit ID`);
  }
  return { archive: values.archive, out: values.out, options: {
    limits, skipBadLines: values["skip-bad-lines"], adoptExisting: values["adopt-existing"], source: values.source,
    rendererRevision: values["renderer-revision"], archiveRevision: values["archive-revision"],
  } };
}

function revision(root: string): string | undefined {
  try {
    const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 });
    if (dirty.trim()) return undefined;
    const result = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result) ? result : undefined;
  } catch { return undefined; }
}

export function provenance(raw: RawArchive, archive: string, renderer: string, options: BuildOptions): Provenance {
  return {
    renderer_revision: options.rendererRevision ?? revision(renderer),
    archive_revision: options.archiveRevision ?? revision(archive),
    archive_digest: raw.digest,
    raw_bytes: raw.bytes,
    raw_records: raw.lines.length,
    skipped_records: raw.skipped,
    incomplete: raw.skipped > 0,
  };
}

export function reportSkipped(raw: RawArchive): void {
  if (!raw.skipped) return;
  console.warn(`INCOMPLETE BUILD: --skip-bad-lines omitted ${raw.skipped} invalid records.`);
  for (const message of raw.diagnostics) console.warn(message);
}
