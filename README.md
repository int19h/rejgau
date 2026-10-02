# rejgau

rejgau archives Discord channels into a git repository. A Cloudflare Worker keeps a Gateway connection open, records every event in the selected channels verbatim as JSONL, stores attachments and other media as GitHub release assets, and commits the logs to a branch of your archive repo every few minutes.

The archive is meant to outlive whoever runs the bot. All data ends up in the GitHub repo; Cloudflare only buffers it.

Status: the bot (phase 1) and the static reader with search (phase 2) are both implemented. See [docs/design.md](docs/design.md) for the design and the reasoning behind it.

## What ends up in the repo

On the archive branch (default `archive`), under the configured folder:

```
archive.json                   format marker: {"format": 2, "guild_id": …} (format 1: one raw/YYYY/MM/DD.jsonl per day)
raw/YYYY/MM/DD/<channel>.jsonl one JSON object per line: a UTC day of one channel or thread (by ID)
raw/YYYY/MM/DD/guild.jsonl     the same day's server-wide records: snapshots, roles, emoji, members, media, sessions, config
```

Lines about a channel or thread (messages, edits, deletions, reactions, pins, polls, channel and thread events, and the bot's selection and backfill records for it) go into that channel's file, so one channel's history can be read or removed on its own. To read a day in order, merge its files by `at`.

Each line is `{"at", "src", ["sid", "s"], "t", "d"}`:

| `src` | Meaning |
|---|---|
| `gw` | A Gateway dispatch: `d` as received, minus non-public fields (see [Privacy filtering](#privacy-filtering)). `sid` is an opaque stand-in for the session ID, and `s` is the sequence number. Filed under the day it was received. |
| `rest` | A message fetched over REST during backfill or catch-up. `t` is `MESSAGE_CREATE`. Filed under the day the message was *created*; `at` is when it was fetched. |
| `rejgau` | A synthetic record (see below). |

The synthetic records are:

| Record | Meaning |
|---|---|
| `CONFIG` | The guild's selection settings changed. |
| `SESSION_START`, `SESSION_RESUMED` | A new Gateway session, or a resumed one. |
| `GUILD_SNAPSHOT` | Guild metadata (name, icon, roles, emoji, stickers). Built from an allowlist of fields, so it never includes channel lists or members. |
| `CHANNEL_SELECTED`, `CHANNEL_UNSELECTED` | A channel or thread started or stopped being archived. `CHANNEL_SELECTED` includes the channel object and its parent/category objects. |
| `BACKFILL_END`, `CATCHUP_BEGIN`, `CATCHUP_END` | History fetched over REST. Catch-up after a lost session recovers new messages only, not edits, deletes or reactions made while disconnected. |
| `MEMBER_SNAPSHOT` | `{user_id, member}` for each author of backfilled messages, because REST history has no nicknames or roles. The values are as of backfill time; `member` is null if the person left the server. |
| `MEDIA_STORED`, `MEDIA_FAILED` | A media item was uploaded, or couldn't be. `MEDIA_STORED` includes `key`, `release`, `url`, `size` and `content_type`. |

**Delivery is at-least-once.** A message can appear more than once: replays after a crash, or catch-up overlapping live events. Consumers dedupe by message ID.

**Media** goes to releases named `media-YYYY-MM` (then `media-YYYY-MM.2`, … past 1000 assets). Their tags point at a parentless `media-root` commit, never into the archive branch history.

**Nothing about unselected channels is written.** That includes their names, their events, and threads under them. Two exceptions:
- Forwarded messages carry the forwarded content wherever they are posted.
- A parent channel's "thread created" system message shows the thread's name even if that thread is excluded.

## Privacy filtering

Every logged payload goes through `src/sanitize.ts`. The rule: keep what any member of the channel can see in the Discord client, and drop everything else. What stays:
- content, attachments, embeds and components;
- names, avatars, badges and profile cosmetics;
- nicknames, roles and join dates;
- reactions and who reacted, and poll votes and who voted.

These fields are removed wherever they appear:

| Removed | Why |
|---|---|
| member `communication_disabled_until`, `mute`, `deaf`, `pending`, `flags`, `unusual_dm_activity_until` | Moderation state: timeouts, voice mute/deafen, membership screening, rejoin/verification/quarantine flags. |
| user `flags` (`public_flags` is kept) | Includes private account flags. |
| `permission_overwrites`, `permissions` | Security configuration. Overwrites also list who has explicit access to private channels. |
| `content_scan_metadata`, `content_scan_version` | Discord's safety-scanner verdicts on attachments and embeds. |
| component `custom_id` | Opaque app state, which may embed user IDs or signed tokens. |
| `party_id` | Rich-presence invite join secret. |
| emoji and sticker `user` | Who uploaded them, which only server managers can see. |
| `nonce`, `me`, `me_burst`, `burst_me`, `me_voted`, `vad_colors` | Client-internal, or the bot's own point of view. |

Also:
- Real Gateway session IDs are never published.
- `CONFIG` records say only how many channels are excluded, not which ones.
- Guild snapshots are built from an allowlist of fields (no channel lists, members, or AFK/system/rules channel IDs).
- Nothing about unselected channels is logged.

## Setup

### 1. Discord application

1. Create an application at <https://discord.com/developers/applications>. Under **Bot**:
   - enable **Message Content Intent**;
   - turn **Public Bot** off, unless you want others to be able to add it;
   - copy the bot token.
2. Invite the bot with
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=66560&integration_type=0`
   (View Channels + Read Message History; the bot never sends anything).
3. In the server, make sure the bot's role can **view and read history** in every channel you want archived. Private channels are fine: the bot archives whatever it can see and the config selects.
   - Private threads are only visible if the bot is added to them, or if it has **Manage Threads**.
   - For text chat in voice channels, backfill also needs **Connect**.

### 2. GitHub App and archive repo

1. Create the archive repository. It can be empty; the bot seeds it. A private repo works for testing. The phase 2 reader needs it public, or GitHub Pages on a paid plan.
2. Create a GitHub App (**Settings → Developer settings → GitHub Apps → New GitHub App**):
   - Homepage URL: anything, e.g. this repo.
   - Webhook: uncheck **Active**.
   - Repository permissions: **Contents: Read and write** (Metadata: Read-only is added automatically).
   - Where can this GitHub App be installed: **Only on this account**.
3. Note the **App ID**, and generate a **private key** (a `.pem` download).
4. **Install App** → choose **Only select repositories** → the archive repo.

Commits then appear as `<app-name>[bot]` and are marked Verified.

### 3. Cloudflare Worker

This needs the Workers Paid plan: the Gateway connection keeps a Durable Object running around the clock.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run deploy
```

The deployment command requires a clean Git checkout. It records the full commit ID on the Worker version.

If Cloudflare lists multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` to the intended account before deployment.

For a local bundle without deployment, run `npm run deploy -- --dry-run --outdir /tmp/rejgau-worker`.

Then, in the Cloudflare dashboard, go to **Workers & Pages → rejgau → Settings → Variables and Secrets** and add:

| Name | Type | Value |
|---|---|---|
| `DISCORD_TOKEN` | Secret | the bot token |
| `GITHUB_APP_PRIVATE_KEY` | Secret | the entire `.pem` file contents, `-----BEGIN RSA PRIVATE KEY-----` through `-----END …-----` |
| `ADMIN_KEY` | Secret | a long random string, for the admin endpoints |
| `GITHUB_APP_ID` | Text | the App ID |
| `REJGAU_CONFIG` | Text | JSON, see below |

`wrangler.jsonc` sets `keep_vars`, so later `wrangler deploy`s don't erase the dashboard variables.

The cron trigger starts the Gateway session within 5 minutes. Or start it right away:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" https://rejgau.<your-subdomain>.workers.dev/start
```

### Configuration (`REJGAU_CONFIG`)

```json
{
  "guilds": {
    "1220095084427743312": {
      "repo": "owner/discord-archive",
      "branch": "archive",
      "path": "",
      "channels": ["<category or channel id>", "…"],
      "exclude": ["<channel id>"],
      "backfill": true,
      "pages": false,
      "privateThreads": false
    }
  },
  "flushIdleSeconds": 120,
  "flushMaxSeconds": 600,
  "maxMediaMegabytes": 100,
  "mediaUploadSpacingSeconds": 8
}
```

- **`channels`**: `"all"` (every channel the bot can see), or a list of channel and/or category IDs. A category covers its current and future channels. Threads and forum posts follow their parent. Either way, a channel the bot can't view is never selected or named in the archive: the bot works out its View Channel permission from its roles and the channel's permission overwrites, and re-checks when roles, channels or its own roles change (and over REST hourly). Denying the bot View Channel on a channel therefore keeps it out, **unless the bot has Administrator** (it then sees every channel; `/status` shows `administrator`), or another of its roles, or an overwrite for the bot itself, allows it.
- **`privateThreads`**: archive private threads the bot is in. Off by default, because anyone in a private thread can add the bot to it by mentioning it, which would publish the whole thread. (A bot with Manage Threads also sees every private thread.)
- **`exclude`**: IDs to skip. These take precedence, and apply to descendants too.
- **`backfill`**: when a channel becomes selected, fetch its whole history. Active threads are included; archived threads aren't yet.
- **`pages`**: after commits, send a `repository_dispatch` (`archive-updated`) to the archive repo, at most once per 10 minutes, so the Pages workflow republishes the reader.
- **`path`**: a folder inside the branch. `""` is the repo root.
- **`branch`**: defaults to `archive`. It's created if missing.
- **`flushIdleSeconds` / `flushMaxSeconds`**: commit after this long without new events, or at most this long after the first uncommitted one.
- **`maxMediaMegabytes`**: larger files are recorded as `MEDIA_FAILED` with `too_large`.
- **`mediaUploadSpacingSeconds`**: the minimum gap between release uploads, which keeps them under GitHub's limits for content creation.

Configuration values require the documented types. Boolean fields accept only `true` or `false`. Time intervals accept finite values from 0 through 86,400 seconds. `maxMediaMegabytes` accepts finite values from 0 through 2,048. Invalid configuration stops collection until an administrator fixes it.

Changing a variable redeploys the Worker. An enabled Gateway resumes its session, and the archive records selection changes. An explicit stop remains in effect. The bot ignores guilds outside the configuration.

## Admin endpoints

Every endpoint requires `Authorization: Bearer <ADMIN_KEY>`. Unauthorized requests return HTTP 404. Responses use `Cache-Control: no-store`.

A guild parameter must name a configured guild. Commands without a guild parameter apply to all configured guilds where the table permits that form.

| Endpoint | Effect |
| --- | --- |
| `GET /status[?guild=ID]` | Reports the connection, delivery queues, failed events, archive queues, blocked paths, and last errors. |
| `POST /start` | Enables the Gateway and clears its fatal error. |
| `POST /stop` | Disables the Gateway until an explicit start. Cron and pending connections respect this state. |
| `POST /flush[?guild=ID]` | Waits for active work and commits the events buffered at entry. HTTP 503 reports failure or an incomplete flush. |
| `POST /pause[?guild=ID]` | Stops background archive work and waits for active writes. Incoming events remain buffered. |
| `POST /resume[?guild=ID]` | Enables background archive work. |
| `POST /reset?guild=ID` | Deletes the stored state for one guild, then starts collection again. |
| `POST /retry-media[?guild=ID]` | Returns failed media items to the work queue. |
| `GET /dead-letters[?guild=ID][&after=N][&limit=N]` | Lists metadata for failed events. The default limit is 25 and the maximum is 100. |
| `POST /retry-dead-letter?guild=ID&id=N` | Returns one eligible failed event to its original place in the delivery queue. |

A dead letter is an event excluded from normal delivery. Temporary failures retry without a fixed attempt limit. New permanent failures block later events for that guild. Other guilds continue.

Older dead letters predate ordered recovery. The retry command refuses them because later events can already affect archive state. Their metadata remains available for manual recovery.

A flush response includes `committed`, `remaining`, and `complete` for each guild. It measures the events buffered when that flush starts. New events can remain after a complete flush. Blocked paths remain queued and appear in status.

If reset fails, the command returns HTTP 503 without restarting collection. Reset does not delete GitHub commits or media. Repeated backfill can therefore append duplicate records.

## Removing messages from the archive

Generated views omit deleted messages and earlier edits. Raw records and media retain those versions until an administrator removes them.

For a manual rewrite, use these steps:

1. Send `POST /pause?guild=ID` to the Worker and wait for success.
2. Send `POST /flush?guild=ID` and require `complete: true`.
3. Rewrite the archive branch and remove the matching release assets.
4. Rebuild the reader and Markdown logs from the rewritten archive.
5. Send `POST /resume?guild=ID` after the rewrite and rebuild succeed.

If the flush fails or remains incomplete, resolve its reported error before the rewrite. Paused guilds still collect incoming events. Explicit flushes can commit those buffered events while paused.

To remove a channel with `git filter-repo`, use `--path-glob 'raw/*/*/*/<channel id>.jsonl' --invert-paths`. Apply the same rule to each thread. Inspect `guild.jsonl` for channel references and shared media records.

The bot builds each commit on the current branch tip. It never force-pushes. Later edits or reactions can still add new records for a removed message.

Archive readers with local clones must update those clones after a rewrite. Old commits can remain accessible by commit ID until GitHub removes them. GitHub Support handles requests to purge those objects.

## Reader

`reader/` is a static, read-only, Discord-like viewer with search. `tools/build.ts` turns an archive's `raw/` into the data files it loads. See [docs/reader.md](docs/reader.md).

**Build locally** from a clone of the archive branch:

```sh
npm run build:site -- --archive ../my-archive --out site
npx serve site    # or any static file server
```

**Publish on GitHub Pages:**
1. Copy [`templates/pages.yml`](templates/pages.yml) to `.github/workflows/pages.yml` on the archive repo's **default branch**.
2. Set **Settings → Pages → Source** to *GitHub Actions*.
3. Set the repository variable `REJGAU_REF` to a full, reviewed commit ID from this repository.
4. Add `"pages": true` to the guild configuration so the bot requests publication after commits.

The workflow runs TypeScript and application tests before publication. Source CI also runs browser tests. Generated metadata records both source revisions.

The same workflow also publishes the [readable logs](#readable-logs) to the `logs` branch.

Builds reject malformed raw records by default. The reader data uses immutable generation paths, so an old page cannot combine data from separate builds. If its generation disappears, the reader requests a reload.

The builders track generated files with an ownership manifest. They preserve unrelated files and remove stale generated files. They stage output before publication and restore prior files after a caught promotion failure. See [the build rules](docs/reader.md) for input limits and recovery after an interrupted build.

A Pages site is **public even for a private repo**, except on GitHub Enterprise Cloud with access control. Media stored in a private repo's releases can't be displayed by the reader; it shows as links that signed-in viewers can open.

**Search** understands Discord's syntax:
- `from:`, `mentions:`: any name the user has had;
- `in:`: a channel name;
- `has:`: link, embed, file, image, video, sound, sticker, poll or forward;
- `before:`, `after:`, `during:`: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` in your local time zone, with before/after excluding the named day;
- `pinned:`, `authorType:`;
- `-` negation and `"phrases"`.

Anything else is case- and accent-insensitive text matching.

## Readable logs

`tools/logs.ts` renders the archive as Markdown that GitHub displays and that reads well in a pager:

```
README.md                          the server's channels
<channel>/README.md                the channel's days and threads
<channel>/2026/09/30.md            the channel's messages on Sep 30 (UTC)
<channel>/2026/09/30/<thread>.md   a thread's messages on Sep 30
```

Each message starts with a centred header line that links to itself (`…/30.md#m<message id>`). The Pages workflow regenerates the `logs` branch as a single commit whenever the archive changes; its history isn't kept, since the `archive` branch is the record. So removing something from the archive also removes it from the logs on the next run (replaced commits stay reachable by SHA until GitHub garbage-collects them, as with any rewrite). Set the repository variable `LOGS_BRANCH` to use another branch, or to `none` to turn this off.

To render locally: `npm run build:logs -- --archive ../my-archive --out logs`.

Rendering choices (GitHub strips styles, scripts, video and audio):
- user text is escaped, to keep it from injecting HTML or Markdown structure;
- deleted messages and earlier versions of edited ones aren't shown, here or in the reader; replies to a deleted message say so. They stay in `raw/`, which is public along with the rest of the repo (as are their media in the releases);
- spoilers fold the whole message into a `<details>` block;
- custom emoji show as `:name:`, and video, audio and voice messages as links;
- times are UTC.

## Development

```sh
npm test            # unit tests (Node) + integration tests in the Workers runtime (Miniflare)
npm run typecheck
```

The integration tests run the Durable Objects against in-memory fakes of the GitHub API, the Discord REST API and the Gateway (`test/worker/fakes.ts`).
