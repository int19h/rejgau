# rejgau

rejgau archives Discord channels into a git repository. A Cloudflare Worker keeps a Gateway connection open, records every event in the selected channels verbatim as JSONL, stores attachments and other media as GitHub release assets, and commits the logs to a branch of your archive repo every few minutes.

The archive is meant to outlive whoever runs the bot. All data ends up in the GitHub repo; Cloudflare only buffers it.

Status: the bot (phase 1) and the static reader with search (phase 2) are both implemented. See [docs/design.md](docs/design.md) for the design and the reasoning behind it.

## What ends up in the repo

On the archive branch (default `archive`), under the configured folder:

```
archive.json            format marker: {"format": 1, "guild_id": …}
raw/YYYY/MM/DD.jsonl    one JSON object per line, UTC days
```

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
npm install
npx wrangler deploy
```

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
      "pages": false
    }
  },
  "flushIdleSeconds": 120,
  "flushMaxSeconds": 600,
  "maxMediaMegabytes": 100,
  "mediaUploadSpacingSeconds": 8
}
```

- **`channels`**: `"all"` (every channel the bot can see), or a list of channel and/or category IDs. A category covers its current and future channels. Threads and forum posts follow their parent.
- **`exclude`**: IDs to skip. These take precedence, and apply to descendants too.
- **`backfill`**: when a channel becomes selected, fetch its whole history. Active threads are included; archived threads aren't yet.
- **`pages`**: after commits, send a `repository_dispatch` (`archive-updated`) to the archive repo, at most once per 10 minutes, so the Pages workflow republishes the reader.
- **`path`**: a folder inside the branch. `""` is the repo root.
- **`branch`**: defaults to `archive`. It's created if missing.
- **`flushIdleSeconds` / `flushMaxSeconds`**: commit after this long without new events, or at most this long after the first uncommitted one.
- **`maxMediaMegabytes`**: larger files are recorded as `MEDIA_FAILED` with `too_large`.
- **`mediaUploadSpacingSeconds`**: the minimum gap between release uploads, which keeps them under GitHub's limits for content creation.

Changing a variable redeploys the Worker. The Gateway session simply resumes, and selection changes are recorded in the log. Guilds the bot is in but that aren't configured are ignored.

## Admin endpoints

Every endpoint requires `Authorization: Bearer <ADMIN_KEY>`. Unauthorized requests get a 404.

| Endpoint | Effect |
|---|---|
| `GET /status` | Gateway state (including `deadLetters`: events that failed 10 times and were set aside), plus per-guild buffered lines, media queue, last commit, last error and any GitHub rate-limit backoff. |
| `POST /start`, `POST /stop` | Start the Gateway session (also clears a fatal error, e.g. after fixing the token), or stop it. |
| `POST /flush[?guild=ID]` | Commit everything buffered now. |
| `POST /pause[?guild=ID]`, `POST /resume[?guild=ID]` | Stop or restart committing. Events keep being buffered meanwhile. |
| `POST /reset?guild=ID` | Wipe the bot's state for a guild, so the next event bootstraps and backfills again. For test setups: delete the archive branch first, or the backfill appends duplicates. |
| `POST /retry-media[?guild=ID]` | Re-queue media recorded as failed, e.g. after fixing the GitHub setup. When a key has several `MEDIA_*` records, the last one wins. |

## Removing messages from the archive

Deletion is manual, by the archive admin:
1. `POST /pause`, then `POST /flush`, in that order, so nothing is in flight and nothing new gets committed.
2. Rewrite the `archive` branch however you like (e.g. `git filter-repo`), and force-push.
3. Delete the matching release assets.
4. `POST /resume`.

The bot always builds its next commit on the current branch tip and never force-pushes, so your rewrite stands. It doesn't re-fetch history it has already archived, but later events about a removed message (an edit or a reaction) are still logged as they happen.

Anyone with a clone of the archive must `git fetch --force` / reset after a rewrite. Old commits can stay reachable on GitHub by SHA until GitHub garbage-collects them; GitHub Support can purge them.

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
3. Add `"pages": true` to the guild's config so the bot triggers a rebuild after commits. An hourly schedule also covers it.

A Pages site is **public even for a private repo**, except on GitHub Enterprise Cloud with access control. Media stored in a private repo's releases can't be displayed by the reader; it shows as links that signed-in viewers can open.

**Search** understands Discord's syntax:
- `from:`, `mentions:`: any name the user has had;
- `in:`: a channel name;
- `has:`: link, embed, file, image, video, sound, sticker, poll or forward;
- `before:`, `after:`, `during:`: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` in your local time zone, with before/after excluding the named day;
- `pinned:`, `authorType:`;
- `-` negation and `"phrases"`.

Anything else is case- and accent-insensitive text matching.

## Development

```sh
npm test            # unit tests (Node) + integration tests in the Workers runtime (Miniflare)
npm run typecheck
```

The integration tests run the Durable Objects against in-memory fakes of the GitHub API, the Discord REST API and the Gateway (`test/worker/fakes.ts`).
