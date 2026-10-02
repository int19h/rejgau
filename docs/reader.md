# Publication and reader design

The publication tools turn the raw archive into current message views. They generate a static website and Markdown logs without changing raw records.
The browser reads generated JSON and never connects to Discord. [System architecture](design.md) describes collection, durable storage, and recovery.

## Build boundaries

`tools/raw.ts` reads and inspects archive records. `tools/fold.ts` combines those records into current state.
`tools/sitedata.ts` produces reader data, and `tools/logs.ts` produces Markdown. `tools/bundle.ts` builds the browser assets.

The raw reader rejects malformed JSON, invalid event envelopes, unsafe identifiers, and unsupported shapes in consumed message fields.
Record errors identify the file and line. Raw file candidates must be regular files.
Symbolic links, invalid UTF-8, and files that change during the read are rejected.

Default input limits are explicit:

| Resource | Default limit | Command flag |
| --- | --- | --- |
| Total raw bytes | 64 MiB | `--max-raw-bytes` |
| Nonempty records | 250,000 | `--max-records` |
| One raw line | 4 MiB | `--max-line-bytes` |
| Directory entries | 20,000 | `--max-files` |
| Directory depth | 16 | `--max-depth` |

These bounds limit input, not peak heap use. The build still retains parsed records, folded state, and derived output.
Large archives require deliberate partitioning or changed limits. The builder does not claim constant memory use.

Strict parsing is the default. The explicit `--skip-bad-lines` mode supports forensic builds.
If that mode skips records, provenance marks the build incomplete. The builder also records diagnostic messages. Resource limits and unsafe filesystem paths still stop the build.

`shared/publication.ts` defines the generated JSON model. The generator and browser use its runtime parsers as well as its TypeScript types.
The parsers reject malformed consumed fields and unsupported format versions. Unknown Discord extension fields remain separate from fields the reader uses.

## Folding records

The fold sorts records by `at` and preserves file order when timestamps match. Guild files precede channel files within the same day.
Gateway records with the same public session identifier and sequence number are duplicates. Repeated REST snapshots merge by message ID.

Only supplied message fields replace existing fields. A newer edit timestamp records an earlier version internally, while an older complete snapshot cannot replace current content.
A partial Gateway update without an edit timestamp still updates supplied fields. It preserves the existing edit timestamp.

Deletion tombstones retain deleted IDs even when no standalone message exists. They apply to single deletions, bulk deletions, delayed REST snapshots, and reply previews.
A deleted message cannot reappear through a later snapshot. Deleted originals produce a deletion marker instead of a reply excerpt.

The outputs omit deleted messages and prior edit versions. Raw records continue to retain those facts.
A forwarded snapshot remains an intentional copy. Its content does not follow later deletion of the original message.

Reaction counts combine an unknown-user baseline with known live reactors. Add and remove events update that state without counting one known user twice.
A snapshot can reset inconsistent counts. Normal and burst reactions remain separate.

Poll counts use the same baseline and known-user model. A present `answer_counts` array replaces the complete count set.
An omitted answer in that array has zero votes. An absent results object leaves previous knowledge intact.

Current selection controls publication. Unselected channels produce no message files, and their messages do not enter search.
Threads also require a selected parent. Selected channel ancestors supply the navigation tree.

Profiles come from visible current messages and their visible references. Reactor profiles retain their source message identity.
Only known reactors and voters still used by published messages add those profiles to `users.json`.
A profile seen only on hidden or deleted messages stays outside the global user table.
The same rule applies after its last visible reaction or vote disappears.

Both output generators use the same deletion resolver. Markdown names also derive from visible messages and current reaction or vote use.
Neither output publishes the full historical profile collection. Media maps contain only referenced media keys.

## Generated files

A generation is one complete set of generated files. A digest is an identifier computed from content.
The site manifest identifies its generation through a digest and an exact relative path.
The digest depends on content and renderer inputs, instead of the time of the build.

```text
index.html
reader-<digest>.js
reader-<digest>.css
data/archive.json
data/generations/<generation>/users.json
data/generations/<generation>/c/<channel-id>/<YYYY-MM>.json
data/generations/<generation>/search/<YYYY-MM>.json
```

The manifest retains reader format 1. Optional `generation` and `data_root` fields must agree exactly.
A legacy format-1 manifest without those fields remains readable. Legacy data requests use the build timestamp as a cache key.

The manifest contains guild metadata, the channel tree, message counts by month, and the available search months.
Its optional provenance identifies renderer and archive revisions when available.
The `--renderer-revision` and `--archive-revision` flags can supply those full commit IDs explicitly. It also records the raw digest, byte count, accepted records, and skipped records.
An incomplete build states that fact explicitly.

Each channel-month file contains messages, user snapshots, and a local media map. Messages refer to deduplicated snapshot keys within that file.
The snapshot preserves the displayed author identity for that message. Month partitioning follows message creation time in UTC.

`users.json` supplies visible profile names for search and reaction or voter labels. Search files contain compact rows, normalized searchable text, and short excerpts.
A search row points back to its channel and message. Search files contain current content from messages, supported embeds, components, attachments, polls, and forwards.

Generated JSON files must fit the reader response limit of 32 MiB. The build rejects larger files instead of publishing files the reader cannot load.
This limit does not split a large month automatically. Source and output size diagnostics identify the necessary operator work.

## Output promotion and recovery

`tools/output.ts` stages generated files beside the destination. A local journal, a recovery record, tracks promotion and rollback work.
The `.rejgau-output.json` ownership file records generated paths and their content hashes. The builder preserves unrelated files and refuses changed or unowned collisions.

An old output directory requires explicit `--adopt-existing` before the builder claims recognized legacy files.
Adoption uses known paths and content markers. It does not claim arbitrary neighboring files or version-control metadata.

New generation files arrive before the manifest that references them. Obsolete owned files and old generations leave the output during promotion.
This removal keeps deleted content out of stale generated directories. A browser that requests a removed generation must reload the archive.

Each file rename changes one directory entry in one operation. The full directory replacement requires several filesystem operations.
Caught failures restore prior owned files. A later build can recover an interrupted journal after the recorded process exits.

The publisher limits generated inventory to 100,000 entries and 512 MiB. It rejects symbolic links and paths outside the reserved output tree.
Metadata files also have bounded reads. A lock prevents concurrent builders from promoting into the same destination.

These safeguards support a trusted local checkout. They do not provide a database transaction for concurrent readers or a hostile local filesystem writer.
A completed site directory is the deployment artifact. Uploading that artifact remains separate from constructing it.

## Browser data loading

`reader/src/data.ts` fetches data and applies the shared runtime parsers. A request has a 30-second deadline and a 32 MiB decoded-body limit.
Month responses must identify the requested channel and month. Malformed data produces a visible error instead of an unchecked render.

The reader revalidates `data/archive.json` when it loads the archive. All child requests remain bound to that manifest generation.
A missing generation file produces a reload action. The reader never falls back from a missing generation to mutable legacy paths.

Completed month and search responses share a bounded cache. It keeps at most 12 entries and 16 MiB of encoded response bytes.
It evicts the least recently used entries. Oversized entries remain usable for the current request but do not enter the cache.

These cache limits do not equal JavaScript heap limits. Parsed objects and the active view also consume memory.
The application retains its manifest and global users in page state. Search results retain compact display data instead of full search rows.

## Navigation and rendering

Hash routes select a channel, month, message, or query:

- `#/c/<channel>` opens the latest month.
- `#/c/<channel>/<YYYY-MM>` opens an explicit month.
- `#/c/<channel>/<YYYY-MM>/<message-id>` selects the containing message page.
- `#/search?q=<query>` opens search results.

A changed route aborts the old request and invalidates its callbacks. A late success or failure cannot replace the new route.
The reader gives distinct finished states for absent channels, absent months, and empty channels. Month navigation offers available neighboring months.

`reader/src/channel.tsx` renders at most 200 messages per page. An implicit latest route starts on the final page.
An explicit month starts on the first page. A message link selects its page and scrolls to the message.

`reader/src/sidebar.tsx` provides the channel tree. On narrow screens, the Channels button opens an accessible menu.
Opening the menu focuses its first link. Escape closes it and restores focus, and selecting a channel closes it.

Message grouping requires the same displayed author identity. Webhook username or avatar changes therefore retain separate headers.
The reader supports replies, forwards, media, embeds, components, stickers, reactions, polls, and system messages.
An edited marker remains, but there is no unpublished edit-history interface.

Reaction and poll labels use known visible profiles. Unknown voters retain an ID label instead of a fabricated name.
Avatar placeholders are local. Color themes follow the system preference.

## Search behavior

Search supports `from:`, `mentions:`, `in:`, `has:`, `before:`, `after:`, `during:`, `pinned:`, and `authorType:`.
Quoted phrases and negation combine with plain text. Unknown filter names remain plain text.
Matching ignores case and diacritics.

Name filters use names retained in the published profile table. Date filters use the viewer time zone.
Month selection widens the date bounds to avoid losing matches near timezone boundaries. Deleted content and earlier edits never enter the generated index.

`reader/src/search-view.tsx` scans month files from newest to oldest. It initially returns 200 matches and supports additional groups of 200.
Search stops after 1,000 matches and asks for a narrower query. The reader does not retain an unbounded result list.

A failed month leaves earlier hits visible and marks the result incomplete. Try again resumes at the failed position.
A zero-result failure therefore remains distinct from a completed search with no matches.
Changing the query cancels old work and prevents stale errors from replacing the new search.

## Content safety and deployment

The browser treats archived content as untrusted. Preact escapes text, and links accept only HTTP or HTTPS destinations.
Highlighted code is the only generated HTML inserted directly. Markdown rendering does not accept arbitrary HTML from messages.

Media resolves through archived media keys. The reader does not hotlink arbitrary message images or Discord avatars.
The Content Security Policy restricts scripts to the site and media to approved GitHub origins. The referrer policy sends no referrer.

The Pages workflow lives on the archive repository default branch. It handles archive dispatches, scheduled publication, and manual runs.
`REJGAU_REF` selects the renderer revision. A source merge alone does not update a pinned deployment.

The dependency build has read-only repository access. Separate jobs receive Pages deployment rights or logs-branch write rights.
Actions use pinned revisions, package installation disables lifecycle scripts, and checkouts do not retain credentials.
The logs job refuses to replace the archive branch or default branch.

The Markdown output records provenance in `build-info.json` and uses one replaceable logs branch. Its generated names receive collision handling so different channels cannot overwrite each other.
Media remains in GitHub release assets. Repository visibility and Pages access still require an explicit deployment decision.

## Tests and remaining limits

Unit tests cover ordering, edits, tombstones, reply privacy, poll counts, profile scope, shared contracts, and malformed data.
Build tests cover strict input, path safety, collisions, stale files, promotion failure, and interrupted-build recovery.
Browser tests cover request races, retry states, mobile navigation, pagination, author identity, cache limits, and missing generations.

The reader does not provide message editing, arbitrary remote archive loading, or historical edit browsing.
Archive collection does not discover every archived thread or reconstruct every event lost outside a resumable session.
The documented byte and count limits bound supported work. They are not evidence of tested performance for every archive at those limits.
