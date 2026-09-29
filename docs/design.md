# rejgau: design

rejgau archives the public channels of a Discord server into a git repository. It also ships a static, Discord-like reader with search.

Status: design agreed; feasibility spike done (see [Spike results](#spike-results-2026-09-29)). Research date: 2026-09-29.

## Goals and non-goals

**Goals**
- Keep a verbatim raw record of everything the bot can observe in selected public channels. This includes metadata, edits, deletes, reactions, polls, threads, and responses from other apps.
- Make the archive outlive its operator. Logs and media live on the git host (GitHub first), not in the operator's paid infrastructure. The bot is just a writer.
- Provide a static reader that works from GitHub Pages. It renders messages close to how Discord does, read-only, and supports Discord search syntax.
- Keep the code generic, so anyone can run their own deployment.

**Non-goals, for now**
- Multi-tenant hosting. One deployment serves a handful of servers (1 main, 1 test, maybe 3–5 more), with well under 10k users in total. At that size the Message Content intent is a toggle in the developer portal, with no review.
- Git hosts other than GitHub. The writer sits behind an adapter interface so GitLab and Forgejo can be added later.
- Automated deletion or opt-out handling. Deletions are done by hand by the archive admin, who is also the Discord server admin; see [History rewrites](#history-rewrites-by-the-admin). The server rules say so. The bot records `MESSAGE_DELETE` events like any other event, but does not redact anything itself.
- A GitHub Discussions mirror. It was considered and deferred.

## Architecture

```
Discord Gateway ──ws──► Cloudflare Worker "rejgau" (workers.dev, Workers Paid)
                         ├─ DO GatewaySession   one per bot: socket, heartbeat alarm, resume, routing
                         ├─ DO GuildArchive     one per guild: SQLite buffer + state, flush alarm,
                         │                      commits via GitHub App (Git Data API)
                         ├─ /interactions       our admin slash commands (Ed25519-verified)
                         └─ media fetcher       Worker-direct if Discord's CDN allows it, otherwise
                                                a GitHub Action triggered via repository_dispatch

GitHub: <server>-archive (public)
  branch main      README, workflows (thin wrappers around rejgau's reusable workflows)
  branch archive   the logs; see "Archive layout". Written only by the bot; may be force-pushed by the admin.
  releases         media-YYYY-MM[.n]: attachments, avatars, emoji and stickers as release assets
  pages            reader + archive data, deployed by Actions on push to `archive`
```

### Cloudflare

- **Plan: Workers Paid ($5/month).** The existing personal account appears to be on it already.
  - The Gateway connection is an *outbound* WebSocket, which cannot hibernate. The Durable Object therefore stays resident: 128 MB × 86,400 s = 10,800 GB-s per day, about 330k GB-s per month. That is inside the 400k GB-s per month the plan includes.
  - The free plan would also fit that duration, but its limits are too tight: 10 ms CPU per event, 50 subrequests per invocation, and 100k SQLite row writes per day.
- **Liveness**
  - An open outbound socket protects a Durable Object from eviction for only 15 minutes. So a self-rescheduling alarm sends each heartbeat (interval ≈ 41 s) and acts as the watchdog.
  - Deploys and runtime updates restart the Durable Object.
  - `session_id`, `resume_gateway_url` and `seq` are persisted in the same transaction as the buffered events. On restart the alarm finds "session state but no socket" and RESUMEs, and Discord replays the missed events.
  - If the session can't be resumed (op 9 with `d: false`, or close code 4007/4009), the bot re-IDENTIFYs. It then catches up each channel over REST with `GET /channels/{id}/messages?after=<last id>`, and writes a synthetic `GAP` record around the catch-up.
- **No transport compression.** Bandwidth is free, and zlib-stream across Durable Object restarts only adds bugs.
- **REST pacing**
  - Honour the `X-RateLimit-*` headers and never retry-storm.
  - Workers share egress IPs, and Discord bans per IP after 10k invalid requests (401, 403 or 429) in 10 minutes. Backfill is the risky path, so it runs slowly.
- **Secrets:** the Discord bot token, the GitHub App private key and the app ID. Per-guild config lives in `GuildArchive` storage and is set with admin slash commands.

### Discord

- **Install** with `scope=bot applications.commands`, `integration_type=0`, `permissions=66560` (View Channel + Read Message History). Add Connect (1115136 total) if voice-channel text history backfill is wanted. The bot sends nothing, so it needs no send permissions.
- **Intents:** `GUILDS`, `GUILD_EXPRESSIONS`, `GUILD_MESSAGES`, `GUILD_MESSAGE_REACTIONS`, `MESSAGE_CONTENT` (privileged; a portal toggle below 10k users), `GUILD_MESSAGE_POLLS`. `GUILD_SCHEDULED_EVENTS` is optional.
- **Channel selection has three gates:**
  1. Discord permissions. The admin controls what the bot's role can see. From 2026-11-16, channels the bot can't view arrive obfuscated (`___hidden___`).
  2. Explicit opt-in with `/archive enable #channel`, which requires Manage Server.
  3. A public check: the bot refuses unless `@everyone` effectively has View Channel, computed from the guild's @everyone permissions plus the channel's @everyone overwrite.

  Public threads (including forum posts) of enabled channels are included automatically. Private threads never are.
- **Captured events**
  - Messages: create, update, delete, delete-bulk.
  - Reactions: add, remove, remove-all, remove-emoji.
  - Polls: votes, add and remove.
  - Pins: `CHANNEL_PINS_UPDATE`, plus the type-6 system message.
  - Threads: create, update, delete, list-sync.
  - Channels: update of enabled channels (name, topic).
  - Guild: updates to guild, roles, emoji and stickers (needed for rendering).
  - Text chat in voice and stage channels, and forwards (`message_snapshots`).
- **Other apps' commands**
  - What's visible: the public response message (type 20/23) with `interaction_metadata` (invoking user, target, follow-up linkage), and the command name. The spike confirmed the name is present both in the deprecated `interaction.name` and, undocumented, in `interaction_metadata.name` (with `command_type`), including the subcommand path (e.g. `jbotci gentufa`).
  - Deferred responses appear as a LOADING message followed by `MESSAGE_UPDATE`.
  - Not visible: the invocation itself, command arguments, ephemeral responses, and button/select/modal submissions (only their visible effects).
  - Components V2 layouts arrive as the full component tree.

## Archive layout

Everything below lives under a configurable folder on the `archive` branch. All times and days are UTC.

```
<folder>/
  archive.json                  { format: 1, guild_id, generator, … }
  guild.json                    latest guild snapshot: name, icon, roles, emoji, stickers
  channels.json                 id → latest channel/thread object for every archived channel & thread
  users.json                    id → latest user/member info seen (username, global_name, avatar, nick, bot)
  media.json                    media index: see "Media"
  raw/YYYY/MM/DD.jsonl          RAW: every gateway dispatch received that day, verbatim, in order
  view/<channel_id>/YYYY-MM.json DERIVED: reader data for messages created that month in that channel
  manifest.json                 reader entry point: channels, months available, counts, sizes
```

### Raw log (source of truth)

- There is one line per event, in receive order:
  ```json
  {"at":"2026-09-29T10:41:07.123Z","src":"gw","s":1234,"t":"MESSAGE_CREATE","d":{…verbatim…}}
  ```
- `src` is one of:
  - `gw`: live Gateway dispatch.
  - `rest`: backfill or catch-up. `t` is `MESSAGE_CREATE` and `d` is the REST message object.
  - `rejgau`: synthetic records such as `GAP`, `CHANNEL_ENABLED`, `CHANNEL_DISABLED` and `RESTART`.
- Only events concerning archived channels (and guild-level events needed for rendering) are written. Events for other channels are dropped at the router.
- A day's file is append-only while the day is current. The bot never rewrites past days' raw files.
- At ~100 messages a day, a day file is ~200–400 KB, and ~100 MB a year uncompressed. Git's delta compression makes the repository much smaller than that.

### Derived view (regenerable)

- A late edit, reaction or delete to an old message changes that message's *month* file. The reader therefore never has to replay events.
- **Format:** per channel per month, a compact JSON built for the reader:
  - users referenced by ID rather than embedded;
  - Discord fields normalized;
  - edit history kept (`edits: [{at, content, …}]`);
  - deletes kept as `deleted_at` (content retained, since redaction is manual);
  - reactions aggregated.
- **Size:** roughly 300–500 bytes per message, so a whole year of the main server is ~15–20 MB. The reader can load all of it for search.
- The generator is a pure function from raw logs to view files. A `rebuild` command regenerates everything from `raw/`, for example after a format change or manual surgery.

## Media

- **Store:** GitHub Release assets in the archive repo.
  - Official API; each file must be under 2 GiB; up to 1000 assets per release; no limit on total size or bandwidth.
  - They are not part of the git tree, and live as long as the repo does.
  - Download URLs redirect to signed blob URLs that `<img>`/`<video>`/`<audio>` load directly and that support byte ranges. There's no CORS, so other file types are download links in the reader.
- **Releases:** one per month, `media-YYYY-MM`, rolling over to `media-YYYY-MM.2` at 1000 assets. Expected volume is ≤10 images a day, ~300 a month.
  - Their tags point at a dedicated parentless **media-root commit**, never into `archive` history. A history rewrite then never has tags pinning old log content.
- **What's archived:** attachments, embed images and thumbnails (`proxy_url`), sticker images, custom emoji, user avatars, and the guild icon. Assets are content-addressed (`<sha256>.<ext>`) to deduplicate avatars and emoji.
- **Index:** `media.json` maps each source (attachment ID, `emoji:<id>`, `avatar:<user>/<hash>`, …) to `{ sha256, size, type, release, asset }`.
- **Fetcher**
  - Attachment URLs are signed and expire (the lifetime is undocumented; historically 24 h), so media is fetched at ingest.
  - The spike showed that Workers **can** fetch from `cdn.discordapp.com`: real signed attachments, avatars, custom emoji, and PNG/APNG/Lottie stickers (`cdn.discordapp.com/stickers/{id}.png|json`). Discord's docs claiming a 403 are outdated.
  - Discord's proxy hosts are blocked (Cloudflare 403): `media.discordapp.net` and `images-ext-*.discordapp.net`. We avoid them:
    - attachments: use `url` rather than `proxy_url`;
    - embed images and thumbnails: fetch the embed's original `url` (e.g. `i.ytimg.com`, `repository-images.githubusercontent.com`) directly;
    - GIF stickers (`format_type` 4) exist only on `media.discordapp.net`. They are recorded as "unfetched", with a GitHub Action fallback later if they turn out to matter.
  - So the `GuildArchive` Durable Object downloads each file and uploads it to the release itself (`uploads.github.com`). No Action is needed.
  - Only the bot writes the `archive` branch.

## Writing to GitHub

- **Auth:** a GitHub App installed only on the archive repo, with `contents: write` (commits, releases and dispatch) and `metadata: read`.
  - The Worker signs an RS256 JWT with WebCrypto and exchanges it for a 1-hour installation token.
  - Commits are authored by `rejgau[bot]` and show as Verified, provided no custom author or committer is set.
- **Commit flow (Git Data API)**
  1. `GET ref`.
  2. For each changed file, the new content goes inline in a `POST trees` call with `base_tree`. Text is UTF-8, so no separate blob calls are needed.
  3. `POST commits`.
  4. `PATCH ref`, without `force`.

  That is 4 calls per flush, far below GitHub's secondary limits (80 content-creating requests per minute, 500 per hour).
- **Cadence:** flush when there are pending events *and* either 2 minutes have been idle or 10 minutes have passed since the first pending event. Both values are configurable. At current volume that's a few dozen commits a day.

### History rewrites by the admin

The admin may rewrite `archive` history at any time, for example to remove messages on request. The writer and all readers must tolerate that:

- **Never assume the previous commit is an ancestor.** Each flush reads the current head and builds on it. If the ref update fails because the head moved, it re-reads and retries. It does not force.
- **Never append from a cache.** Before rewriting a file (today's raw file, a view month, `users.json`, `media.json`), read the *current tip version* and apply the change to that. This way a manual redaction is never resurrected by the bot's in-memory copy. Comparing blob SHAs with what the bot last wrote makes this cheap in the common case.
- **Readers (Actions, Pages, the reader) process the files at the tip, never commit ranges or diffs.** Work must be idempotent: "which media sources lack an index entry", not "what changed since commit X".
- Release tags live on the media-root commit, so a rewrite never needs to touch them.
- **Deletion procedure** (documented in the archive repo's README, possibly with a helper script later):
  1. Remove or replace the lines in `raw/` and the entries in `view/`, or run `rebuild`.
  2. Remove the `media.json` entries and delete the release assets.
  3. Rewrite history (e.g. `git filter-repo`) and force-push.
  4. Optionally ask GitHub Support to purge cached views and unreachable objects.

  Forks and Software Heritage snapshots are outside our control.

## Reader

- **Hosting:** static HTML/JS, built in this repo and published as an Action or release artifact. The archive repo's Pages workflow deploys the reader together with the archive data. Everything is then same-origin, and Pages is well within its 1 GB site limit.
  - The reader also works from anywhere else via `?archive=<base URL>`. GitHub Pages sends `Access-Control-Allow-Origin: *`.
  - Avoid `raw.githubusercontent.com`: it has had undocumented per-IP limits since 2025-05.
- **Data loading:** load `manifest.json` → `guild.json`/`channels.json`/`users.json`/`media.json` → `view/<channel>/<month>.json` on demand.
- **Rendering:** read-only, close to Discord.
  - Markdown with Discord's quirks, parsed with a simple-markdown-based rule set: `discord-markdown-parser` is a candidate base. Supported syntax:
    - line-start-only headers, lists, `-#` subtext and quotes, including `>>>`;
    - spoilers, masked links, code blocks with highlighting;
    - mentions, custom emoji (jumbo when the message is emoji-only), and `<t:…:style>` timestamps in the viewer's locale;
    - command mentions and guild navigation links.
  - Message parts:
    - replies, forwards, embeds, attachments, stickers, reactions, polls (results) and threads;
    - system messages;
    - the "X used /cmd" header on command responses;
    - Components V1 (disabled) and V2 (container, section, text display, thumbnail, media gallery, file, separator, action rows).
  - Beyond Discord: an edit-history viewer, and "deleted" badges.
- **Search**
  - Filters parsed from Discord syntax:
    - `from:`, `mentions:`, `in:`;
    - `has:` (link, embed, file, image, video, sound, sticker, poll, forward);
    - `before:`, `after:`, `during:`;
    - `pinned:`, `authorType:` (user, bot, webhook);
    - `-` negation and `"exact phrase"`.
  - Anything else is plain text: case-insensitive and diacritic-insensitive.
  - `from:` and `mentions:` resolve names through `users.json`. `in:` resolves through `channels.json`.
  - v1 scans view files in a Web Worker, newest first, with date and channel filters pruning which files are fetched. At the expected volume the whole archive fits comfortably. A prebuilt index (MiniSearch shards, Pagefind or SQLite FTS built in CI) can come later if needed.

## Spike results (2026-09-29)

The spike is in `spike/`. It was deployed to Workers Paid as `rejgau-spike` and connected to the test server.

- **Gateway from a Durable Object works.** HELLO arrives about 50 ms after the upgrade, and IDENTIFY/READY and heartbeats work.
- **Restarts and resume.** Over the first ~3.5 h the Durable Object restarted 4 times, with no deploys. Each time the alarm reconnected and RESUMEd successfully, with 0 re-identifies and 0 zombie connections. Restarts are routine, so resume must be solid, and the gap-detection path is still required for when resume fails.
- **CDN** results are as described under Media.
- **Observed payloads**
  - Deferred command responses: `MESSAGE_CREATE` with flags `LOADING` (128), then `MESSAGE_UPDATE` with the real content (here `IS_COMPONENTS_V2`, 32768).
  - Button clicks that edit a response: `MESSAGE_UPDATE` with `edited_timestamp`. The original command's `interaction_metadata` is kept.
  - Components V2 arrive as the full tree, including media gallery items that point at `cdn.discordapp.com` attachments.
  - Link embeds arrive as a follow-up `MESSAGE_UPDATE` with no `edited_timestamp` (unfurl).
  - Forwards (`flags` 16384) carry full `message_snapshots` content, including forwards from other channels.
  - Polls, poll votes, reactions, edits and deletes all arrive as expected.
  - User objects carry many cosmetic fields (`collectibles`, `primary_guild`, `avatar_decoration_data`, …). They are kept verbatim in raw, and the reader ignores what it doesn't render.
- **Not yet verified:** responses from an app installed *only* as a user app. The test app is installed both on the guild and for the user.

Later:
- Backfill of existing history when a channel is enabled: on by default, paced.
- The helper for manual deletion surgery.
