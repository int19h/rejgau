import { describe, expect, it } from "vitest";
import { fold, tallyCount, type RawLine } from "../../tools/fold";

let clock = Date.UTC(2026, 8, 1);
const at = () => new Date((clock += 1000)).toISOString();
const gw = (t: string, d: any, s?: number): RawLine => ({ at: at(), src: "gw", sid: "x", s: s ?? Math.floor(clock / 1000), t, d });
const rest = (d: any): RawLine => ({ at: at(), src: "rest", t: "MESSAGE_CREATE", d });
const msg = (extra: any = {}) => ({ id: "100", channel_id: "1", content: "hi", timestamp: "2026-09-01T00:00:00Z", edited_timestamp: null, author: { id: "7", username: "u" }, ...extra });

describe("fold: messages", () => {
  it("records real edits, and merges unfurls / deferred completions silently", () => {
    const st = fold([
      gw("MESSAGE_CREATE", msg({ flags: 128, content: "" })),
      gw("MESSAGE_UPDATE", msg({ flags: 32768, content: "", components: [{ type: 10, content: "done" }] })), // LOADING → V2
      gw("MESSAGE_UPDATE", msg({ flags: 32768, content: "", embeds: [{ url: "https://x" }] })), // unfurl
      gw("MESSAGE_UPDATE", msg({ flags: 32768, content: "edited", edited_timestamp: "2026-09-01T00:05:00Z" })),
    ]);
    const m = st.messages.get("100")!;
    expect(m.m.content).toBe("edited");
    expect(m.edits).toHaveLength(1);
    expect(m.edits[0]).toMatchObject({ content: "", edited_timestamp: null, components: [{ type: 10, content: "done" }] });
  });

  it("recovers an edit from a later REST snapshot, and ignores stale copies", () => {
    const st = fold([
      gw("MESSAGE_CREATE", msg()),
      rest(msg({ content: "v2", edited_timestamp: "2026-09-02T00:00:00Z" })),
      rest(msg({ content: "hi" })), // stale: older than what we have
    ]);
    const m = st.messages.get("100")!;
    expect(m.m.content).toBe("v2");
    expect(m.m.edited_timestamp).toBe("2026-09-02T00:00:00Z");
    expect(m.edits.map((e) => e.content)).toEqual(["hi"]);
  });

  it("dedupes replayed dispatches and never clears deletion", () => {
    const create = gw("MESSAGE_CREATE", msg(), 5);
    const st = fold([create, gw("MESSAGE_DELETE", { id: "100", channel_id: "1" }), { ...create, at: at() }, rest(msg())]);
    const m = st.messages.get("100")!;
    expect(m.deletedAt).toBeDefined();
    expect(m.edits).toHaveLength(0);
  });
});

describe("fold: reactions and polls", () => {
  it("combines a backfilled baseline with live events without double counting", () => {
    const st = fold([
      rest(msg({ reactions: [{ emoji: { name: "👍" }, count: 2, count_details: { normal: 2, burst: 0 } }] })),
      gw("MESSAGE_REACTION_ADD", { message_id: "100", user_id: "a", emoji: { name: "👍" } }),
      gw("MESSAGE_REACTION_REMOVE", { message_id: "100", user_id: "old", emoji: { name: "👍" } }), // a backfilled reactor
      gw("MESSAGE_REACTION_ADD", { message_id: "100", user_id: "a", emoji: { name: "👍" } }), // duplicate add
      gw("MESSAGE_REACTION_ADD", { message_id: "100", user_id: "b", emoji: { name: "🔥" }, burst: true }),
    ]);
    const r = [...st.messages.get("100")!.reactions.values()].map((x) => [x.emoji.name, x.burst, tallyCount(x), [...x.known]]);
    expect(r).toEqual([["👍", false, 2, ["a"]], ["🔥", true, 1, ["b"]]]);
  });

  it("handles a live vote removal on a backfilled poll", () => {
    // The real sequence from the test server: backfilled poll with blue=1, then the voter switches.
    const poll = { answers: [{ answer_id: 1 }, { answer_id: 2 }], results: { is_finalized: false, answer_counts: [{ id: 2, count: 1 }] } };
    const st = fold([
      rest(msg({ poll })),
      gw("MESSAGE_POLL_VOTE_REMOVE", { message_id: "100", user_id: "u", answer_id: 2 }),
      gw("MESSAGE_POLL_VOTE_ADD", { message_id: "100", user_id: "u", answer_id: 1 }),
    ]);
    const v = st.messages.get("100")!.votes;
    expect(tallyCount(v.get(1)!)).toBe(1);
    expect(tallyCount(v.get(2)!)).toBe(0);
  });

  it("resets known users when a snapshot counts fewer than we saw", () => {
    const st = fold([
      gw("MESSAGE_CREATE", msg()),
      gw("MESSAGE_REACTION_ADD", { message_id: "100", user_id: "a", emoji: { name: "👍" } }),
      gw("MESSAGE_REACTION_ADD", { message_id: "100", user_id: "b", emoji: { name: "👍" } }),
      rest(msg({ reactions: [{ emoji: { name: "👍" }, count: 1, count_details: { normal: 1, burst: 0 } }] })), // a removal was missed
    ]);
    const r = [...st.messages.get("100")!.reactions.values()][0];
    expect(tallyCount(r)).toBe(1);
  });

  it("treats finalized results as authoritative", () => {
    const st = fold([
      gw("MESSAGE_CREATE", msg({ poll: { answers: [], results: { answer_counts: [] } } })),
      gw("MESSAGE_POLL_VOTE_ADD", { message_id: "100", user_id: "u", answer_id: 1 }),
      gw("MESSAGE_UPDATE", msg({ poll: { answers: [], results: { is_finalized: true, answer_counts: [{ id: 1, count: 3 }] } } })),
    ]);
    expect(tallyCount(st.messages.get("100")!.votes.get(1)!)).toBe(3);
  });
});

describe("fold: publication regressions", () => {
  it("retains unknown deletion records before a delayed REST snapshot", () => {
    const single = gw("MESSAGE_DELETE", { id: "100", channel_id: "1" });
    const bulk = gw("MESSAGE_DELETE_BULK", { ids: ["101", "102"], channel_id: "1" });
    const st = fold([single, bulk, rest(msg()), rest(msg({ id: "101" })), gw("MESSAGE_DELETE", { id: "100" })]);
    expect(st.deletedMessages.get("100")).toBe(single.at);
    expect(st.deletedMessages.get("102")).toBe(bulk.at);
    expect(st.messages.get("100")?.deletedAt).toBe(single.at);
    expect(st.messages.get("101")?.deletedAt).toBe(bulk.at);
  });

  it("merges a partial Gateway update after an edit without accepting a stale complete snapshot", () => {
    const edited = "2026-09-02T00:00:00Z";
    const st = fold([
      gw("MESSAGE_CREATE", msg()),
      gw("MESSAGE_UPDATE", { id: "100", channel_id: "1", content: "edited", edited_timestamp: edited }),
      gw("MESSAGE_UPDATE", { id: "100", channel_id: "1", embeds: [{ title: "Fresh unfurl" }], flags: 4, components: [{ type: 10, content: "Complete" }] }),
      rest({ id: "100", channel_id: "1", content: "stale", embeds: [{ title: "Stale unfurl" }] }),
      gw("MESSAGE_UPDATE", { id: "100", channel_id: "1", content: "old", edited_timestamp: "2026-09-01T00:00:00Z" }),
    ]);
    const ms = st.messages.get("100")!;
    expect(ms.m).toMatchObject({ content: "edited", edited_timestamp: edited, flags: 4, embeds: [{ title: "Fresh unfurl" }], components: [{ content: "Complete" }] });
    expect(ms.edits).toHaveLength(1);
  });

  it.each([false, true])("clears omitted zero-count answers in a results snapshot, finalized=%s", (is_finalized) => {
    const st = fold([
      gw("MESSAGE_CREATE", msg({ poll: { answers: [{ answer_id: 1 }, { answer_id: 2 }] } })),
      gw("MESSAGE_POLL_VOTE_ADD", { message_id: "100", user_id: "7", answer_id: 1 }),
      gw("MESSAGE_UPDATE", { id: "100", channel_id: "1", poll: { results: { is_finalized, answer_counts: [{ id: 2, count: 1 }] } } }),
    ]);
    expect([...st.messages.get("100")!.votes].map(([id, v]) => [id, tallyCount(v)])).toEqual([[2, 1]]);
  });

  it("preserves unknown poll results but clears an explicitly empty count array", () => {
    const create = gw("MESSAGE_CREATE", msg({ poll: { results: { answer_counts: [{ id: 1, count: 2 }] } } }));
    const unknown = gw("MESSAGE_UPDATE", { id: "100", channel_id: "1", poll: { answers: [{ answer_id: 1 }] } });
    expect(tallyCount(fold([create, unknown]).messages.get("100")!.votes.get(1)!)).toBe(2);
    const empty = gw("MESSAGE_UPDATE", { id: "100", channel_id: "1", poll: { results: { answer_counts: [] } } });
    expect(fold([create, unknown, empty]).messages.get("100")!.votes.size).toBe(0);
  });

  it("applies current member privacy rules to old raw data without changing it", () => {
    const source = msg({ member: { nick: "Visible", roles: [], flags: 128 }, flags: 4 });
    const st = fold([gw("MESSAGE_CREATE", source)]);
    expect(st.messages.get("100")!.m.member).toEqual({ nick: "Visible", roles: [] });
    expect(st.messages.get("100")!.m.flags).toBe(4);
    expect(source.member.flags).toBe(128);
  });
});
