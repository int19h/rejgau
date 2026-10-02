import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ChannelView } from "./channel";
import { loadArchive, loadUsers, MESSAGE_CHANNEL_TYPES, type Archive, type UsersFile } from "./data";
import { LoadError } from "./error";
import { SearchView } from "./search-view";
import { Sidebar } from "./sidebar";

type Route = { view: "home" } | { view: "channel"; channel: string; month?: string; message?: string } | { view: "search"; q: string };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (/^search(?:\?|$)/.test(path)) return { view: "search", q: new URLSearchParams(path.split("?")[1] ?? "").get("q") ?? "" };
  const match = /^c\/(\d+)(?:\/(\d{4}-(?:0[1-9]|1[0-2])))?(?:\/(\d+))?$/.exec(path);
  return match ? { view: "channel", channel: match[1], month: match[2], message: match[3] } : { view: "home" };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const change = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  return route;
}

function SearchBox({ query }: { query: string }) {
  const [value, setValue] = useState(query);
  useEffect(() => setValue(query), [query]);
  return <form class="searchbox" onSubmit={(event) => {
    event.preventDefault();
    location.hash = `#/search?q=${encodeURIComponent(value)}`;
  }}>
    <input type="search" aria-label="Search archive" placeholder="Search (from: in: has: before: after: during: mentions: pinned: authorType:)" value={value} onInput={(event) => setValue(event.currentTarget.value)} />
  </form>;
}

function App() {
  const route = useRoute();
  const [archive, setArchive] = useState<Archive | null>(null);
  const [users, setUsers] = useState<UsersFile | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [usersError, setUsersError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [usersAttempt, setUsersAttempt] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setError(null);
    loadArchive(controller.signal).then(
      (value) => { if (active) setArchive(value); },
      (failure: unknown) => { if (active) setError(failure); },
    );
    return () => { active = false; controller.abort(); };
  }, [attempt]);

  useEffect(() => {
    if (!archive) return;
    const controller = new AbortController();
    let active = true;
    setUsersError(null);
    loadUsers(archive, controller.signal).then(
      (value) => { if (active) setUsers(value); },
      (failure: unknown) => { if (active) setUsersError(failure); },
    );
    return () => { active = false; controller.abort(); };
  }, [archive, usersAttempt]);

  useEffect(() => {
    if (archive) document.title = `${archive.guild.name} · archive`;
  }, [archive]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    document.querySelector<HTMLAnchorElement>("#channel-menu a")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(false); toggle.current?.focus(); }
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [menuOpen]);

  if (error) return <LoadError error={error} retry={() => setAttempt(attempt + 1)} />;
  if (!archive) return <div class="empty" role="status">Loading archive…</div>;

  let view;
  if (route.view === "channel") view = <ChannelView archive={archive} users={users} channel={route.channel} month={route.month} message={route.message} />;
  else if (route.view === "search") view = <SearchView key={route.q} archive={archive} users={users} q={route.q} />;
  else {
    const first = Object.values(archive.channels).find((channel) => Object.keys(channel.months).length && MESSAGE_CHANNEL_TYPES.has(channel.type));
    view = <div class="empty">{first ? <a href={`#/c/${first.id}`}>Open #{first.name}</a> : "This archive is empty."}</div>;
  }
  return <div class="app">
    <Sidebar archive={archive} current={route.view === "channel" ? route.channel : undefined} open={menuOpen} onSelect={() => {
      setMenuOpen(false);
      if (matchMedia("(max-width: 700px)").matches) toggle.current?.focus();
    }} />
    <main class="main">
      <button ref={toggle} class="channel-toggle" aria-expanded={menuOpen} aria-controls="channel-menu" onClick={() => setMenuOpen(!menuOpen)}>Channels</button>
      <SearchBox query={route.view === "search" ? route.q : ""} />
      {!!usersError && <LoadError error={usersError} retry={() => setUsersAttempt(usersAttempt + 1)} />}
      {view}
    </main>
  </div>;
}

render(<App />, document.getElementById("app")!);
