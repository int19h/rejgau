import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const supplied = process.argv.slice(2);
const args: string[] = [];
for (let i = 0; i < supplied.length; i++) {
  const value = supplied[i];
  if (value === "--dry-run") args.push(value);
  else if (value === "--outdir" && supplied[i + 1] && !supplied[i + 1].startsWith("--")) args.push(value, supplied[++i]);
  else throw new Error(`Unsupported deployment argument: ${value}`);
}

const git = (...argv: string[]) => execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
if (git("status", "--porcelain")) throw new Error("Commit or remove local changes before deployment. The version must identify exact source files.");
const revision = git("rev-parse", "HEAD");
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Git did not return a full commit ID.");
console.log(`Worker source: ${revision}`);
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
  "deploy", "--tag", revision, "--message", `Source int19h/rejgau@${revision}`, ...args,
], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
