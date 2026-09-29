import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  displayName,
  loadArchive,
  loadMonth,
  loadSearchMonth,
  loadUsers,
  MESSAGE_CHANNEL_TYPES,
  monthOfId,
  THREAD_TYPES,
  type Archive,
  type ChannelInfo,
  type MonthFile,
  type UsersFile,
} from "./data";
import { isGrouped, Message, type MsgEnv } from "./message";
import { compileQuery, monthInBounds, parseQuery, type SearchRow } from "./search";
import { safeUrl } from "./url";

// --- routing ---

type Route = { view: "home" } | { view: "channel"; channel: string; month?: string; message?: string } | { view: "search"; q: string };

function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h.startsWith("search")) return { view: "search", q: new URLSearchParams(h.slice(h.indexOf("?") + 1)).get("q") ?? "" };
  const m = /^c\/(\d+)(?:\/(\d{4}-\d{2}))?(?:\/(\d+))?/.exec(h);
  if (m) return { view: "channel", channel: m[1], month: m[2], message: m[3] };
  return { view: "home" };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

// --- sidebar ---

const channelIcon = (c: ChannelInfo) => (c.type === 2 ? "🔊" : c.type === 15 || c.type === 16 ? "💬" : THREAD_TYPES.has(c.type) ? "🧵" : "#");

function Sidebar({ archive, current }: { archive: Archive; current?: string }) {
  const all = Object.values(archive.channels);
  const byParent = new Map<string | null, ChannelInfo[]>();
  for (const c of all) {
    const p = c.parent_id && archive.channels[c.parent_id] ? c.parent_id : null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(c);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.type === 4 ? 1 : 0) - (b.type === 4 ? 1 : 0) || a.position - b.position || (a.name ?? "").localeCompare(b.name ?? ""));
  const count = (c: ChannelInfo) => Object.values(c.months).reduce((a, b) => a + b, 0);

  const item = (c: ChannelInfo, depth: number): any => {
    const children = (byParent.get(c.id) ?? []).filter((x) => THREAD_TYPES.has(x.type));
    if (c.type === 4) {
      const kids = byParent.get(c.id) ?? [];
      return (
        <div key={c.id} class="category">
          <div class="category-name">{c.name}</div>
          {kids.map((k) => item(k, depth))}
        </div>
      );
    }
    if (!MESSAGE_CHANNEL_TYPES.has(c.type)) return null;
    return (
      <div key={c.id}>
        <a class={c.id === current ? "channel active" : "channel"} href={`#/c/${c.id}`} style={{ paddingLeft: `${8 + depth * 14}px` }} title={c.topic}>
          <span class="channel-icon">{channelIcon(c)}</span>
          <span class="channel-name">{c.name ?? c.id}</span>
          <span class="channel-count">{count(c) || ""}</span>
        </a>
        {children.map((t) => item(t, depth + 1))}
      </div>
    );
  };

  return (
    <nav class="sidebar">
      <div class="guild">
        {safeUrl(archive.guild.icon_url) ? <img class="guild-icon" src={safeUrl(archive.guild.icon_url)!} alt="" /> : <span class="guild-icon placeholder">{(archive.guild.name ?? "?").slice(0, 1)}</span>}
        <span class="guild-name">{archive.guild.name}</span>
      </div>
      <div class="channels">{(byParent.get(null) ?? []).map((c) => item(c, 0))}</div>
      <div class="built muted small">Archived with rejgau · built {new Date(archive.built_at).toLocaleString()}</div>
    </nav>
  );
}

// --- channel view ---

function ChannelView({ archive, users, channel, month, message }: { archive: Archive; users: UsersFile | null; channel: string; month?: string; message?: string }) {
  const info = archive.channels[channel];
  const months = Object.keys(info?.months ?? {}).sort();
  const current = month ?? months[months.length - 1];
  const [file, setFile] = useState<MonthFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFile(null);
    setError(null);
    if (!current || !info?.months[current]) return;
    loadMonth(channel, current).then(setFile, (e) => setError(String(e)));
  }, [channel, current]);

  useEffect(() => {
    if (!file) return;
    const target = message ? document.getElementById(`m${message}`) : null;
    if (target) target.scrollIntoView({ block: "center" });
    else if (!month) document.querySelector(".messages")?.scrollTo(0, 1e9); // latest month: start at the bottom
    else document.querySelector(".messages")?.scrollTo(0, 0);
  }, [file, message]);

  if (!info) return <div class="empty">This channel isn't in the archive.</div>;
  const idx = months.indexOf(current);
  const prev = idx > 0 ? months[idx - 1] : null;
  const next = idx >= 0 && idx < months.length - 1 ? months[idx + 1] : null;
  const env: MsgEnv | null = file ? { archive, file, users, channelId: channel } : null;
  const monthLabel = current ? new Date(`${current}-01T00:00:00Z`).toLocaleDateString(undefined, { year: "numeric", month: "long", timeZone: "UTC" }) : "";

  let lastDay = "";
  return (
    <div class="channel-view">
      <header class="channel-header">
        <span class="channel-icon">{channelIcon(info)}</span>
        <span class="channel-title">{info.name}</span>
        {info.topic && <span class="channel-topic muted">{info.topic}</span>}
      </header>
      <div class="month-nav">
        {prev ? <a href={`#/c/${channel}/${prev}`}>← {prev}</a> : <span />}
        <span class="month-label">{monthLabel}</span>
        {next ? <a href={`#/c/${channel}/${next}`}>{next} →</a> : <span />}
      </div>
      <div class="messages">
        {!current && <div class="empty">No archived messages in this channel yet.</div>}
        {error && <div class="empty">Couldn't load messages: {error}</div>}
        {current && !file && !error && <div class="empty">Loading…</div>}
        {env &&
          file!.messages.map((msg, i) => {
            const day = new Date(msg.ts).toLocaleDateString(undefined, { dateStyle: "full" });
            const sep = day !== lastDay;
            lastDay = day;
            return (
              <div key={msg.id}>
                {sep && <div class="day-separator"><span>{day}</span></div>}
                <Message msg={msg} env={env} grouped={!sep && isGrouped(file!.messages[i - 1], msg, file!)} highlighted={msg.id === message} />
              </div>
            );
          })}
      </div>
    </div>
  );
}

// --- search ---

interface Hit extends SearchRow {
  x?: string;
}

function SearchView({ archive, users, q }: { archive: Archive; users: UsersFile | null; q: string }) {
  const [hits, setHits] = useState<Hit[]>([]);
  const [done, setDone] = useState(false);
  const [limit, setLimit] = useState(200);

  const compiled = useMemo(() => {
    const userNames = new Map<string, string[]>();
    for (const [id, u] of Object.entries(users?.users ?? {})) userNames.set(id, [...new Set([...(u.names ?? []), u.username ?? "", u.global_name ?? "", u.nick ?? ""].filter(Boolean))]);
    const channelNames = new Map(Object.values(archive.channels).map((c) => [c.id, c.name ?? ""]));
    return compileQuery(parseQuery(q), { userNames, channelNames });
  }, [q, users]);

  useEffect(() => {
    let cancelled = false;
    setHits([]);
    setDone(false);
    if (compiled.empty) return;
    (async () => {
      const found: Hit[] = [];
      for (const month of archive.search_months) {
        if (cancelled) return;
        if (!monthInBounds(month, compiled.bounds)) continue;
        const rows: Hit[] = await loadSearchMonth(month);
        for (const r of rows) if (compiled.match(r)) found.push(r);
        if (!cancelled) setHits([...found]);
        if (found.length >= limit) break;
      }
      if (!cancelled) setDone(true);
    })().catch(() => setDone(true));
    return () => {
      cancelled = true;
    };
  }, [compiled, limit]);

  return (
    <div class="search-view">
      <header class="channel-header">
        <span class="channel-title">Search</span>
        <span class="muted">{compiled.empty ? "Type a query above." : `${hits.length}${done ? "" : "…"} result${hits.length === 1 ? "" : "s"}`}</span>
      </header>
      <div class="messages">
        {hits.slice(0, limit).map((h) => {
          const u = h.a ? users?.users[h.a] : undefined;
          return (
            <a key={h.id} class={h.del ? "hit deleted" : "hit"} href={`#/c/${h.c}/${monthOfId(h.id)}/${h.id}`}>
              <div class="hit-head">
                <span class="name">{displayName(u)}</span>
                <span class="muted small">
                  in #{archive.channels[h.c]?.name ?? h.c} · {new Date(h.ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
                {h.del && <span class="deleted-badge">deleted</span>}
              </div>
              <div class="hit-text">{h.x ?? ""}</div>
            </a>
          );
        })}
        {hits.length >= limit && (
          <button class="load-more" onClick={() => setLimit(limit + 200)}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

function SearchBox({ q }: { q: string }) {
  const [value, setValue] = useState(q);
  useEffect(() => setValue(q), [q]);
  return (
    <form
      class="searchbox"
      onSubmit={(e) => {
        e.preventDefault();
        location.hash = `#/search?q=${encodeURIComponent(value)}`;
      }}
    >
      <input
        type="search"
        placeholder="Search (from: in: has: before: after: during: mentions: pinned: authorType:)"
        value={value}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
      />
    </form>
  );
}

// --- app ---

function App() {
  const route = useRoute();
  const [archive, setArchive] = useState<Archive | null>(null);
  const [users, setUsers] = useState<UsersFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadArchive().then(setArchive, (e) => setError(String(e)));
    loadUsers().then(setUsers, () => setUsers({ users: {}, media: {} }));
  }, []);

  if (error) return <div class="empty">Couldn't load the archive: {error}</div>;
  if (!archive) return <div class="empty">Loading…</div>;
  document.title = `${archive.guild.name} · archive`;

  let main;
  if (route.view === "channel") main = <ChannelView archive={archive} users={users} channel={route.channel} month={route.month} message={route.message} />;
  else if (route.view === "search") main = <SearchView archive={archive} users={users} q={route.q} />;
  else {
    const first = Object.values(archive.channels).find((c) => Object.keys(c.months).length && MESSAGE_CHANNEL_TYPES.has(c.type));
    main = <div class="empty">{first ? <a href={`#/c/${first.id}`}>Open #{first.name}</a> : "This archive is empty."}</div>;
  }
  return (
    <div class="app">
      <Sidebar archive={archive} current={route.view === "channel" ? route.channel : undefined} />
      <main class="main">
        <SearchBox q={route.view === "search" ? route.q : ""} />
        {main}
      </main>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
