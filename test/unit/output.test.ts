import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { OWNERSHIP_FILE, publishOutput, serializeBuildMetadata, writeOutputFile } from "../../tools/output";

const roots: string[] = [];
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), "rejgau-output-test-"));
  roots.push(root);
  return root;
};
const publish = (out: string, files: Record<string, string>, options = {}) => publishOutput(out, "site", async (stage) => {
  for (const [path, text] of Object.entries(files)) writeOutputFile(stage, path, text);
}, options);
const original = { "index.html": "old index", "data/archive.json": "old descriptor", "data/c/11/2026-09.json": "old message" };
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("owned output transaction", () => {
  it("rejects ownership and recovery metadata that the next build cannot read", () => {
    const paths = Array.from({ length: 90_000 }, (_, i) => `${"c".repeat(180)}/2026/10/02/${"t".repeat(180)}-${i}.md`);
    const files = Object.fromEntries(paths.map((path) => [path, "a".repeat(64)]));
    expect(() => serializeBuildMetadata({ version: 1, kind: "logs", files })).toThrow("metadata exceeds");
    const operations = paths.map((path) => ({ path, hadOriginal: false }));
    expect(() => serializeBuildMetadata({ operations })).toThrow("metadata exceeds");
  });

  it("removes obsolete files and preserves unrelated files and .git identity", async () => {
    const out = join(directory(), "site");
    await publish(out, original);
    writeFileSync(join(out, "CNAME"), "example.test");
    mkdirSync(join(out, ".git"));
    writeFileSync(join(out, ".git", "config"), "preserve");
    const inode = lstatSync(join(out, ".git")).ino;
    await publish(out, { "index.html": "new index", "data/archive.json": "new descriptor" });
    expect(existsSync(join(out, "data/c/11/2026-09.json"))).toBe(false);
    expect(readFileSync(join(out, "CNAME"), "utf8")).toBe("example.test");
    expect(lstatSync(join(out, ".git")).ino).toBe(inode);
    expect(readFileSync(join(out, ".git/config"), "utf8")).toBe("preserve");
  });

  it("does not traverse a .git link", async () => {
    const root = directory();
    const out = join(root, "site");
    await publish(out, original);
    symlinkSync(join(root, "absent-gitdir"), join(out, ".git"));
    await publish(out, original);
    expect(lstatSync(join(out, ".git")).isSymbolicLink()).toBe(true);
  });

  it("rejects unowned collisions and changed owned files", async () => {
    const out = directory();
    writeFileSync(join(out, "index.html"), "human file");
    await expect(publish(out, original)).rejects.toThrow("unowned");
    expect(readFileSync(join(out, "index.html"), "utf8")).toBe("human file");
    rmSync(join(out, "index.html"));
    await publish(out, original);
    writeFileSync(join(out, "index.html"), "manual edit");
    await expect(publish(out, original)).rejects.toThrow("changed outside");
  });

  it.each(["../outside", "/tmp/outside", "data/../../outside", ".git/config", "data\\outside", "notes.txt"])("rejects hostile ownership path %s", async (path) => {
    const out = directory();
    writeFileSync(join(out, OWNERSHIP_FILE), JSON.stringify({ version: 1, kind: "site", files: { [path]: "a".repeat(64) } }));
    await expect(publish(out, original)).rejects.toThrow();
    expect(existsSync(join(out, "index.html"))).toBe(false);
  });

  it("rejects linked output roots and generated ancestors", async () => {
    const root = directory();
    const real = join(root, "real");
    mkdirSync(real);
    const out = join(root, "link");
    symlinkSync(real, out);
    await expect(publish(out, original)).rejects.toThrow("real directory");
    symlinkSync(real, join(real, "data"));
    await expect(publish(real, original)).rejects.toThrow("symbolic link");
    expect(existsSync(join(real, "archive.json"))).toBe(false);
  });

  it("rejects traversal from generated paths before any promotion", async () => {
    const root = directory();
    await expect(publishOutput(join(root, "site"), "site", async (stage) => { writeOutputFile(stage, "../outside", "bad"); })).rejects.toThrow("Unsafe output path");
    expect(existsSync(join(root, "outside"))).toBe(false);
  });

  it("keeps output intact after staging or promotion failures", async () => {
    const root = directory();
    const out = join(root, "site");
    await publish(out, original);
    const manifest = readFileSync(join(out, OWNERSHIP_FILE), "utf8");
    await expect(publishOutput(out, "site", async () => { throw new Error("bundle failed"); })).rejects.toThrow("bundle failed");
    await expect(publish(out, { "index.html": "new index", "data/archive.json": "new descriptor", "data/users.json": "new users" }, {
      beforePromote: (path: string) => { if (path === "data/archive.json") throw new Error("promotion failed"); },
    })).rejects.toThrow("promotion failed");
    for (const [path, text] of Object.entries(original)) expect(readFileSync(join(out, path), "utf8")).toBe(text);
    expect(readFileSync(join(out, OWNERSHIP_FILE), "utf8")).toBe(manifest);
    expect(existsSync(join(out, "data/users.json"))).toBe(false);
    expect(readdirSync(root)).toEqual(["site"]);
  });

  it("recovers a process death after earlier backup and promotion operations", async () => {
    const root = directory();
    const out = join(root, "site");
    await publish(out, original);
    const module = pathToFileURL(resolve("tools/output.ts")).href;
    const program = `import {publishOutput,writeOutputFile} from ${JSON.stringify(module)}; await publishOutput(${JSON.stringify(out)},"site",async stage=>{writeOutputFile(stage,"index.html","new index");writeOutputFile(stage,"data/archive.json","new descriptor");},{beforePromote:path=>{if(path==="data/archive.json")process.exit(77);}});`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { cwd: process.cwd(), encoding: "utf8" });
    expect(child.status, child.stderr).toBe(77);
    expect(readFileSync(join(out, "index.html"), "utf8")).toBe("new index");
    await expect(publishOutput(out, "site", async () => { throw new Error("stop after recovery"); })).rejects.toThrow("stop after recovery");
    for (const [path, text] of Object.entries(original)) expect(readFileSync(join(out, path), "utf8")).toBe(text);
    expect(readdirSync(root)).toEqual(["site"]);
  });

  it("serializes stale journal recovery before creating a new live journal", async () => {
    const root = directory();
    const out = join(root, "site");
    mkdirSync(out);
    const prefix = `.rejgau-${createHash("sha256").update(out).digest("hex").slice(0, 20)}`;
    const lock = join(root, `${prefix}.lock`);
    const stage = join(root, `${prefix}-stage-old`);
    const backup = join(root, `${prefix}-backup-old`);
    mkdirSync(stage);
    mkdirSync(backup);
    writeFileSync(lock, JSON.stringify({ version: 1, target: out, kind: "site", pid: 99_999_999, stage, backup, operations: [], directories: [], rootCreated: false, committed: false }));
    const paused = join(root, "paused");
    const release = join(root, "release");
    const module = pathToFileURL(resolve("tools/output.ts")).href;
    const program = `import {writeFileSync,existsSync} from "node:fs"; import {publishOutput} from ${JSON.stringify(module)}; process.kill=()=>{writeFileSync(${JSON.stringify(paused)},"");while(!existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);throw Object.assign(new Error("dead"),{code:"ESRCH"});}; await publishOutput(${JSON.stringify(out)},"site",async()=>{throw new Error("stop after recovery");}).catch(e=>{if(!e.message.includes("stop after recovery"))throw e;});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { cwd: process.cwd(), stdio: "ignore" });
    const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
    try {
      for (let attempt = 0; !existsSync(paused) && attempt < 500; attempt++) await delay(10);
      expect(existsSync(paused)).toBe(true);
      let entered = false;
      await expect(publishOutput(out, "site", async () => { entered = true; })).rejects.toThrow("Build recovery gate exists");
      expect(entered).toBe(false);
      expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(99_999_999);
      writeFileSync(release, "");
      expect(await done).toBe(0);
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(`${lock}.guard`)).toBe(false);
    } finally {
      writeFileSync(release, "");
      if (child.exitCode === null) child.kill();
      await done;
    }
  }, 10_000);

  it("keeps an abandoned recovery gate for explicit operator recovery", async () => {
    const root = directory();
    const out = join(root, "site");
    const prefix = `.rejgau-${createHash("sha256").update(out).digest("hex").slice(0, 20)}`;
    const gate = join(root, `${prefix}.lock.guard`);
    writeFileSync(gate, JSON.stringify({ pid: 99_999_999, target: out }));
    await expect(publish(out, original)).rejects.toThrow("confirm no builder");
    expect(existsSync(gate)).toBe(true);
    expect(existsSync(out)).toBe(false);
  });

  it("requires explicit legacy adoption and then removes old generated files", async () => {
    const out = directory();
    mkdirSync(join(out, "data/c/11"), { recursive: true });
    writeFileSync(join(out, "index.html"), "old index");
    writeFileSync(join(out, "data/archive.json"), JSON.stringify({ format: 1, built_at: "2026-09-29T00:00:00Z", channels: {}, guild: {} }));
    writeFileSync(join(out, "data/c/11/2026-09.json"), "removed channel");
    writeFileSync(join(out, "CNAME"), "example.test");
    const next = { "index.html": "new index", "data/archive.json": "new descriptor" };
    await expect(publish(out, next)).rejects.toThrow("--adopt-existing");
    await publish(out, next, { adoptExisting: true });
    expect(existsSync(join(out, "data/c/11/2026-09.json"))).toBe(false);
    expect(readFileSync(join(out, "CNAME"), "utf8")).toBe("example.test");
    expect(existsSync(join(out, OWNERSHIP_FILE))).toBe(true);
  });
});
