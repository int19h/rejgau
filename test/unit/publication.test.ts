import { describe, expect, it } from "vitest";
import { parseArchive, parseMessageBody, parseMonthFile, parseSearchRows, parseUsersFile } from "../../shared/publication";
import { fold, type RawLine } from "../../tools/fold";
import { buildSiteData } from "../../tools/sitedata";

const messageId = "1554541602075316245";
const raw = (t: string, d: unknown, seconds: number): RawLine => ({ t, d, src: "gw", at: new Date(Date.UTC(2026, 8, 1) + seconds * 1000).toISOString() });
const files = () => buildSiteData(fold([
  raw("GUILD_SNAPSHOT", { id: "99", name: "Archive" }, 0),
  raw("CHANNEL_SELECTED", { channel: { id: "11", name: "Channel", type: 0 } }, 1),
  raw("MESSAGE_CREATE", {
    id: messageId, channel_id: "11", author: { id: "7", username: "Author" }, content: "Visible",
    attachments: [{ id: "8", url: "https://example.test/image.png", width: null, height: 100 }],
    embeds: [{ title: "Title", fields: [{ name: "Field", value: "Value", inline: true }] }],
    components: [{ type: 17, components: [{ type: 10, content: "Component text" }] }],
    poll: { answers: [{ answer_id: 1, poll_media: { text: "Answer" } }], results: { answer_counts: [{ id: 1, count: 0 }] } },
  }, 2),
]), "2026-10-02T00:00:00Z").files;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

it("round-trips generated publication files through the shared contract", () => {
  const built = files();
  expect(parseArchive(clone(built.get("archive.json"))).format).toBe(1);
  expect(parseUsersFile(clone(built.get("users.json"))).users["7"].username).toBe("Author");
  expect(parseSearchRows(clone(built.get("search/2026-09.json")))[0].id).toBe(messageId);
  expect(parseMonthFile(clone(built.get("c/11/2026-09.json"))).messages[0].components?.[0].components?.[0].content).toBe("Component text");
});

it("accepts legacy manifests and requires a matching immutable generation path", () => {
  const archive = parseArchive(clone(files().get("archive.json")));
  expect(archive.data_root).toBeUndefined();
  const generation = "a".repeat(64);
  expect(parseArchive({ ...archive, generation, data_root: `generations/${generation}/` }).generation).toBe(generation);
  for (const extra of [
    { generation },
    { data_root: `generations/${generation}/` },
    { generation, data_root: "../../private/" },
    { generation, data_root: `generations/${"b".repeat(64)}/` },
    { generation: "not-a-digest", data_root: "generations/not-a-digest/" },
  ]) expect(() => parseArchive({ ...archive, ...extra })).toThrow(/generation|data_root/);
});

it("requires consistent provenance counts without accepting paths as revisions", () => {
  const archive = parseArchive(clone(files().get("archive.json")));
  const provenance = { renderer_revision: "a".repeat(40), archive_digest: "b".repeat(64), raw_records: 5, skipped_records: 1, incomplete: true };
  expect(parseArchive({ ...archive, provenance }).provenance).toEqual(provenance);
  expect(() => parseArchive({ ...archive, provenance: { ...provenance, incomplete: false } })).toThrow(/incomplete/);
  expect(() => parseArchive({ ...archive, provenance: { renderer_revision: "/home/user/private" } })).toThrow(/revision/);
});

it("rejects unsupported formats and malformed channel trees", () => {
  const archive = parseArchive(clone(files().get("archive.json")));
  expect(() => parseArchive({ ...archive, format: 2 })).toThrow(/supported format 1/);
  expect(() => parseArchive({ ...archive, channels: { "11": { ...archive.channels["11"], parent_id: "11" } } })).toThrow(/ancestor/);
  expect(() => parseArchive({ ...archive, channels: { "11": { ...archive.channels["11"], months: { "2026-13": 1 } } } })).toThrow(/month/);
});

describe("malformed publication bodies", () => {
  it.each([
    { content: {} },
    { attachments: [{ id: "8", filename: {} }] },
    { embeds: [{ fields: {} }] },
    { components: [{ type: 17, components: {} }] },
    { poll: { answers: [{ answer_id: "1" }] } },
    { message_snapshots: [{ message: { embeds: "invalid" } }] },
  ])("rejects malformed consumed fields: %j", (body) => {
    expect(() => parseMessageBody(body)).toThrow(/Invalid publication data/);
  });

  it("preserves unknown source extensions", () => {
    const value = { content: "text", new_discord_feature: { flags: 42 } };
    expect(parseMessageBody(value)).toBe(value);
  });

  it("rejects excessive component nesting without exhausting the stack", () => {
    let component: unknown = { type: 10, content: "text" };
    for (let i = 0; i < 66; i++) component = { type: 17, components: [component] };
    expect(() => parseMessageBody({ components: [component] })).toThrow(/64 levels/);
  });
});

it("rejects missing snapshot references, invalid IDs, and old deleted message content", () => {
  const month = parseMonthFile(clone(files().get("c/11/2026-09.json")));
  expect(() => parseMonthFile({ ...month, users: {} })).toThrow(/snapshot key/);
  expect(() => parseMonthFile({ ...month, messages: [{ ...month.messages[0], id: "../outside" }] })).toThrow(/Discord ID/);
  expect(() => parseMonthFile({ ...month, messages: [{ ...month.messages[0], edits: [] }] })).toThrow(/current undeleted/);
  expect(() => parseMonthFile({ ...month, messages: [{ ...month.messages[0], referenced: { deleted: true, content: "secret" } }] })).toThrow(/deletion marker/);
});
