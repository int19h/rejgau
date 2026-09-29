# rejgau reader: design (phase 2)

This covers the static reader for rejgau archives, plus the build step that turns `raw/` into data the reader can load quickly. See [design.md](design.md) for the archive format and the bot.

## Goals

- **A read-only, Discord-like view** of an archive:
  - a channel list (categories, channels, threads);
  - messages grouped by author, as Discord does;
  - Discord markdown, embeds, attachments, components, polls, stickers, reactions, replies, forwards, and app-command headers;
  - edit history and deleted-message badges.
- **Search with Discord's syntax** (`from:`, `in:`, `has:`, `before:`, `after:`, `during:`, `mentions:`, `pinned:`, `authorType:`, `-` negation, `"phrases"`). Anything else is plain text.
- **Static hosting only:** GitHub Pages, deployed by an Action in the archive repo. The reader also works from anywhere via `?data=<url>` pointing at CORS-enabled data.
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

The Pages workflow runs on pushes to `archive`, debounced by `concurrency` with cancel-in-progress, and also on a schedule as a safety net.

- **Why the build runs in CI:**
  - The generator is a pure function from raw to site. That keeps the bot append-only, and history rewrites need no special handling: every build is a full rebuild.
  - At ~100 messages a day, a full rebuild is seconds.
- **Private repos:** Pages on a private repo needs a paid GitHub plan, and release-asset media from a private repo only loads for signed-in viewers. For local use:
  - `npm run build:site -- --archive <path> --out <dir>` builds the same site;
  - `npm run serve` serves it.

## Build step (`tools/build.ts`)

**Input:** every `raw/**/*.jsonl` of one archive folder.

**Order:** lines are processed in a single global order:
1. by `at`;
2. ties keep file order.

This works because:
- `rest` lines have `at` equal to their fetch time;
- `gw` lines have their receive time.

**Folding into state:**

| Record | Effect on state |
|---|---|
| `GUILD_SNAPSHOT`, `GUILD_UPDATE`, `GUILD_ROLE_*`, `GUILD_EMOJIS_UPDATE`, `GUILD_STICKERS_UPDATE` | Update the latest guild state: name, icon, roles (for mention colours and names), emoji, stickers. |
| `CHANNEL_SELECTED`, `CHANNEL_*`, `THREAD_*`, `THREAD_LIST_SYNC` | Update channel and thread objects, including the ancestors carried in `CHANNEL_SELECTED`. Unselected channels keep their history but are marked as such. |
| `MESSAGE_CREATE` (`gw` or `rest`) | Create the message, or merge it into an existing one. A duplicate from replay or catch-up is recognised by ID and doesn't count as an edit. |
| `MESSAGE_UPDATE` | Merge fields into the message. If `edited_timestamp` changed, first push the previous content, embeds, attachments and components onto `edits[]`. Unfurls and component-only updates without a new `edited_timestamp` merge silently. A LOADING-flag message becoming a real response is also a silent merge. |
| `MESSAGE_DELETE`, `MESSAGE_DELETE_BULK` | Set `deleted_at`. The content is kept, since redaction is manual. |
| `MESSAGE_REACTION_ADD`, `_REMOVE`, `_REMOVE_ALL`, `_REMOVE_EMOJI` | Maintain the reactor sets per emoji. For backfilled messages, the message's `reactions[]` counts are the baseline (Discord's REST history has no reactor lists). |
| `MESSAGE_POLL_VOTE_ADD`, `_REMOVE` | Maintain voter sets per answer, falling back to `poll.results` counts. |
| `CHANNEL_PINS_UPDATE`, `pinned` field | Track pinned state. |
| `MEMBER_SNAPSHOT` | Fallback member info (nickname, roles, avatar) for REST messages without a `member`. |
| `MEDIA_STORED`, `MEDIA_FAILED` | Build the media index. The last record for a key wins. |

**Output** (`site/data/`, all JSON, gzipped by Pages on the wire):

```
data/archive.json              guild (name, icon, roles, emoji), channels tree (id, name, type, parent,
                               topic, selected), per-channel month list with counts, build time, format
data/media.json                key → { url, type, size, w?, h? } | { error }
data/users.json                user id → latest { username, global_name, avatar, bot, nick?, roles? }
data/c/<channel>/<YYYY-MM>.json
  { users: { <snapKey>: {id, username, global_name, avatar, nick, roles, bot, …} },
    messages: [ { id, ts, type, flags, author: <snapKey>, content, edits?, deleted_at?,
                  edited_at?, attachments, embeds, components, sticker_items, poll?, votes?,
                  reactions?: [{emoji, count, users?}], reference?, referenced?: {id, author, excerpt},
                  snapshots?, interaction?: {name, user: <snapKey>, type, command_type}, thread?,
                  webhook_id?, application_id?, pinned?, mentions: [ids], mention_roles,
                  mention_everyone } ] }
```

**Author snapshots are per message.** Each message references the author exactly as they appeared when it was logged. Snapshots are deduplicated per month file by content hash (`snapKey`). The reader therefore shows names as they were at the time. `users.json` gives current names for search (`from:`) and hover cards.

**Month files are keyed by message creation month (UTC).** Threads get their own `c/<thread id>/…` files.

**Sizes:** month files are ~0.5–1 KB per message, so ~20–40 MB/year for the main server before gzip. That is well within Pages limits, and small enough to scan for search.

## Reader (`reader/`)

**Stack:** Preact + TypeScript bundled by esbuild into one JS file and one CSS file.
- Markdown: `discord-markdown-parser` (an AST following Discord's simple-markdown rules), rendered by us.
- Code blocks: `highlight.js` with a small set of languages, loaded lazily.
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
- Themes: dark by default, with a light theme via `prefers-color-scheme` and a toggle.

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
- **Matching:** case- and diacritic-insensitive substring match over content, embed text, component text displays, attachment filenames, and forwarded content.
- **Execution:**
  - A Web Worker loads month files newest-first, pruned by `in:` and the date filters.
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

## Open questions

- Deleted messages are shown with a "deleted" badge by default. Should a build flag hide them instead?
- Should the reader show a per-message "view raw JSON" for power users? It's cheap to add.
