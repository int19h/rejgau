import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { loadMonth, type Archive, type MonthFile, type UsersFile } from "./data";
import { LoadError } from "./error";
import { isGrouped, Message, type MsgEnv } from "./message";
import { channelIcon } from "./sidebar";

export const MESSAGES_PER_PAGE = 200;

function ChannelMessages({ file, archive, users, message, latest }: {
  file: MonthFile; archive: Archive; users: UsersFile | null; message?: string; latest: boolean;
}) {
  const targetIndex = message ? file.messages.findIndex((m) => m.id === message) : -1;
  const pages = Math.max(1, Math.ceil(file.messages.length / MESSAGES_PER_PAGE));
  const [page, setPage] = useState(targetIndex >= 0 ? Math.floor(targetIndex / MESSAGES_PER_PAGE) : latest ? pages - 1 : 0);
  const firstRender = useRef(true);
  const container = useRef<HTMLDivElement>(null);
  const start = page * MESSAGES_PER_PAGE;
  const env: MsgEnv = { archive, file, users, channelId: file.channel };

  useLayoutEffect(() => {
    const target = firstRender.current && message ? document.getElementById(`m${message}`) : null;
    if (target) target.scrollIntoView({ block: "center" });
    else container.current?.scrollTo(0, firstRender.current && latest ? container.current.scrollHeight : 0);
    firstRender.current = false;
  }, [page]);

  let lastDay = "";
  return <>
    {pages > 1 && <nav class="message-pages" aria-label="Message pages">
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous messages</button>
      <span>Messages {start + 1}–{Math.min(start + MESSAGES_PER_PAGE, file.messages.length)} of {file.messages.length}</span>
      <button disabled={page === pages - 1} onClick={() => setPage(page + 1)}>Next messages</button>
    </nav>}
    <div class="messages" ref={container}>
      {message && targetIndex < 0 && <div class="empty" role="status">This message is no longer in the archive.</div>}
      {file.messages.slice(start, start + MESSAGES_PER_PAGE).map((msg, offset) => {
        const day = new Date(msg.ts).toLocaleDateString(undefined, { dateStyle: "full" });
        const separate = day !== lastDay;
        lastDay = day;
        return <div key={msg.id}>
          {separate && <div class="day-separator"><span>{day}</span></div>}
          <Message msg={msg} env={env} grouped={!separate && isGrouped(file.messages[start + offset - 1], msg, file)} highlighted={msg.id === message} />
        </div>;
      })}
    </div>
  </>;
}

export function ChannelView({ archive, users, channel, month, message }: {
  archive: Archive; users: UsersFile | null; channel: string; month?: string; message?: string;
}) {
  const info = archive.channels[channel];
  const months = Object.keys(info?.months ?? {}).sort();
  const current = month ?? months.at(-1);
  const available = !!current && !!info?.months[current];
  const [file, setFile] = useState<MonthFile | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setFile(null);
    setError(null);
    if (current && available) {
      loadMonth(archive, channel, current, controller.signal).then(
        (value) => { if (active) setFile(value); },
        (failure: unknown) => { if (active) setError(failure); },
      );
    }
    return () => { active = false; controller.abort(); };
  }, [archive, channel, current, available, attempt]);

  if (!info) return <div class="empty">This channel is not in the archive.</div>;
  const previous = current ? months.filter((m) => m < current).at(-1) : undefined;
  const next = current ? months.find((m) => m > current) : undefined;
  const loaded = file?.channel === channel && file.month === current ? file : null;
  const label = current ? new Date(`${current}-01T00:00:00Z`).toLocaleDateString(undefined, { year: "numeric", month: "long", timeZone: "UTC" }) : "";

  return <div class="channel-view">
    <header class="channel-header">
      <span class="channel-icon">{channelIcon(info)}</span>
      <span class="channel-title">{info.name}</span>
      {info.topic && <span class="channel-topic muted">{info.topic}</span>}
    </header>
    <nav class="month-nav" aria-label="Archive months">
      {previous ? <a href={`#/c/${channel}/${previous}`}>← {previous}</a> : <span />}
      <span class="month-label">{label}</span>
      {next ? <a href={`#/c/${channel}/${next}`}>{next} →</a> : <span />}
    </nav>
    {!current && <div class="empty">No archived messages in this channel yet.</div>}
    {current && !available && <div class="empty" role="status">This month is not in the archive. Select another month above.</div>}
    {!!error && <LoadError error={error} retry={() => setAttempt(attempt + 1)} />}
    {available && !loaded && !error && <div class="empty" role="status">Loading messages…</div>}
    {loaded && <ChannelMessages key={`${channel}/${current}/${message ?? ""}/${month ?? "latest"}`} file={loaded} archive={archive} users={users} message={message} latest={!month} />}
  </div>;
}
