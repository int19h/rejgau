# rejgau reader: design (phase 2)

This covers the static reader for rejgau archives, plus the build step that turns `raw/` into data the reader can load quickly. See [design.md](design.md) for the archive format and the bot.

## Goals

- **A read-only, Discord-like view** of an archive:
  - a channel list (categories, channels, threads);
  - messages grouped by author, as Discord does;
  - Discord markdown, embeds, attachments, components, polls, stickers, reactions, replies, forwards, and app-command headers;
  - edit history and deleted-message badges.
- **Search with Discord's syntax** (`from:`, `in:`, `has:`, `before:`, `after:`, `during:`, `mentions:`, `pinned:`, `authorType:`, `-` negation, `"phrases"`). Anything else is plain text.
- **Static hosting only:** GitHub Pages, deployed by an Action in the archive repo, or any static server for a local build.
  - There is no `?data=<url>` loading of third-party data. Pages origins (`<owner>.github.io`) are shared by all of an owner's project sites, so a rendering bug fed arbitrary input would be XSS there.
- **Fully regenerable** from `raw/`, which is the only source of truth. The derived data is never committed to the archive branch.

## Architecture

```
archive repo                         rejgau repo (this one)
  branch archive: raw/…  ──┐           tools/build.ts   raw/ → site data (Node)
  branch main:              │           reader/          static SPA (Preact, esbuild)
    .github/workflows/      │           templates/pages.yml
      pages.yml  ───────────┴──► Action: checkout archive + rejgau@ref → npm ci
                                          → build data + reader → deploy to Pages
```

**When the Pages workflow runs:** it lives on `main`, since workflows run from the default branch and the `github-pages` environment only deploys from there. Triggers:
- `repository_dispatch` (`archive-updated`), sent by the bot after commits: at most once per 10 minutes, and only if the guild config has `"pages": true`;
- an hourly `schedule`;
- `workflow_dispatch`.

Overlapping builds are coalesced with `concurrency` (cancel-in-progress); the deploy job is never cancelled and alone has the Pages permissions. The bot's dispatch is throttled (at most one per 10 minutes).

- **Why the build runs in CI:**
  - The generator is a pure function from raw to site. That keeps the bot append-only, and history rewrites need no special handling: every build is a full rebuild.
  - At ~100 messages a day, a full rebuild is seconds.
- **Pages is public.** A Pages site is publicly readable even when the repo is private, except on Enterprise Cloud with access control. Private archives should use the local build only:
  - `npm run build:site -- --archive <path> --out <dir>`, then any static server.
  - Media from a private repo's releases can't load in the reader, because the session cookie isn't sent cross-site, so it shows as links.

## Build step (`tools/build.ts`)

**Input:** every `raw/**/*.jsonl` of one archive folder.

**Order:** lines are processed in a single global order:
1. by `at`;
2. ties keep file order (a stable sort).

`gw` lines are deduplicated on (`sid`, `s`) first.

This works because:
- `rest` lines have `at` equal to their fetch time;
- `gw` lines have their receive time.

**Folding into state:**

| Record | Effect on state |
|---|---|
| `GUILD_SNAPSHOT`, `GUILD_UPDATE`, `GUILD_ROLE_*`, `GUILD_EMOJIS_UPDATE`, `GUILD_STICKERS_UPDATE` | Update the latest guild state: name, icon, roles (for mention colours and names), emoji, stickers. |
| `CHANNEL_SELECTED`, `CHANNEL_*`, `THREAD_*`, `THREAD_LIST_SYNC` | Update channel and thread objects, including the ancestors carried in `CHANNEL_SELECTED`. |
| `MEMBER_SNAPSHOT` | Fallback member info (nickname, roles, avatar) for REST messages without a `member`. It's marked as "as of backfill". |
| `MEDIA_STORED`, `MEDIA_FAILED` | Build the media index. The last record for a key wins. |

**Channels that are currently unselected produce no data files:** the reader shows only selected channels. They remain in `raw/`.

**Messages.** Every `MESSAGE_CREATE`/`MESSAGE_UPDATE` payload, live or REST, is a snapshot of the message:
- Only keys present in the snapshot are merged.
- If its `edited_timestamp` is newer than the current one, push the previous version (content, embeds, attachments, components, with its timestamp) onto `edits[]` first.
- A snapshot with an older `edited_timestamp` is stale, and is ignored for content.
- `edited_timestamp` never goes backwards, and `deleted_at` is never cleared.
- Snapshots with an unchanged or null `edited_timestamp` merge silently: unfurls, a LOADING message becoming its V2 response, component updates.

**Reactions** are tracked per (emoji, burst):
- a `baseline`: the count attributable to unknown users, from the latest snapshot;
- a `known` set of users, from live events.

The rules:
- **Displayed count** = `baseline + |known|`.
- **ADD** puts the user in `known`.
- **REMOVE** takes a known user out of `known`; for anyone else it does `baseline = max(0, baseline − 1)`.
- **A new snapshot** (REST or UPDATE) whose count differs from the displayed one resets `baseline = max(0, count − |known|)`.
- **REMOVE_ALL / REMOVE_EMOJI** clear.

**Polls** follow the same scheme per answer. A snapshot with `results.is_finalized` is authoritative.

**Deletes and pins:**
- `MESSAGE_DELETE` / `_BULK` set `deleted_at`.
- `pinned` comes from message snapshots, and from the `message_reference` of type-6 pin notices.
- `CHANNEL_PINS_UPDATE` names no message, so it isn't used.

**Threads** are linked at build time:
- a message that started a thread gets `{thread: {id, name, count}}`;
- a thread's first message (type 21, or the forum post whose ID equals the thread ID) gets the parent excerpt.

**Output** (`site/data/`, all JSON, gzipped by Pages on the wire):

```
data/archive.json              guild (name, icon, roles, emoji), channels tree (id, name, type, parent,
                               topic, selected), per-channel month list with counts, build time, format
data/users.json                user id → { latest snapshot, names: [every username/global_name/nick seen] }
data/search/<YYYY-MM>.json     compact search rows for all channels:
                               [{ id, c, ts, a, text, has: [...], men: [...], pin?, del?, at: user|bot|webhook }]
data/c/<channel>/<YYYY-MM>.json
  { media: { <key>: url | null },          only keys referenced in this file (resolved at build time)
    users: { <snapKey>: {id, username, global_name, avatar, nick, roles, bot, …} },
    messages: [ { id, ts, type, flags, author: <snapKey>, content, edits?, deleted_at?,
                  edited_at?, attachments, embeds, components, sticker_items, poll?, votes?,
                  reactions?: [{emoji, count, users?}], reference?, referenced?: {id, author, excerpt},
                  snapshots?, interaction?: {name, user: <snapKey>, type, command_type}, thread?,
                  webhook_id?, application_id?, pinned?, mentions: [ids], mention_roles,
                  mention_everyone } ] }
```

**Author snapshots are per message.** Each message references the author exactly as they appeared when it was logged. Snapshots are deduplicated per month file by content hash (`snapKey`). The reader therefore shows names as they were at the time. `users.json` gives current names for search (`from:`) and hover cards.

**Month files are keyed by message creation month (UTC).** Threads get their own `c/<thread id>/…` files.

**Media keys** are computed with the same `src/media.ts` functions the bot uses, and each month file carries only the keys it needs, so the reader never loads a global media index.

**Sizes:** month files are ~0.5–1 KB per message, so ~20–40 MB/year for the main server before gzip. That is well within Pages limits, and small enough to scan for search.

## Reader (`reader/`)

**Stack:** Preact + TypeScript bundled by esbuild into one JS file and one CSS file.
- Markdown: `discord-markdown-parser` (an AST following Discord's simple-markdown rules), rendered by us.
- Code blocks: `highlight.js` core with ~15 common languages, bundled.
- No backend.

**Routes** (hash-based, so they work on Pages without rewrites):
- `#/c/<channel>`: jumps to the latest month.
- `#/c/<channel>/<YYYY-MM>`: a month view.
- `#/c/<channel>/<YYYY-MM>/<messageId>`: scrolls to and highlights that message.
- `#/search?q=…`

**Layout:**
- Left sidebar: the guild name and icon, then categories, with channels under them and threads nested under their parents. Unselected channels are hidden.
- Main pane:
  - a month header with previous/next navigation and a month picker;
  - messages grouped Discord-style (same author within 7 minutes, no intervening reply or system message);
  - day separators.
- Top: a search box. Results open in the main pane, newest first, each with channel/date context and a "jump" link.
- Themes: dark or light via `prefers-color-scheme`. There's no toggle in v1.

**Security rules** (the content is untrusted):
- Everything renders through Preact, which escapes text. The only HTML injected is highlight.js output, which escapes its input.
- URLs (masked links, embed/author/footer URLs, link buttons, autolinks) are allowed only with `http:` or `https:`. Anything else renders as plain text.
- Images and videos load only from archived media, via the build's media map. Discord's CDN and third-party URLs are never hotlinked: signed URLs expire, and hotlinked images act as tracking pixels. Unarchived media shows as a link.
- A CSP meta tag: `default-src 'self'; img-src 'self' https://github.com https://*.githubusercontent.com; media-src` (same list); `style-src 'self' 'unsafe-inline'`; `script-src 'self'`.

**Message rendering:**
- **Header:**
  - the avatar (from media), falling back to Discord's default avatar;
  - the display name: nickname > global_name > username, coloured by the highest coloured role;
  - BOT/APP tags;
  - a timestamp with the full date on hover.
  - "(edited)" opens the edit history; a "deleted" badge appears when applicable.
- **Replies:** a compact line above the message ("↪ @name excerpt"), linking to the referenced message.
- **App commands:** the header line "@user used /name". The command name comes from `interaction_metadata.name` or `interaction.name`. User-installed apps are marked "(user app)".
- **Content:** Discord markdown:
  - bold/italic/underline/strike, spoilers (click to reveal);
  - inline and block code, block quotes (`>` and `>>>`);
  - headers, `-#` subtext and lists, at line start only;
  - masked links (showing the URL on hover);
  - mentions: `<@id>`, `<@&id>` (role colour), `<#id>` (channel name if archived, otherwise "#unknown"), `@everyone`/`@here`;
  - custom and animated emoji, jumbo when the message is emoji-only;
  - `<t:unix:style>` timestamps in the viewer's locale;
  - `</cmd:id>` command mentions;
  - `<id:customize>`-style guild links, shown as plain labels.
- **Attachments:**
  - images and videos inline (via `media.json`);
  - audio with a player;
  - other files as download cards;
  - spoilered attachments blurred until clicked.
  - Missing media shows the file name with "not archived".
- **Embeds:**
  - colour bar, author, title/URL, description (markdown), fields (inline grid), image or thumbnail, footer and timestamp;
  - video embeds show the thumbnail and link out.
- **Components:**
  - **V1:** action rows with buttons (styles, emoji, labels; link buttons are real links, the rest disabled) and select menus (placeholder, disabled).
  - **V2:** container (accent colour), section with accessory, text display (markdown), thumbnail, media gallery, file, and separator.
- **Other message parts:**
  - Stickers: PNG/APNG images, Lottie shown as a static placeholder, GIF shown as "sticker (not archived)".
  - Polls: question, answers with emoji, counts and percentage bars, a "final" marker, and voters on hover when known.
  - Reactions: chips with counts; reactors on hover when known.
  - Forwards: a "Forwarded" frame with the snapshot content and its original timestamp.
  - System messages (joins, pins, boosts, thread created, …): compact grey lines.

**Search:**
- **Parser:** tokens are `key:value`, `key:"quoted value"`, `-key:value`, `"phrase"`, and words. Recognised keys, with the same meanings as Discord's:
  - `from:` a user: username, display name, nickname, or ID;
  - `mentions:` a user;
  - `in:` a channel name or ID;
  - `has:` one of link, embed, file, image, video, sound, sticker, poll, forward;
  - `before:`, `after:`, `during:` a date (YYYY-MM-DD, YYYY-MM or YYYY);
  - `pinned:` true or false;
  - `authorType:` user, bot or webhook.

  Unknown keys are treated as text.
- **Matching:** case- and diacritic-insensitive substring match over the current content, embed text, component text displays, attachment filenames and forwarded content. Edits are not searched.
  - Substring matching is a deliberate superset of Discord's word matching.
  - `from:` and `mentions:` match any name the user ever had.
  - `before:`, `after:` and `during:` use the viewer's time zone, as Discord does. `before` and `after` exclude the named day.
  - Deleted messages appear in results with a badge.
- **Execution:**
  - The page (not a Web Worker: at this volume the scan is fast) loads `search/<YYYY-MM>.json` files newest-first, pruned by the date filters (widened by ±1 day for time zones).
  - Results stream in as they're found, capped at 500 with "load more".
  - Month files are cached in memory.

## Deployment

- `templates/pages.yml` goes into the archive repo's `main` branch. It needs:
  - repository variables `REJGAU_REF` (git ref of this repo to build with) and `ARCHIVE_PATH` (folder);
  - Pages set to "GitHub Actions".
- The job:
  1. `actions/checkout` of the `archive` branch.
  2. `actions/checkout` of `int19h/rejgau@$REJGAU_REF`.
  3. `npm ci`.
  4. `npm run build:site`.
  5. `actions/upload-pages-artifact`, then `actions/deploy-pages`.
- `concurrency: pages`, with cancel-in-progress.

## Testing

- **Build step:** unit tests over synthetic raw lines covering edits, deletes, reaction folding, replay duplicates, LOADING-then-update, unfurls, REST + MEMBER_SNAPSHOT, and a thread that is later unselected.
- **Reader:** unit tests for the markdown renderer (Discord quirks) and the search parser and matcher.
- **Visual check:** Playwright screenshots of the reader over the real `rejgau-test` archive, built locally.
- **Fixtures from real data:** the backfilled-poll vote sequence, and a LOADING → V2 update.

## Deferred from v1

- Hover cards.
- A month picker (prev/next only).
- A theme toggle.
- Lottie sticker rendering.
- Styled `<id:customize>` links and command mentions (plain labels only).
- Media download for private archives.

## Open questions

- Deleted messages are shown with a "deleted" badge by default. Should a build flag hide them instead?
- Should the reader show a per-message "view raw JSON" for power users? It's cheap to add.
