# rejgau: design

rejgau archives selected channels of a Discord server into a git repository. It also ships a static, Discord-like reader with search.

Status: design agreed; feasibility spike done (see [Spike results](#spike-results-2026-09-29)). Research date: 2026-09-29.

## Goals and non-goals

**Goals**
- Keep a verbatim raw record of everything the bot can observe in the selected channels. This includes metadata, edits, deletes, reactions, polls, threads, and responses from other apps.
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
                         │                      and uploads media as release assets
                         ├─ /status, /flush     admin HTTP endpoints (ADMIN_KEY)
                         └─ cron */5            ensures the Gateway session is running

GitHub: <server>-archive (public or private)
  branch main      README (+ later: Pages workflow)
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
- **Configuration** (see the README for the exact schema):
  - Secrets: `DISCORD_TOKEN`, `GITHUB_APP_PRIVATE_KEY`, `ADMIN_KEY`.
  - Variables: `GITHUB_APP_ID`, and `REJGAU_CONFIG`, a JSON object mapping each guild to its repo, branch, folder, channel selection and backfill flag.
  - Variables are managed in the Cloudflare dashboard (`keep_vars`). Changing them redeploys, which restarts the Durable Objects; the session just resumes.
  - Admin slash commands are deferred: at this scale, editing one JSON variable is simpler than running an Interactions endpoint.

### Discord

- **Install** with `scope=bot`, `integration_type=0`, `permissions=66560` (View Channel + Read Message History). Add Connect (1115136 total) if voice-channel text history backfill is wanted. The bot sends nothing, so it needs no send permissions.
- **Intents:** `GUILDS`, `GUILD_EXPRESSIONS`, `GUILD_MESSAGES`, `GUILD_MESSAGE_REACTIONS`, `MESSAGE_CONTENT` (privileged; a portal toggle below 10k users), `GUILD_MESSAGE_POLLS`. `GUILD_SCHEDULED_EVENTS` is optional.
- **Channel selection.** "Public" is a server convention, not a Discord permission bit. For example, the main server keeps most channels hidden from @everyone until members pass a bot check. So the bot archives **any** channel it can see and that the config selects, private or not:
  1. Discord permissions decide what the bot *can* see. The admin grants the bot's role View Channel + Read Message History wherever archiving is wanted. From 2026-11-16, channels the bot can't view arrive obfuscated (`___hidden___`, flag 1<<17) and are ignored.
  2. `REJGAU_CONFIG` decides what it *does* archive: `"channels": "all"`, or a list of channel and/or category IDs. A category includes all its current and future channels. An optional `exclude` list applies on top.

  Threads (public, private the bot can see, and forum posts) are included when their parent channel is.
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
  archive.json                  { format: 1, guild_id, generator }
  raw/YYYY/MM/DD.jsonl          RAW: every archived event, verbatim, plus rejgau records (the bot only appends here)
  -- phase 2 (reader), generated from raw/ by a GitHub Action:
  guild.json                    latest guild snapshot (from GUILD_SNAPSHOT / GUILD_UPDATE / role & emoji events)
  channels.json                 id → latest object of every archived channel & thread and their ancestors
  media.json                    media index (from MEDIA_STORED / MEDIA_FAILED records)
  users.json                    id → latest user/member info seen (username, global_name, avatar, nick, bot)
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
  - `rest`: backfill or catch-up. `t` is `MESSAGE_CREATE` and `d` is the REST message object. These lines go into the file for the day the message was *created*, not the day it was fetched, so backfilled history lands where a reader expects it.
  - `rejgau`: synthetic records:
    - `GUILD_SNAPSHOT`: written instead of the raw `GUILD_CREATE`, and with no `channels`, `threads`, `members`, `presences` or `voice_states`. The raw `GUILD_CREATE` lists every channel the bot can see, which would leak the names of channels that aren't archived.
    - `CHANNEL_SNAPSHOT`: the channel or thread object when it first becomes archived.
    - `CATCHUP_BEGIN` / `CATCHUP_END`: bracket REST catch-up after a lost session.
- Only events concerning archived channels (and guild-level events needed for rendering) are written. Events for other channels, including `CHANNEL_*`/`THREAD_*` for them, are dropped.
- Delivery is at-least-once: after a crash, events may be replayed and REST catch-up may repeat live messages. Consumers dedupe by message ID and event content.
- Live events only append to the current day's file. Backfill appends to past days' files.
- At ~100 messages a day, a day file is ~200–400 KB, and ~100 MB a year uncompressed. Git's delta compression makes the repository much smaller than that.

### Privacy filtering

All logged payloads pass through `src/sanitize.ts`. It keeps what channel members can see in the client and drops moderation state, security configuration, safety-scanner output, app-internal IDs and bot-perspective fields. The README lists each field and why. "Verbatim" in this document means verbatim minus those fields.

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
- **What's archived:** attachments (including Components V2 media), embed images and thumbnails (from the original URL), sticker images, custom emoji (in content and reactions), user and member avatars, and the guild icon.
- **Asset names** come from Discord identity, not a content hash. This lets the Worker stream downloads straight into the upload without buffering, within its 128 MB memory limit:
  - `att-<attachment_id>-<filename>`
  - `emoji-<id>.<png|gif>`
  - `sticker-<id>.<png|json>`
  - `avatar-<user_id>-<hash>.<png|gif>`
  - `embed-<sha256(url)[:16]>.<ext>`
  - `guild-<id>-<hash>.png`

  Avatars and emoji dedupe naturally, since Discord's hash changes when the image changes.
- **Keys** as implemented: `att-<attachment_id>-<filename>`, `ext-<fnv64(url)>.<ext>` (embed images and external media), `emoji-<id>.<png|gif>`, `sticker-<id>.<png|json|gif>`, `avatar-<user>-<hash>.<png|gif>`, `gavatar-<guild>-<user>-<hash>.<ext>` and `guild-<id>-<hash>.<ext>`. The reader computes the key for any Discord media reference the same way (`src/media.ts`).
- **Index:** each upload is recorded in raw as `MEDIA_STORED {key, release, name, url, size, content_type}` or `MEDIA_FAILED {key, reason}`. Phase 2 folds these into `media.json`.
- **Size cap:** files above `maxMediaBytes` (default 100 MB) are recorded as `{ error: "too_large" }`.
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
- **Pause for surgery.** `POST /pause` stops commits (events keep buffering); the procedure is pause → flush → rewrite → force-push → resume.
- **Never append from a cache.** Before appending to a day file, read the *current tip version* and append to that. This way a manual redaction is never resurrected by the bot's in-memory copy. Comparing blob SHAs with what the bot last wrote makes this cheap in the common case.
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

The spike lived in `spike/` (removed after it served its purpose; see commit `b069b37`). It was deployed to Workers Paid as `rejgau-spike` and connected to the test server.

- **Gateway from a Durable Object works.** HELLO arrives about 50 ms after the upgrade, and IDENTIFY/READY and heartbeats work.
- **Restarts and resume.** Over the first ~3.5 h the Durable Object restarted 4 times, with no deploys. Each time the alarm reconnected and RESUMEd successfully, with 0 re-identifies and 0 zombie connections. Restarts are routine, so resume must be solid, and the gap-detection path is still required for when resume fails.
- **CDN** results are as described under Media.
- **Observed payloads**
  - Deferred command responses: `MESSAGE_CREATE` with flags `LOADING` (128), then `MESSAGE_UPDATE` with the real content (here `IS_COMPONENTS_V2`, 32768).
  - When an app edits its own response (e.g. jbotci re-rendering after a button click, which is app-specific behavior), we see `MESSAGE_UPDATE` with `edited_timestamp`, and the original command's `interaction_metadata` is kept. The click itself is invisible.
  - Components V2 arrive as the full tree, including media gallery items that point at `cdn.discordapp.com` attachments.
  - Link embeds arrive as a follow-up `MESSAGE_UPDATE` with no `edited_timestamp` (unfurl).
  - Forwards (`flags` 16384) carry full `message_snapshots` content, including forwards from other channels.
  - Polls, poll votes, reactions, edits and deletes all arrive as expected.
  - User objects carry many cosmetic fields (`collectibles`, `primary_guild`, `avatar_decoration_data`, …). They are kept verbatim in raw, and the reader ignores what it doesn't render.
- **User-installed apps work.** A command from an app installed only for the user (not in the server) produced a normal `MESSAGE_CREATE` (LOADING) and `MESSAGE_UPDATE`. They carry `interaction_metadata.name` and `authorizing_integration_owners: {"1": <user id>}`, with no `"0"` (guild) key, which distinguishes them from guild-installed apps.

## Implementation phases

1. **Bot (this phase).** Gateway session, routing, raw logs, snapshots, media, catch-up and backfill, commits.
   - Backfill pages forward from the start of each selected channel and its active threads, paced.
   - Archived threads are not backfilled yet.
2. **Reader.** Derived `view/`, `users.json` and `manifest.json` (generated by a GitHub Action from `raw/`, so the bot stays simple), the static reader, and a Pages workflow.
   - Pages and release-asset images require a **public** repo (or a paid plan for Pages on private repos; private release assets need auth to view).

Later:
- Archived-thread backfill.
- Admin slash commands.
- The helper for manual deletion surgery.
