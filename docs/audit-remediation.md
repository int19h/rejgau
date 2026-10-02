# Audit repair and release guide

This change repairs the code findings from the [October 2 audit](audit-2026-10-02.md). It also changes the boundaries between collection, storage, publication, and rendering. Production updates require a separate release decision.

## Repair coverage

The table connects each reported defect to its repair. Tests exercise the failure conditions with local data and fake external services. The pull request retains the issue links until merge.

| Findings | Issues | Repair |
| --- | --- | --- |
| G1, G2, G3 | #5, #15, #16 | Persist retry deadlines and stop state. Preserve complete Discord delays and coordinate limits across guilds. |
| A1, A2 | #7, #8 | Bound external requests and body reads. Retry temporary failures during attachment refresh. |
| A3 | #9 | Wait for active writes during pause. Return HTTP 503 for failed or incomplete flushes. |
| A4 | #10 | Read pending rows within byte and path limits. Retain oversized work with a visible error. |
| A5 | #11 | Scope release caches by repository and reconcile assets with GitHub. |
| B1, B2, B3, B4 | #12, #13, #14, #25 | Remove stale generated files, allocate unique log paths, reject unsafe paths, and decode filesystem URLs. |
| R1, R2, R3 | #6, #17, #18 | Retain deletion records, merge partial updates, and replace complete poll tallies. |
| R4, R5 | #19, #20 | Cancel obsolete navigation and report incomplete searches with a retry action. |
| R6, S1 | #21, #24 | Limit exported profiles to visible messages and remove private member fields by context. |
| R7, R8, R9 | #22, #26, #23 | Restore mobile navigation, explain missing months, and preserve sender identities in grouped messages. |

## Architecture changes

The Gateway stores each guild delivery order separately. Temporary failures retain their retry deadlines across object restarts. New permanent failures block only that guild until an administrator retries the failed event.

Older failed events remain visible but cannot replay automatically. Their later events can already affect archive state. Automatic replay can therefore discard old records or reverse later decisions.

Archive lifecycle, media work, storage selection, and commits use separate modules. A lifecycle barrier waits until earlier operations finish. Pause and reset use that barrier before they return success.

Due archive commits run before optional media work. HTTP deadlines cover headers, body reads, and uploads. Pending work queries use indexes, and oversized archive paths remain queued with a status message.

The publication module defines shared reader types and runtime parsers. Both output formats use common visibility and reply rules. The fold reapplies current privacy rules to old raw records.

A generation is a set of immutable publication files. Reader requests stay within one generation. A removed generation produces a reload state, so the reader cannot mix old and new data.

The builders reject malformed input by default and bound input size. They stage generated files before they change the output directory. An ownership manifest identifies files that a later build can replace or remove.

Reader requests use cancellation and route identity. Completed data uses a bounded cache, and message pages contain at most 200 messages. Search keeps at most 1,000 compact results and states when that limit stops the search.

Source CI runs TypeScript, unit tests, Worker tests, browser tests, and a local Worker bundle. The Pages template requires an exact renderer commit and runs application tests before publication. Generated metadata records the archive and renderer revisions.

## Release preparation

Use a clean checkout of the exact reviewed commit. The deployment wrapper records that commit on the Worker version. A dry run creates a local bundle without a production update.

Before a production release, run these commands from the source checkout:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
npm run deploy -- --dry-run --outdir /tmp/rejgau-release-worker
```

For the reader, clone the intended archive revision into a separate local directory. Build both output formats from that directory. Make sure that `data/archive.json` names the expected revisions and generation.

```sh
npm run build:site -- --archive ../archive-copy --out ../site-review
npm run build:logs -- --archive ../archive-copy --out ../logs-review
```

Before approval, record these release values:

1. Record the full reviewed renderer commit ID and Worker bundle hash.
2. Record the archive commit ID used for the local build.
3. Record the current Worker version and current `REJGAU_REF` value.
4. Record the generated manifest and bundle hashes.
5. Record the tests and the independent source review result.

After release approval, use `npm run deploy` from the reviewed clean checkout. Copy the reviewed Pages template to the archive repository. Set `REJGAU_REF` to the reviewed commit ID through the approved publication process.

Changing `REJGAU_REF` affects the next scheduled publication. Treat that change as a deployment. Make sure that the live manifest names the approved revisions after publication.

## Production decisions and limits

The audit observed Worker version `c700d64f-bbe8-4a91-bf75-bcdabe5665e0`. It observed reader pin `ac3c2460f7d39ef9e51b09b3bfb2e35df78f65e4`. These are historical recovery references from October 2, 2026, and require a fresh read before release.

The new SQLite schema adds tables, indexes, and fields without deleting archived records. Reset remains an explicit destructive administrator command. A downgrade can discard the new scheduling behavior even when older code accepts the stored schema.

Do not use a downgrade as the default recovery procedure. Older Worker code can restart a stopped connection or bypass the new quarantine order. Pause collection and assess stored state before an approved downgrade.

The source now states the intended logging behavior. The audit could not read stored Worker logs because Cloudflare rejected the available credential. Resolving that access gap requires an account permission decision.

The archive repository lacks branch and environment protection rules. Those rules affect who can publish and how the bot writes. They require a policy decision, so this code change does not impose them.

The build still folds a bounded input set in memory. Large archives can exceed that limit and require partitioned processing. Large per-day archive files can also block appends until an administrator splits them.

Raw archive records and media retain deleted content by design. Generated-view filtering does not remove old commits, clones, caches, or release assets. Complete removal still requires the manual rewrite procedure in the README.
