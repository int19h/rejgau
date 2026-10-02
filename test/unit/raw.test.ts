import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRawLine, readRawArchive } from "../../tools/raw";

const roots: string[] = [];
const line = (t = "CHANNEL_SELECTED", d: unknown = { channel: { id: "11", type: 0, name: "general" } }) => ({ at: "2026-09-29T00:00:00Z", src: "rejgau", t, d });
const archive = (text: string) => {
  const root = mkdtempSync(join(tmpdir(), "rejgau-raw-test-"));
  roots.push(root);
  mkdirSync(join(root, "raw"));
  writeFileSync(join(root, "raw", "guild.jsonl"), text);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("raw input boundary", () => {
  it("keeps stable order and a digest of the exact source bytes", () => {
    const root = archive(JSON.stringify(line()));
    writeFileSync(join(root, "raw", "11.jsonl"), JSON.stringify(line("MESSAGE_DELETE", { id: "22", channel_id: "11" })));
    const first = readRawArchive(root);
    expect(first.lines.map((record) => record.t)).toEqual(["CHANNEL_SELECTED", "MESSAGE_DELETE"]);
    expect(readRawArchive(root).digest).toBe(first.digest);
    writeFileSync(join(root, "raw", "11.jsonl"), JSON.stringify(line("MESSAGE_DELETE", { id: "23", channel_id: "11" })));
    expect(readRawArchive(root).digest).not.toBe(first.digest);
  });

  it.each([null, [], {}, line("MESSAGE_CREATE", { id: "12", channel_id: "../escape" }), line("MESSAGE_CREATE", { id: "0", channel_id: "11" }), line("MESSAGE_CREATE", { id: "18446744073709551616", channel_id: "11" }), line("MESSAGE_CREATE", { id: "12", channel_id: "11", content: 3 })])("rejects malformed records %j", (value) => {
    expect(() => parseRawLine(value)).toThrow();
  });

  it("rejects prototype keys before folding", () => {
    const value = JSON.parse('{"at":"2026-09-29T00:00:00Z","src":"gw","t":"MESSAGE_UPDATE","d":{"id":"12","channel_id":"11","__proto__":{"x":1}}}');
    expect(() => parseRawLine(value)).toThrow("forbidden key");
  });

  it("rejects source arrays instead of changing Gateway partial-update semantics", () => {
    const value = { ...line("MESSAGE_UPDATE", { id: "12", channel_id: "11", content: "edited" }), src: ["gw"] };
    const root = archive(`${JSON.stringify(line())}\n${JSON.stringify(value)}\n`);
    expect(() => readRawArchive(root)).toThrow("record.src");
    const result = readRawArchive(root, { skipBadLines: true });
    expect(result.lines).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.diagnostics[0]).toContain("record.src");
  });

  it("fails by default and records every skipped record only with explicit opt-in", () => {
    const root = archive(`${JSON.stringify(line())}\n{broken}\nnull\n`);
    expect(() => readRawArchive(root)).toThrow("guild.jsonl:2");
    const result = readRawArchive(root, { skipBadLines: true });
    expect(result.lines).toHaveLength(1);
    expect(result.skipped).toBe(2);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[1]).toContain("guild.jsonl:3");
  });

  it("rejects invalid UTF-8", () => {
    const root = archive("");
    writeFileSync(join(root, "raw", "guild.jsonl"), Buffer.from([0xff]));
    expect(() => readRawArchive(root)).toThrow();
  });

  it("enforces byte, record, line, entry, and depth limits", () => {
    const text = JSON.stringify(line());
    const root = archive(`${text}\n${text}\n`);
    expect(() => readRawArchive(root, { limits: { maxBytes: 1 } })).toThrow("byte limit");
    expect(() => readRawArchive(root, { limits: { maxRecords: 1 } })).toThrow("record limit");
    expect(() => readRawArchive(root, { limits: { maxLineBytes: 2 }, skipBadLines: true })).toThrow("line exceeds");
    mkdirSync(join(root, "raw", "one", "two"), { recursive: true });
    expect(() => readRawArchive(root, { limits: { maxFiles: 1 } })).toThrow("entry limit");
    expect(() => readRawArchive(root, { limits: { maxDepth: 1 } })).toThrow("depth limit");
  });

  it("rejects linked files and directory cycles", () => {
    const root = archive(JSON.stringify(line()));
    symlinkSync(join(root, "raw"), join(root, "raw", "cycle"));
    expect(() => readRawArchive(root)).toThrow("symbolic link");
    rmSync(join(root, "raw", "cycle"));
    symlinkSync(join(root, "raw", "guild.jsonl"), join(root, "raw", "linked.jsonl"));
    expect(() => readRawArchive(root)).toThrow("symbolic link");
  });
});
