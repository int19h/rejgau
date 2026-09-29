# rejgau feasibility spike

A throwaway Worker and Durable Object. It answers these questions from real Cloudflare egress, which is what matters: requests from a laptop or CI take a different network path.

1. Can a Durable Object open and hold the Discord Gateway WebSocket? Historically this failed with a 401.
2. Can a Worker fetch Discord CDN media? Discord's docs say attachments return 403 to Workers.
3. What do other apps' slash-command responses look like to us? This covers `interaction.name` and `interaction_metadata`.
4. How often does a long-lived Durable Object get restarted?

## Deploy

```sh
npm install
npx wrangler login              # or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put SPIKE_KEY       # any random string; every route requires ?key=<it>
npx wrangler secret put DISCORD_TOKEN   # only for the /gateway/start test
npx wrangler deploy
```

## Tests

`BASE=https://rejgau-spike.<subdomain>.workers.dev` and `K=?key=<SPIKE_KEY>`.

| Route | What it tells us |
|---|---|
| `GET $BASE/gateway/handshake$K` | Needs no token. `ok: true, stage: "heartbeat-ack"` means the Gateway accepts Workers. A 401 at `stage: "upgrade"` means it doesn't. |
| `GET $BASE/cdn$K[&url=...]` | CDN reachability. Expected results off Cloudflare: avatar `200`, fake attachment `404 "This content is no longer available."`. A `403` means Workers are blocked. Pass a real attachment URL with `&url=`. |
| `POST $BASE/gateway/start$K` | Identifies with the bot token and keeps the session alive. Heartbeats run on DO alarms, and resume happens after eviction. |
| `GET $BASE/gateway/status$K` | Counters: `boots` (DO restarts), `reconnects`, `resumes`, `zombies`, `closes`, `lastClose`, `lastConnectError`, plus per-event-type counts. |
| `GET $BASE/gateway/events$K&t=MESSAGE_CREATE&limit=20` | Recent raw dispatches. Look at type 20/23 messages for `interaction` / `interaction_metadata`. |
| `GET $BASE/gateway/probes$K` | CDN fetch results for every attachment, embed image, avatar, emoji and sticker seen in messages. |
| `POST $BASE/gateway/stop$K` | Closes the session and stops the alarms. |

To test from a Discord server:
1. Invite the test bot with `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=66560&integration_type=0`.
2. Enable the **Message Content** intent in the Developer Portal.
3. Post a few messages with images, stickers and custom emoji.
4. Run a slash command from another bot, then a user-installed app's command.

Delete the Worker afterwards with `npx wrangler delete`.
