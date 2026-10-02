import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSite } from "../../tools/build";
import { buildLogArchive } from "../../tools/buildlogs";
import { bundleReader } from "../../tools/bundle";
import { buildArgs } from "../../tools/buildargs";
import { fold, type RawLine } from "../../tools/fold";
import { buildLogs } from "../../tools/logs";
import { OWNERSHIP_FILE, writeOutputFile } from "../../tools/output";
import { buildSiteData } from "../../tools/sitedata";

const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "rejgau-build-test-"));
  roots.push(dir);
  return dir;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const snowflake = (date: string, seq = 0) => String((BigInt(Date.parse(date) - 1420070400000) << 22n) + BigInt(seq));
const SEP = snowflake("2026-09-29T00:00:00Z");
const OCT = snowflake("2026-10-01T00:00:00Z");
const line = (t: string, d: any, src: RawLine["src"] = "gw"): RawLine => ({ at: "2026-10-02T00:00:00Z", src, t, d });
const selected = (id: string, name: string) => line("CHANNEL_SELECTED", { channel: { id, name, type: 0 } }, "rejgau");
const message = (id: string, channel: string, content: string) => line("MESSAGE_CREATE", { id, channel_id: channel, type: 0, content, author: { id: "7", username: "Alice" } });
const records = () => [line("GUILD_SNAPSHOT", { id: "1", name: "Test", roles: [] }, "rejgau"), selected("11", "general"), selected("12", "hidden"), message(SEP, "11", "REMOVE_THIS_MONTH"), message(OCT, "11", "KEEP_THIS_MESSAGE"), message(String(BigInt(SEP) + 1n), "12", "REMOVE_THIS_CHANNEL")];
const archive = (dir: string, lines: RawLine[]) => {
  const path = join(dir, "archive");
  mkdirSync(join(path, "raw"), { recursive: true });
  writeFileSync(join(path, "raw", "guild.jsonl"), lines.map((value) => JSON.stringify(value)).join("\n") + "\n");
  return path;
};
const fakeBundle = async (out: string) => {
  const script = "console.log('reader')";
  const name = `reader-${hash(script)}.js`;
  writeOutputFile(out, name, script);
  writeOutputFile(out, "index.html", `<script src="${name}"></script>`);
  return { fingerprint: hash(script) };
};
const textFiles = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  const walk = (path: string) => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (item.isDirectory()) walk(join(path, item.name));
      else files[relative(dir, join(path, item.name))] = readFileSync(join(path, item.name), "utf8");
    }
  };
  walk(dir);
  return files;
};
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("complete builds", () => {
  it("removes deleted months and unselected channels from reused site and logs outputs", async () => {
    const dir = root();
    const lines = records();
    const source = archive(dir, lines);
    const site = join(dir, "site");
    const logs = join(dir, "logs");
    const first = await buildSite(source, site, {}, fakeBundle);
    await buildLogArchive(source, logs);
    writeFileSync(join(site, "CNAME"), "example.test");
    lines.push(line("MESSAGE_DELETE", { id: SEP, channel_id: "11" }), line("CHANNEL_UNSELECTED", { id: "12" }, "rejgau"));
    archive(dir, lines);
    const second = await buildSite(source, site, {}, fakeBundle);
    await buildLogArchive(source, logs);
    expect(second.generation).not.toBe(first.generation);
    expect(existsSync(join(site, "data/generations", first.generation))).toBe(false);
    const descriptor = JSON.parse(readFileSync(join(site, "data/archive.json"), "utf8"));
    expect(descriptor.data_root).toBe(`generations/${second.generation}/`);
    expect(descriptor.channels["11"].months).toEqual({ "2026-10": 1 });
    expect(descriptor.channels["12"]).toBeUndefined();
    const siteText = Object.values(textFiles(site)).join("\n");
    expect(siteText).not.toContain("REMOVE_THIS_MONTH");
    expect(siteText).not.toContain("REMOVE_THIS_CHANNEL");
    expect(siteText).toContain("KEEP_THIS_MESSAGE");
    const logsText = Object.values(textFiles(logs)).join("\n");
    expect(logsText).not.toContain("REMOVE\\_THIS");
    expect(logsText).toContain("KEEP\\_THIS\\_MESSAGE");
    expect(readFileSync(join(site, "CNAME"), "utf8")).toBe("example.test");
  });

  it("keeps generation names stable for identical bytes and changes them for changed renderer bytes", async () => {
    const dir = root();
    const source = archive(dir, records());
    const out = join(dir, "site");
    const one = await buildSite(source, out, {}, fakeBundle);
    const two = await buildSite(source, out, {}, fakeBundle);
    expect(two.generation).toBe(one.generation);
    const before = textFiles(join(out, "data/generations", one.generation));
    const three = await buildSite(source, out, {}, async (stage) => {
      await fakeBundle(stage);
      writeOutputFile(stage, "index.html", "changed template");
      return { fingerprint: hash("changed template and reader") };
    });
    expect(three.generation).not.toBe(one.generation);
    expect(textFiles(join(out, "data/generations", three.generation))).toEqual(before);
  });

  it("publishes provenance and makes explicitly incomplete builds visible", async () => {
    const dir = root();
    const source = archive(dir, records());
    writeFileSync(join(source, "raw", "broken.jsonl"), "{bad}\n");
    const out = join(dir, "site");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await buildSite(source, out, { skipBadLines: true, rendererRevision: "a".repeat(40), archiveRevision: "b".repeat(40) }, fakeBundle);
    const descriptor = JSON.parse(readFileSync(join(out, "data/archive.json"), "utf8"));
    expect(descriptor.provenance).toMatchObject({ renderer_revision: "a".repeat(40), archive_revision: "b".repeat(40), raw_records: 6, skipped_records: 1, incomplete: true });
    expect(descriptor.provenance.archive_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("INCOMPLETE BUILD"));
  });

  it("keeps existing output intact after malformed input or a failed bundle", async () => {
    const dir = root();
    const source = archive(dir, records());
    const out = join(dir, "site");
    await buildSite(source, out, {}, fakeBundle);
    const before = textFiles(out);
    writeFileSync(join(source, "raw", "bad.jsonl"), "null\n");
    await expect(buildSite(source, out, {}, fakeBundle)).rejects.toThrow("bad.jsonl:1");
    expect(textFiles(out)).toEqual(before);
    rmSync(join(source, "raw", "bad.jsonl"));
    await expect(buildSite(source, out, {}, async () => { throw new Error("bundle unavailable"); })).rejects.toThrow("bundle unavailable");
    expect(textFiles(out)).toEqual(before);
  });

  it("rejects a month larger than the reader response limit before publication", async () => {
    const dir = root();
    const source = archive(dir, [selected("11", "general"), ...Array.from({ length: 9 }, (_, i) => message(String(BigInt(SEP) + BigInt(i)), "11", "x".repeat(4_000_000)))]);
    const out = join(dir, "site");
    let bundled = false;
    await expect(buildSite(source, out, {}, async (stage) => { bundled = true; return fakeBundle(stage); })).rejects.toThrow("exceeds the reader limit");
    expect(bundled).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("rejects crafted raw channel paths before creating either output", async () => {
    const dir = root();
    const source = archive(dir, [selected("../../../escaped", ""), message(SEP, "../../../escaped", "bad")]);
    await expect(buildSite(source, join(dir, "site"), {}, fakeBundle)).rejects.toThrow("Discord ID");
    await expect(buildLogArchive(source, join(dir, "logs"))).rejects.toThrow("Discord ID");
    expect(readdirSync(dir)).toEqual(["archive"]);
  });

  it("migrates both original output layouts only with explicit adoption", async () => {
    const dir = root();
    const lines = records();
    const source = archive(dir, lines);
    const site = join(dir, "site");
    const logs = join(dir, "logs");
    mkdirSync(site);
    mkdirSync(logs);
    for (const [path, value] of buildSiteData(fold(lines)).files) writeOutputFile(site, `data/${path}`, JSON.stringify(value));
    writeOutputFile(site, "index.html", "old site");
    writeOutputFile(site, "reader.js", "old reader");
    for (const [path, value] of buildLogs(fold(lines))) writeOutputFile(logs, path, value);
    lines.push(line("MESSAGE_DELETE", { id: SEP, channel_id: "11" }), line("CHANNEL_UNSELECTED", { id: "12" }, "rejgau"));
    archive(dir, lines);
    await expect(buildSite(source, site, {}, fakeBundle)).rejects.toThrow("--adopt-existing");
    await expect(buildLogArchive(source, logs)).rejects.toThrow("--adopt-existing");
    await buildSite(source, site, { adoptExisting: true }, fakeBundle);
    await buildLogArchive(source, logs, { adoptExisting: true });
    expect(existsSync(join(site, "reader.js"))).toBe(false);
    expect(existsSync(join(site, "data/c/11/2026-09.json"))).toBe(false);
    expect(existsSync(join(logs, "hidden/2026/09/29.md"))).toBe(false);
    expect(existsSync(join(logs, OWNERSHIP_FILE))).toBe(true);
  });

  it("rejects ambiguous CLI values and accepts exact revision overrides", () => {
    expect(() => buildArgs(["--archive", "x", "--out", "y", "--max-records", "NaN"])).toThrow("positive integer");
    expect(() => buildArgs(["--archive", "x", "--out", "y", "--renderer-revision", "main"])).toThrow("full lowercase");
    expect(buildArgs(["--archive", "x", "--out", "y", "--archive-revision", "a".repeat(40)]).options.archiveRevision).toBe("a".repeat(40));
  });
});

describe("reader bundle", () => {
  it("handles escaped source paths and uses hashes of actual asset bytes", async () => {
    const dir = root();
    const source = join(dir, "source with spaces 雪 %");
    mkdirSync(join(source, "reader/src"), { recursive: true });
    writeFileSync(join(source, "reader/src/main.tsx"), "console.log('hello');");
    writeFileSync(join(source, "reader/src/styles.css"), "body { color: red; }");
    writeFileSync(join(source, "reader/index.html"), '<link href="reader.css"><script src="reader.js"></script>');
    const out = join(dir, "site");
    await bundleReader(out, pathToFileURL(source + "/"));
    const files = textFiles(out);
    for (const [name, content] of Object.entries(files)) {
      if (name === "index.html") continue;
      expect(name).toContain(hash(content));
    }
    const script = Object.keys(files).find((name) => name.endsWith(".js"))!;
    const map = Object.keys(files).find((name) => name.endsWith(".js.map"))!;
    expect(files["index.html"]).toContain(script);
    expect(files[script]).toContain(`sourceMappingURL=${map}`);
    const first = await bundleReader(join(dir, "second"), pathToFileURL(source + "/"));
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("omits an automatic archive revision when the raw checkout is dirty", async () => {
    const dir = root();
    const source = archive(dir, records());
    const git = (args: string[]) => {
      const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git(["init", "-q"]);
    git(["add", "raw"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Fixture"]);
    const commit = git(["rev-parse", "HEAD"]);
    const out = join(dir, "site");
    await buildSite(source, out, {}, fakeBundle);
    expect(JSON.parse(readFileSync(join(out, "data/archive.json"), "utf8")).provenance.archive_revision).toBe(commit);
    writeFileSync(join(source, "raw", "extra.jsonl"), JSON.stringify(line("CONFIG", { channels: "all" })));
    await buildSite(source, out, {}, fakeBundle);
    expect(JSON.parse(readFileSync(join(out, "data/archive.json"), "utf8")).provenance.archive_revision).toBeUndefined();
  });
});
