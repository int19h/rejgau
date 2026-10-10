# rejgau architecture

rejgau records selected Discord events in Git and stores their media in GitHub release assets.
A Cloudflare Worker collects events. Separate local tools generate a static reader and Markdown logs from the raw archive.

The raw archive retains message edits and deletion events. Generated views contain current, undeleted messages from selected channels.
The [reader design](reader.md) describes publication files, browser behavior, and local build limits. The [README](../README.md) contains deployment and operator commands.

## Components and state

A guild is a Discord server. Each configured guild has one `GuildArchive` Durable Object, which stores persistent state and buffered events.
One `GatewaySession` Durable Object manages the bot connection and routes events to those guild objects.

| Module | Responsibility |
| --- | --- |
| `src/index.ts`, `src/admin.ts` | Worker entry points, authenticated operator routes, scheduled recovery |
| `src/gateway.ts` | WebSocket connection, session recovery, heartbeats, delivery scheduling |
| `src/gateway-outbox.ts` | Durable event order, retries, quarantine, exact-event recovery |
| `src/discord.ts`, `src/discord-limits.ts` | Discord REST requests and shared retry deadlines |
| `src/archive.ts` | Channel selection, permission refresh, event handling, history recovery |
| `src/archive-lifecycle.ts` | Ordering for ingestion, background work, pause, and reset |
| `src/archive-storage.ts` | Archive tables, indexes, and bounded reads of pending events |
| `src/archive-committer.ts` | Bounded Git commits and blocked-file diagnostics |
| `src/archive-media.ts` | Durable media jobs and release inventory |
| `src/github.ts`, `src/http.ts` | GitHub requests, authentication, deadlines, and bounded body reads |
| `src/channels.ts`, `src/sanitize.ts` | Visibility decisions and removal of private fields |
| `tools/fold.ts`, `shared/publication.ts` | Current message state and generated data contracts |

Cloudflare stores delivery queues, permission state, history cursors, and pending uploads. GitHub stores committed raw records and uploaded media.
A database transaction connects each accepted Gateway sequence with its queued events. A restart can replay delivery, so consumers remove duplicate Gateway records.

## Gateway delivery and recovery

The outbox is a durable queue of undelivered events. Each guild preserves its own event order.
The delivery scheduler serves up to four guilds concurrently, with at most 100 events in one batch.
A slow guild does not block delivery to other guilds.

An archive response reports the accepted prefix and the first failure. The Gateway removes only accepted events.
Transient failures retain the remaining events and store an absolute retry deadline.
An explicit future deadline defers work without increasing the failure count.

Retries without a server deadline use increasing delays, from five seconds to five minutes.
Retryable failures do not become permanent losses after an arbitrary attempt count.
The earliest connection or delivery deadline determines the next alarm. Heartbeat handling does not wait for guild ingestion.

Quarantine is a blocked event kept for repair. A nonretryable failure moves the event into quarantine and blocks later delivery for that guild.
Other guilds continue. Operator routes list summaries without event payloads and retry one exact guild/event pair.

Recovery preserves the original event order. Only the earliest recoverable event for that guild can return to the outbox.
Legacy dead letters lack this guarantee because later events already advanced archive state. Automatic retry refuses those legacy records.

The Gateway persists its desired running state. An explicit stop survives scheduled recovery and object reconstruction.
An explicit start clears the stop and fatal connection state. Connection attempts carry an identity guard, so an obsolete attempt cannot reopen a stopped session.

Stop closes the Gateway connection and cancels a pending connection attempt. Already queued deliveries can still drain.
Pause controls archive background work separately. A stop therefore does not replace a pause during an archive rewrite.

The bot resumes a saved Discord session when possible. An invalid session causes a new connection and REST recovery for selected channels.
REST recovery finds later messages, but it cannot reconstruct every missed edit, deletion, or reaction.

## Discord access and request limits

Channel selection combines repository configuration with Discord permissions. A channel must match the selection and remain visible to the bot.
Category selections include their descendants. Threads follow their parent selection, and private threads require the explicit `privateThreads` setting.

The permission model uses the bot roles and channel overwrites. Administrator permission gives the bot access despite channel denies.
The archive waits for a known permission state before selecting channels. Permission changes trigger selection updates.

A complete guild snapshot marks absent non-thread channels as missing and unselects them.
A later channel event restores their presence before selection is reconsidered. Missing threads remain distinct because an active-thread list omits archived threads.

A cooldown is a required wait before another request. Discord REST callers share cooldown state in `GatewaySession` storage.
A bucket groups requests that share one limit. The coordinator records global deadlines, route deadlines, and server bucket identifiers.
Bucket keys retain the major guild or channel identity. A deadline extends existing state and never shortens a prior wait.
Expired cooldowns and unused bucket aliases leave storage through bounded periodic cleanup.

A `429` response supplies a future retry time to the caller. A successful response with no remaining requests also records its reset deadline.
History, member, permission, and attachment jobs persist these deferrals. They do not sleep inside a request until the deadline expires.

Gateway connection attempts have a 30-second timeout. The shared HTTP helper also gives Discord and GitHub operations a 30-second deadline.
The deadline includes response headers and body consumption. This bounds stalls while reading a media source or awaiting an upload response.

## Archive lifecycle

Ingestion and background work have separate ordered queues. Ingestion can keep recording events while background work waits on external services.
A reset uses an exclusive barrier that waits for both queues. This prevents old work from repopulating state after reset.

Pause persists the paused flag before it waits for active background work. Its response means that the existing background operation finished.
New Gateway events still enter the raw buffer while paused. Automatic history, member, media, dispatch, and commit work remain suspended.

An explicit flush waits for earlier background work. It captures a pending-event cutoff and processes bounded batches through that cutoff.
Its result reports `committed`, `remaining`, and `complete`. Newer arrivals do not make that result ambiguous.

A flush with remaining or blocked rows reports incomplete work. The HTTP route returns failure status instead of treating that result as a completed flush.
Repeated explicit flushes can continue a large drain. Status retains the reason for blocked paths.

Reset deletes the guild buffer, selection state, cursors, media jobs, and blocked-path records in one storage transaction.
It then clears in-memory state and completes normally. Reset does not delete the GitHub archive or release assets.
Starting again initializes selection and history recovery, so a reset can duplicate history that already exists in Git.

## Raw records and privacy

The raw format marker is separate from the reader format marker. Current raw archives use format 2.
The builders also accept the earlier daily raw-file layout. Dates and file partitions use UTC.

```text
archive.json
raw/YYYY/MM/DD/guild.jsonl
raw/YYYY/MM/DD/<channel-id>.jsonl
```

Each JSONL file contains one JSON record per line. A record carries `at`, `src`, `t`, and `d`.
Gateway records also carry a public session identifier and a sequence number. Public session identifiers replace the actual Discord session identifier.

`src` distinguishes Gateway events, REST snapshots, and synthetic archive records. REST messages retain their fetch time in `at`.
Their file location follows message creation time. Synthetic records include selection changes, guild snapshots, recovery markers, and media results.

The bot appends sanitized payloads instead of copying every Discord field. It removes moderation state, permission lists, safety-scanner data, and app-internal identifiers.
Guild snapshots omit unselected channel inventories and unrelated membership data. Private account flags differ from public display flags.

The sanitizer uses event and field context for user and member objects. Partial members and members with null join dates receive the same privacy treatment.
It also removes thread-member notification flags. Message, channel, attachment, and embed flags retain their display meaning.

The fold applies the current sanitizer when it reads older raw records. This protects newly generated views without rewriting historical raw files.
Existing public Git history still contains its original records. Removing data from that history remains a separate operator action.

## Git commits and bounded work

The committer reads the current branch tip before it appends data. It creates a new tree and commit, then updates the branch without force.
A conflicting branch update causes another attempt against the newer tip. The writer never assumes that its previous commit remains an ancestor.

Pending rows enter a batch through an iterator. The batch contains at most 4 MiB of encoded lines and 40 paths.
The complete commit has an 8 MiB budget, with 4 KiB reserved for metadata.
Existing file content counts toward that budget.

An oversized pending line or remote file stays queued. The committer records its path, reason, and next retry time in `blocked_paths`.
Other paths can continue. A blocked path waits 15 minutes before another automatic attempt.

The limits bound payload bytes, not total JavaScript heap use. Parsed strings, maps, and request objects also consume memory.
A large historical day file therefore requires operator attention instead of unlimited allocation. The raw file format does not change automatically.

Only rows included in a successful commit leave the queue. A failed GitHub request preserves those rows and records a retry deadline.
Default scheduling commits after two idle minutes or ten minutes from the first pending event. Configuration can change both intervals.

## Media jobs and releases

Media upload is separate from raw-event delivery. The alarm processes due commits before optional external work and reconsiders commits before media work.
One media job runs at a time for a guild. A stalled source therefore has a deadline and cannot hold raw delivery indefinitely.

Media keys come from attachment IDs, avatar hashes, emoji IDs, or a stable URL hash. `src/media.ts` defines the same keys for collection and rendering.
Successful and failed uploads become raw `MEDIA_STORED` and `MEDIA_FAILED` records. The latest record for a key determines its generated media entry.

A trustworthy content length permits streaming. Unknown or encoded lengths require a bounded buffer.
The configured media limit applies in both cases. The unknown-length buffer also has a 32 MiB cap.

An expired attachment URL triggers a fresh message lookup. A transient lookup failure remains retryable instead of becoming a permanent missing file.
A confirmed inaccessible or missing message ends that attempt as a media failure. Failed media can return to the queue through the operator route.

Release caches include the configured repository identity. The uploader reads the current release inventory before choosing an asset or upload target.
An existing complete asset is reused. An incomplete upload can be removed before retry.

Release names follow `media-YYYY-MM`, then numbered continuations. Their tags point at a parentless media-root commit.
These tags therefore do not retain old archive history after a branch rewrite. The default upload spacing is eight seconds.

## Publication and operator boundaries

The raw archive is the source for both generated outputs. Publication never depends on a range of recent commits.
The fold supplies one deletion resolver to the site and Markdown logs. Both outputs apply current selection and deletion rules.

A deletion tombstone records a deleted message ID independently of message content. It suppresses delayed snapshots and deleted originals embedded in replies.
Forwarded snapshots retain their intentional copied content. Publication does not erase a forward solely because its original message later disappears.

The shared publication contract describes generated JSON and makes sure that consumed fields have supported shapes at runtime.
The reader and generator import the same types. The raw Discord boundary remains separate because its payload fields can evolve.

The builder stages a complete output before promotion. It tracks owned files, removes obsolete generated paths, and refuses unowned-file collisions.
The [reader design](reader.md) describes generation directories, recovery journals, and filesystem limits.

Publishing a source commit does not prove that a Worker or reader uses it. Worker deployments and the archive repository renderer pin are separate choices.
Generated provenance records the available source revisions and raw digest. The Pages workflow publishes that completed artifact.

Tests use synthetic Discord, Gateway, and GitHub services. They cover persisted retries, lifecycle races, stalled responses, bounded batches, visibility changes, and publication privacy.
Browser tests cover asynchronous navigation, search failures, mobile navigation, generation replacement, and resource limits.
These tests do not prove that Discord delivered every event during an outage.
