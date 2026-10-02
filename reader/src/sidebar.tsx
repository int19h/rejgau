import type { ComponentChildren } from "preact";
import { MESSAGE_CHANNEL_TYPES, THREAD_TYPES, type Archive, type ChannelInfo } from "./data";
import { safeUrl } from "./url";

export const channelIcon = (c: ChannelInfo) => (c.type === 2 ? "🔊" : c.type === 15 || c.type === 16 ? "💬" : THREAD_TYPES.has(c.type) ? "🧵" : "#");

export function Sidebar({ archive, current, open, onSelect }: { archive: Archive; current?: string; open: boolean; onSelect: () => void }) {
  const all = Object.values(archive.channels);
  const byParent = new Map<string | null, ChannelInfo[]>();
  for (const c of all) {
    const p = c.parent_id && archive.channels[c.parent_id] ? c.parent_id : null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(c);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.type === 4 ? 1 : 0) - (b.type === 4 ? 1 : 0) || a.position - b.position || (a.name ?? "").localeCompare(b.name ?? ""));
  const count = (c: ChannelInfo) => Object.values(c.months).reduce((a, b) => a + b, 0);

  const item = (c: ChannelInfo, depth: number): ComponentChildren => {
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
        <a onClick={onSelect} aria-current={c.id === current ? "page" : undefined} class={c.id === current ? "channel active" : "channel"} href={`#/c/${c.id}`} style={{ paddingLeft: `${8 + depth * 14}px` }} title={c.topic}>
          <span class="channel-icon">{channelIcon(c)}</span>
          <span class="channel-name">{c.name ?? c.id}</span>
          <span class="channel-count">{count(c) || ""}</span>
        </a>
        {children.map((t) => item(t, depth + 1))}
      </div>
    );
  };

  return (
    <nav id="channel-menu" class={open ? "sidebar open" : "sidebar"} aria-label="Channels">
      <div class="guild">
        {safeUrl(archive.guild.icon_url) ? <img class="guild-icon" src={safeUrl(archive.guild.icon_url)!} alt="" /> : <span class="guild-icon placeholder">{(archive.guild.name ?? "?").slice(0, 1)}</span>}
        <span class="guild-name">{archive.guild.name}</span>
      </div>
      <div class="channels">{(byParent.get(null) ?? []).map((c) => item(c, 0))}</div>
      <div class="built muted small">Archived with rejgau · built {new Date(archive.built_at).toLocaleString()}</div>
    </nav>
  );
}
