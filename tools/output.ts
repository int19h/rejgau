import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

export type OutputKind = "site" | "logs";
export const OWNERSHIP_FILE = ".rejgau-output.json";
const MAX_FILES = 100_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

interface Ownership {
  version: 1;
  kind: OutputKind;
  files: Record<string, string>;
}

interface Operation {
  path: string;
  hadOriginal: boolean;
}

interface Journal {
  version: 1;
  target: string;
  kind: OutputKind;
  pid: number;
  stage: string;
  backup: string;
  operations: Operation[];
  directories: string[];
  rootCreated: boolean;
  committed: boolean;
}

export interface PublishOptions {
  adoptExisting?: boolean;
  /** Tests can stop a promotion after prior operations complete. */
  beforePromote?: (path: string, index: number) => void;
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const present = (path: string) => {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export function safeRelativePath(path: string): string {
  if (!path || path.length > 4096 || isAbsolute(path) || win32.isAbsolute(path) || /[\\\u0000-\u001f\u007f:]/.test(path) || posix.normalize(path) !== path) {
    throw new Error(`Unsafe output path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || [".git", ".hg", ".svn"].includes(part.toLowerCase()))) {
    throw new Error(`Unsafe output path: ${JSON.stringify(path)}`);
  }
  return path;
}

function generatedPath(kind: OutputKind, path: string): void {
  safeRelativePath(path);
  const id = "[1-9][0-9]{0,19}";
  const month = "[0-9]{4}-(?:0[1-9]|1[0-2])";
  const hash = "[a-f0-9]{64}";
  const valid = kind === "site"
    ? path === "index.html" || /^(?:reader\.(?:js|css)(?:\.map)?|reader-[a-f0-9]{64}\.(?:js|css)(?:\.map)?)$/.test(path)
      || new RegExp(`^data/(?:archive\\.json|(?:generations/${hash}/)?(?:users\\.json|c/${id}/${month}\\.json|search/${month}\\.json))$`).test(path)
    : path === "README.md" || path === "build-info.json" || /^[^/.][^/]*\/(?:README\.md|[0-9]{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12][0-9]|3[01])(?:\/[^/.][^/]*)?\.md)$/.test(path);
  if (!valid) throw new Error(`Path is outside the reserved ${kind} output: ${path}`);
}

/** Resolve inside one fixed root. Existing components must never be symbolic links. */
export function outputPath(root: string, path: string): string {
  safeRelativePath(path);
  const target = resolve(root, ...path.split("/"));
  if (!target.startsWith(resolve(root) + sep)) throw new Error(`Output path escapes its root: ${path}`);
  let current = root;
  const rootStat = present(root);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) throw new Error(`Output root must be a real directory: ${root}`);
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const stat = present(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Output contains a symbolic link: ${current}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Output parent is not a directory: ${current}`);
    if (i === parts.length - 1 && !stat.isFile()) throw new Error(`Output target is not a regular file: ${current}`);
  }
  return target;
}

export function writeOutputFile(root: string, path: string, content: string | Uint8Array): void {
  const target = outputPath(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function readJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA_BYTES) throw new Error(`Unsafe build metadata: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function readOwnership(root: string, kind: OutputKind): Ownership | undefined {
  const path = outputPath(root, OWNERSHIP_FILE);
  if (!present(path)) return undefined;
  const value = record(readJson(path), "output ownership manifest");
  if (value.version !== 1 || value.kind !== kind) throw new Error("Output ownership manifest has a different format or output kind");
  const files = record(value.files, "owned files");
  if (Object.keys(files).length > MAX_FILES) throw new Error("Output ownership manifest exceeds the file limit");
  let bytes = 0;
  for (const [name, hash] of Object.entries(files)) {
    generatedPath(kind, name);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid ownership hash: ${name}`);
    const file = outputPath(root, name);
    const stat = present(file);
    if (stat && (bytes += stat.size) > MAX_BYTES) throw new Error("Existing generated output exceeds the byte limit");
    if (stat && sha(readFileSync(file)) !== hash) throw new Error(`Generated file changed outside the builder: ${name}`);
  }
  return value as unknown as Ownership;
}

function inventory(root: string, kind: OutputKind): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  let count = 0;
  let bytes = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > 20) throw new Error("Generated output exceeds the directory depth limit");
    for (const name of readdirSync(dir).sort()) {
      if (++count > MAX_FILES) throw new Error("Generated output exceeds the file limit");
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Generated output contains a symbolic link: ${file}`);
      if (stat.isDirectory()) visit(file, depth + 1);
      else {
        const path = relative(root, file).split(sep).join("/");
        generatedPath(kind, path);
        if (!stat.isFile()) throw new Error(`Generated output is not a regular file: ${path}`);
        if ((bytes += stat.size) > MAX_BYTES) throw new Error("Generated output exceeds the byte limit");
        files[path] = sha(readFileSync(file));
      }
    }
  };
  visit(root, 0);
  return files;
}

/** Adoption only claims files with the old generator's paths and content markers. */
function legacyOwnership(root: string, kind: OutputKind): Ownership {
  const files: Record<string, string> = Object.create(null);
  const marker = kind === "site" ? "data/archive.json" : "README.md";
  const markerPath = outputPath(root, marker);
  if (!present(markerPath)) throw new Error("Cannot adopt output without its legacy archive marker");
  if (kind === "site") {
    const archive = record(readJson(markerPath), "legacy archive descriptor");
    if (archive.format !== 1 || typeof archive.built_at !== "string" || !archive.channels || !archive.guild) throw new Error("Unrecognized legacy site output");
  } else if (!readFileSync(markerPath, "utf8").includes("Rendered by rejgau from the raw logs")) throw new Error("Unrecognized legacy log output");
  let entries = 0;
  let bytes = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > 20) throw new Error("Legacy output exceeds the directory depth limit");
    for (const name of readdirSync(dir).sort()) {
      if ([".git", ".hg", ".svn"].includes(name.toLowerCase())) continue;
      if (++entries > MAX_FILES) throw new Error("Legacy output exceeds the entry limit");
      const file = join(dir, name);
      const path = relative(root, file).split(sep).join("/");
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Legacy output contains a symbolic link: ${path}`);
      if (stat.isDirectory()) { visit(file, depth + 1); continue; }
      try { generatedPath(kind, path); } catch { continue; }
      if (!stat.isFile()) throw new Error(`Legacy generated path is not a file: ${path}`);
      if ((bytes += stat.size) > MAX_BYTES) throw new Error("Legacy output exceeds the byte limit");
      const content = readFileSync(file);
      if (kind === "logs" && path !== "README.md" && !new TextDecoder().decode(content).includes("times are UTC</sub>")) continue;
      files[path] = sha(content);
    }
  };
  visit(root, 0);
  return { version: 1, kind, files };
}

export function serializeBuildMetadata(value: unknown): string {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new Error("Build metadata exceeds the 32 MiB limit");
  return text;
}

function saveJournal(lock: string, journal: Journal): void {
  writeFileSync(`${lock}.new`, serializeBuildMetadata(journal), { mode: 0o600, flag: "wx" });
  renameSync(`${lock}.new`, lock);
}

function readJournal(lock: string, target: string, prefix: string): Journal {
  const value = record(readJson(lock), "build journal");
  if (value.version !== 1 || value.target !== target || !["site", "logs"].includes(String(value.kind)) || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1) throw new Error(`Invalid build journal: ${lock}`);
  for (const key of ["stage", "backup"] as const) {
    const path = value[key];
    if (typeof path !== "string" || dirname(path) !== dirname(target) || !basename(path).startsWith(`${prefix}-${key}-`)) throw new Error(`Unsafe build journal ${key}`);
    const stat = present(path);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Unsafe build journal directory: ${path}`);
  }
  if (!Array.isArray(value.operations) || value.operations.length > MAX_FILES * 2 || !Array.isArray(value.directories) || value.directories.length > MAX_FILES * 4) throw new Error("Invalid build journal operations");
  const operations = new Set<string>();
  for (const item of value.operations) {
    const op = record(item, "build journal operation");
    if (typeof op.path !== "string" || typeof op.hadOriginal !== "boolean") throw new Error("Invalid build journal operation");
    if (op.path !== OWNERSHIP_FILE) generatedPath(value.kind as OutputKind, op.path);
    if (operations.has(op.path)) throw new Error("Duplicate build journal operation");
    operations.add(op.path);
  }
  for (const path of value.directories) {
    if (typeof path !== "string") throw new Error("Invalid build journal directory");
    safeRelativePath(path);
  }
  if (typeof value.rootCreated !== "boolean" || typeof value.committed !== "boolean") throw new Error("Invalid build journal state");
  return value as unknown as Journal;
}

function rollback(journal: Journal): void {
  for (const operation of [...journal.operations].reverse()) {
    const target = outputPath(journal.target, operation.path);
    const backup = outputPath(journal.backup, operation.path);
    if (present(backup)) {
      if (present(target)) unlinkSync(target);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(backup, target);
    } else if (!operation.hadOriginal && present(target)) unlinkSync(target);
  }
  for (const path of [...journal.directories].reverse()) {
    const dir = directoryPath(journal.target, path);
    const stat = present(dir);
    if (stat?.isSymbolicLink() || stat && !stat.isDirectory()) throw new Error(`Unsafe rollback directory: ${dir}`);
    try { rmdirSync(dir); } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  if (journal.rootCreated) {
    try { rmdirSync(journal.target); } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

function cleanup(lock: string, journal: Journal): void {
  rmSync(journal.stage, { recursive: true, force: true });
  rmSync(journal.backup, { recursive: true, force: true });
  rmSync(`${lock}.new`, { force: true });
  unlinkSync(lock);
}

function recover(lock: string, target: string, prefix: string): void {
  if (!present(lock)) return;
  const journal = readJournal(lock, target, prefix);
  let live = true;
  try { process.kill(journal.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") live = false;
    else throw error;
  }
  if (live) throw new Error(`Another build holds ${lock} (PID ${journal.pid})`);
  if (!journal.committed) rollback(journal);
  cleanup(lock, journal);
}

function planParents(target: string, path: string, directories: Set<string>): void {
  const parts = path.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join("/");
    const dir = directoryPath(target, rel);
    if (!present(dir)) directories.add(rel);
  }
}

function directoryPath(root: string, path: string): string {
  safeRelativePath(path);
  let current = root;
  for (const part of ["", ...path.split("/")]) {
    current = part ? join(current, part) : current;
    const stat = present(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Output directory is unsafe: ${current}`);
  }
  return current;
}

/** Stage complete files first. Each rename is atomic. Caught promotion failures restore prior files. */
export async function publishOutput(targetPath: string, kind: OutputKind, produce: (stage: string) => Promise<void>, options: PublishOptions = {}): Promise<void> {
  const absolute = resolve(targetPath);
  if (absolute === dirname(absolute)) throw new Error("The filesystem root cannot be a build output");
  mkdirSync(dirname(absolute), { recursive: true });
  const parent = realpathSync(dirname(absolute));
  const target = join(parent, basename(absolute));
  let originalRoot = present(target);
  if (originalRoot && (!originalRoot.isDirectory() || originalRoot.isSymbolicLink())) throw new Error(`Output root must be a real directory: ${target}`);
  const prefix = `.rejgau-${sha(target).slice(0, 20)}`;
  const lock = join(parent, `${prefix}.lock`);
  const gate = `${lock}.guard`;
  let gateFd: number;
  try { gateFd = openSync(gate, "wx", 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Build recovery gate exists: ${gate}. Wait for the other builder to finish. If it stopped, confirm no builder for ${target} is running, remove only this .guard file, then run the build again.`);
  }
  let journal: Journal;
  try {
    writeFileSync(gateFd, JSON.stringify({ pid: process.pid, target }));
    // Hold this gate until recovery finishes and the new live journal exists.
    // Never reclaim a stale gate: another recovery may already have read it.
    recover(lock, target, prefix);
    originalRoot = present(target);
    const stage = mkdtempSync(join(parent, `${prefix}-stage-`));
    let backup: string | undefined;
    try {
      backup = mkdtempSync(join(parent, `${prefix}-backup-`));
      journal = {
        version: 1, target, kind, pid: process.pid, stage, backup,
        operations: [], directories: [], rootCreated: false, committed: false,
      };
      const fd = openSync(lock, "wx", 0o600);
      try { writeFileSync(fd, serializeBuildMetadata(journal)); } finally { closeSync(fd); }
    } catch (error) {
      rmSync(stage, { recursive: true });
      if (backup) rmSync(backup, { recursive: true });
      throw error;
    }
  } finally {
    closeSync(gateFd);
    unlinkSync(gate);
  }
  try {
    await produce(journal.stage);
    const files = inventory(journal.stage, kind);
    let previous = readOwnership(target, kind);
    if (!previous && options.adoptExisting) previous = legacyOwnership(target, kind);
    const oldFiles = previous?.files ?? {};
    for (const path of new Set([...Object.keys(oldFiles), ...Object.keys(files)])) {
      const file = outputPath(target, path);
      if (present(file) && !Object.hasOwn(oldFiles, path)) {
        throw new Error(`Refusing to replace unowned output file: ${path}. For old rejgau output, use --adopt-existing.`);
      }
    }
    const ownership: Ownership = { version: 1, kind, files };
    writeOutputFile(journal.stage, OWNERSHIP_FILE, serializeBuildMetadata(ownership));
    const currentRoot = present(target);
    if (originalRoot && (!currentRoot || originalRoot.dev !== currentRoot.dev || originalRoot.ino !== currentRoot.ino)) throw new Error("Output root changed during the build");
    const paths = [...new Set([...Object.keys(oldFiles), ...Object.keys(files), OWNERSHIP_FILE])];
    const rank = (path: string) => path === OWNERSHIP_FILE ? 4 : path === "data/archive.json" ? 3 : path === "index.html" || path === "README.md" ? 2 : Object.hasOwn(files, path) ? 0 : 1;
    paths.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const directories = new Set<string>();
    for (const path of paths) {
      const destination = outputPath(target, path);
      if (path !== OWNERSHIP_FILE && files[path] && files[path] === oldFiles[path] && present(destination)) continue;
      journal.operations.push({ path, hadOriginal: !!present(destination) });
      planParents(target, path, directories);
    }
    journal.directories = [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    journal.rootCreated = !currentRoot;
    // Persist the whole plan before changing output. Unstarted operations are safe to undo.
    saveJournal(lock, journal);
    if (journal.rootCreated) mkdirSync(target);
    for (const path of journal.directories) mkdirSync(directoryPath(target, path));
    let index = 0;
    for (const { path, hadOriginal } of journal.operations) {
      const destination = outputPath(target, path);
      const source = outputPath(journal.stage, path);
      options.beforePromote?.(path, index++);
      if (hadOriginal) {
        const backup = outputPath(journal.backup, path);
        mkdirSync(dirname(backup), { recursive: true });
        renameSync(destination, backup);
      }
      if (present(source)) renameSync(source, destination);
    }
    journal.committed = true;
    saveJournal(lock, journal);
  } catch (error) {
    try {
      rollback(journal);
      cleanup(lock, journal);
    } catch (recoveryError) {
      throw new Error(`Build failed. Recovery also failed. Keep ${lock} for the next build. ${String(recoveryError)}`, { cause: error });
    }
    throw error;
  }
  // Remove empty directories left by obsolete generated files. Unowned files stay in place.
  for (const path of journal.operations.map((operation) => dirname(operation.path)).sort((a, b) => b.length - a.length)) {
    if (path === ".") continue;
    let dir = join(target, path);
    while (dir !== target) {
      const stat = present(dir);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) break;
      try { rmdirSync(dir); } catch { break; }
      dir = dirname(dir);
    }
  }
  cleanup(lock, journal);
}
