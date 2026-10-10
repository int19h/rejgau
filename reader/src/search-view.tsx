import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SearchRow } from "../../shared/publication";
import { displayName, loadSearchMonth, monthOfId, type Archive, type UsersFile } from "./data";
import { LoadError } from "./error";
import { compileQuery, monthInBounds, parseQuery } from "./search";

const RESULTS_PER_PAGE = 200;
export const MAX_SEARCH_RESULTS = 1000;
type SearchHit = Pick<SearchRow, "id" | "c" | "ts" | "a" | "x">;
interface SearchProgress { month: number; row: number; hits: SearchHit[] }

export function SearchView({ archive, users, q }: { archive: Archive; users: UsersFile | null; q: string }) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [limit, setLimit] = useState(RESULTS_PER_PAGE);
  const progress = useRef<SearchProgress>({ month: 0, row: 0, hits: [] });
  const compiled = useMemo(() => {
    const userNames = new Map<string, string[]>();
    for (const [id, u] of Object.entries(users?.users ?? {})) {
      userNames.set(id, [...new Set([...(u.names ?? []), u.username ?? "", u.global_name ?? "", u.nick ?? ""].filter(Boolean))]);
    }
    const channelNames = new Map(Object.values(archive.channels).map((c) => [c.id, c.name ?? ""]));
    return compileQuery(parseQuery(q), { userNames, channelNames });
  }, [q, users, archive]);
  const months = useMemo(() => archive.search_months.filter((m) => monthInBounds(m, compiled.bounds)), [archive, compiled]);

  useEffect(() => {
    progress.current = { month: 0, row: 0, hits: [] };
    setHits([]);
    setLimit(RESULTS_PER_PAGE);
    setDone(false);
    setError(null);
  }, [compiled]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const state = progress.current;
    if (compiled.empty || !users) { setBusy(false); return; }
    setBusy(true);
    setError(null);
    (async () => {
      while (state.month < months.length && state.hits.length < limit) {
        const rows = await loadSearchMonth(archive, months[state.month], controller.signal);
        if (!active) return;
        while (state.row < rows.length && state.hits.length < limit) {
          const row = rows[state.row++];
          if (compiled.match(row)) state.hits.push({ id: row.id, c: row.c, ts: row.ts, a: row.a, x: row.x?.slice(0, 300) });
        }
        if (state.row === rows.length) { state.month++; state.row = 0; }
        setHits([...state.hits]);
      }
      if (active) setDone(state.month === months.length);
    })().catch((failure: unknown) => {
      if (active) { setError(failure); setDone(false); }
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; controller.abort(); };
  }, [compiled, months, archive, limit, attempt, users]);

  const capped = !done && hits.length === MAX_SEARCH_RESULTS;
  return <div class="search-view">
    <header class="channel-header">
      <span class="channel-title">Search</span>
      <span class="muted" role="status">{compiled.empty ? "Type a query above." : !users ? "Loading people…" : `${hits.length} result${hits.length === 1 ? "" : "s"}${busy ? " · Searching…" : done ? "" : " · Incomplete"}`}</span>
    </header>
    <div class="messages">
      {!!error && <LoadError error={error} retry={() => setAttempt(attempt + 1)} />}
      {hits.map((hit) => <a key={hit.id} class="hit" href={`#/c/${hit.c}/${monthOfId(hit.id)}/${hit.id}`}>
        <div class="hit-head">
          <span class="name">{displayName(hit.a ? users?.users[hit.a] : undefined)}</span>
          <span class="muted small">in #{archive.channels[hit.c]?.name ?? hit.c} · {new Date(hit.ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
        </div>
        <div class="hit-text">{hit.x ?? ""}</div>
      </a>)}
      {capped && <p class="empty search-limit">Search stopped after 1,000 matches. Refine the query to search further.</p>}
      {users && !compiled.empty && !done && !error && !busy && !capped && <button class="load-more" onClick={() => setLimit(Math.min(MAX_SEARCH_RESULTS, limit + RESULTS_PER_PAGE))}>Load more</button>}
    </div>
  </div>;
}
