# Waiting on you: event replay, refresh pacing and retention

All changes are uncommitted. No SER connection, deploy.local request, real data directory, Chromium, Electron, Xcode app build or simulator was used. Tests used temporary databases/caches. The two APNs test HTTP servers used loopback ports 5180 and 5181 with `DEPLOY_MDNS_ADDRESS=127.0.0.1`.

## Logical changes for review

1. **Inbox ordering (server, iPhone, web).** The existing waiting and answered responses now include their cursor, read in the same SQLite transaction as the list. Clients retain separate list boundaries and item versions, so a snapshot's absent withdrawn items cannot be resurrected by old waiting events. Later events may reopen the same ID, including with the same creation date. An answer returned ahead of the event stream retains timestamp protection. Legacy servers without cursors retain a conservative resolved-item guard; authoritative absence protection requires the updated server. Files: `server/v2/api.ts`, `shared/v2/api.ts`, native `V2Client.swift`, `V2InboxPosition.swift`, the snapshot/apply/refresh portions of `V2Store.swift`, web `inbox-store.ts`, and regression tests.
2. **Health notifications.** `server/v2/live.ts` always saves changed health records, but compares reactive fields before emitting. Only heartbeat timestamps and the numeric age in the existing healthy worker heartbeat summary are ignored. State, other summaries, HTTP/job/queue/restart values and any additional fields still emit. The stored summary/copy is unchanged.
3. **Client idle work.** iPhone irrelevant pages advance the in-memory cursor without full refresh or cache rewrite. Relevant inbox, agent, conversation, release and rollback changes retain paced full refreshes. Health events request only Live/computers; a 15-second fallback also notices computer changes without events. Long polls shorten to meet both deadlines. Web pages without inbox events do not publish or replace the array. Files: pacing/event portions of `V2Store.swift`, `V2RefreshPacingTests.swift`, and web inbox store/tests. `V2Store.swift` was not reformatted.
4. **Health event retention.** Maintenance starts a pass every minute, prevents overlap, scans/deletes at most 250 rows per transaction and yields 10 ms between batches. It keeps one hour of health events plus every owner's current head, preserving owner head monotonicity, AUTOINCREMENT and old-client cursors. Other event kinds are retained. Lock contention waits at most 25 ms before retrying on the next maintenance tick. No new index build or VACUUM. Files: `server/workspace/health-event-retention.*`, `server/maintenance.ts`, `server/v2/events.test.ts`, benchmark script.

## Consumer trace

- Web `live/data.ts`: health events trigger snapshots; an existing 15-second timer reads overview and open detail. `live/page.client.tsx` renders heartbeat age and a 90-second freshness indicator. Those reads remain in place, so timestamp-only event suppression does not freeze the indicator. Project app views read health through their existing resource requests.
- iPhone `V2Store.swift`: health formerly triggered every full refresh. Live, projects and release views consume `snapshot.live`; the new light path refreshes it and computers at most 15 seconds apart while connected. `V2WorkerView` in `V2Places.swift` already reads detail once on sheet opening and prefers that detail over the snapshot. Its pre-existing one-shot detail behavior is unchanged; no sheet/UI changes were added.
- Edge `server/edge/app-state.ts`: reads `v2-health` records from SQLite on its one-second snapshot cadence. It does not consume health events or heartbeat age, and authoritative stopped/rollback routing remains unchanged.
- APNs `server/v2/push.ts`: consumes transitions into failing and persists per-app state. Health state transitions still emit. Its consumer/acknowledgement tests pass.

## Before and after

| Measurement                                                      | Before                                                                               | After                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 13 unchanged apps reporting every 16 seconds                     | 195 continuing health events / 4 minutes = **48.75/minute**                          | **0/minute**, after the initial 13 app events; real field changes still emit             |
| Phone, empty ten-second long polls                               | **6 full refreshes/minute**, ignoring request duration (computed from original loop) | **0 full refreshes/minute**; **4 light Live/computer reads/minute**                      |
| Phone, continuously arriving irrelevant pages                    | **30 full refreshes/minute** in the 60-second pacer regression                       | **0 full**, **4 light** in the same test                                                 |
| Snapshot answered/withdrawn truth followed by old waiting replay | Answer replaced; withdrawn item resurrected                                          | Answer retained; old waiting absent; genuinely new/reopened waiting accepted immediately |
| Web empty/health-only pages                                      | Two publications; new arrays                                                         | Zero publications; same snapshot reference                                               |

These are synthetic tests and pacer calculations, not new measurements from SER's feed. Real request duration and report phasing affect refresh frequency. Freshness still depends on successful periodic requests and the existing server Live cache (15 seconds).

## First-prune measurement

Run from the repository root:

```sh
node scripts/benchmark-health-retention.mjs
```

The script imports only the retention helper, creates a temporary SQLite database with the production event schema/indexes, seeds 600,000 health rows across 13 apps, checkpoints the seed WAL, measures the first full retention pass and deletes the directory. No server is started.

| Measurement                     | Result                        |
| ------------------------------- | ----------------------------- |
| Seed database                   | 387,870,720 bytes (387.87 MB) |
| Rows deleted / retained         | 599,999 / 1 (owner head)      |
| Batches                         | 2,400                         |
| First batch                     | 0.60 ms                       |
| Worst synchronous batch         | **11.02 ms**                  |
| Worst event-loop delay          | **12.30 ms**                  |
| Total elapsed, including yields | 26.28 seconds                 |
| SQLite integrity check          | `ok`                          |

This was a local uncontended temporary database measurement, not a bound on SER disk or lock contention. Deleted space is reusable; the file is not compacted.

## Regression failures confirmed before fixes

The original behavior was run first, or temporarily restored and then restored to the fix. All of these now pass:

| Test                                                                                                   | Before result                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `snapshotRejectsReplayedWaitingAndWithdrawnHistoryButAllowsNewWaiting`                                 | Failed five expectations: answered truth lost, withdrawn waiting resurfaced, wrong waiting membership/count                                                                                                                                      |
| `irrelevantAndEmptyPagesNeverRequestFullRefreshButLiveRemainsFresh`                                    | Failed: 30 full refreshes instead of 0; 0 light reads instead of 4                                                                                                                                                                               |
| `healthUsesTheLightReadAndNewTasksStillRefreshImmediatelyAfterIdle`                                    | Failed two pacing expectations with the original unconditional pending flag                                                                                                                                                                      |
| `irrelevantPagesAdvanceInMemoryWithoutRewritingCache`                                                  | Failed: both cache bytes and modification date changed                                                                                                                                                                                           |
| `heartbeat-only reports save fresh records without emitting health; rendered fields still emit`        | Failed: event count 2 instead of 1                                                                                                                                                                                                               |
| `irrelevant pages do not publish; cursor ordering permits reopening and rejects older terminal states` | Failed: publication count 3 instead of 1. With only empty-publication suppression applied, failed again: withdrawn stayed answered. Final batch assertion also failed before batching: two publications instead of one for a two-item inbox page |
| `inbox list responses carry their authoritative event cursor, including withdrawn absence`             | Failed: response cursor undefined instead of authoritative cursor                                                                                                                                                                                |
| `13 steady apps generate no continuing heartbeat notifications over four minutes`                      | Failed: 195 continuing events instead of 0                                                                                                                                                                                                       |
| `retention bounds every scan, keeps recent health, other history and owner heads`                      | Failed with deletion disabled: 0 deleted instead of 250 in the first batch                                                                                                                                                                       |

## Final checks actually run

- `pnpm run typecheck`: exit 0.
- `pnpm exec oxfmt --write` on changed files: exit 0; Swift files are unsupported/left untouched by oxfmt.
- `pnpm run lint:design`: exit 0.
- `pnpm run build`: exit 0 (web/server bundles; not an iOS/Electron application build).
- All web unit tests: **171 passed, 0 failed**. Final inbox regression rerun: **9 passed**.
- Entire DeployKit Swift package: **180 tests in 9 suites passed, 0 failed**. Includes the new URLProtocol integration proving health reads Live and computers within one second at the test pacing interval, with only the initial full refresh. The production pacing interval remains two seconds.
- Focused server tests (`live`, `events`, `health`, `inbox`, `health-event-retention`, `maintenance`): **32 passed, 0 failed**. Final Live-only rerun: **12 passed**.
- Edge `app-pages.test.ts`: **7 passed, 0 failed**.
- APNs `push.test.ts`: **9 passed, 0 failed** (including its two local HTTP tests).
- `git diff --check`: exit 0.

Commands for the main focused checks:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 node --test server/v2/live.test.ts server/v2/events.test.ts server/v2/health.test.ts server/v2/inbox.test.ts server/workspace/health-event-retention.test.ts server/maintenance.test.ts
node --import tsx --import ./scripts/test-css-stub.mjs --test $(rg --files app | rg '\.test\.(ts|mjs)$')
swift test --disable-sandbox --scratch-path /tmp/deploy-swift-event-tests --cache-path /tmp/deploy-swift-cache --package-path native/Apple/Packages/DeployKit
```

The initial ordinary `swift test` failed at manifest compilation (`sandbox-exec: sandbox_apply: Operation not permitted`). The temporary build/cache paths and `--disable-sandbox` allowed the entire package suite to run successfully.

## Not verified / orchestrator handoff

- Full `pnpm test` was not run: the unfiltered runner includes Chromium and servers selecting arbitrary ports outside 5180–5183. Unrelated router/worker/server suites are not claimed as passing.
- No Xcode iOS app build, simulator/physical-device run, Electron build, browser render or screenshots. No before/after layout claim; these are wrong-value and event-path fixes with no design/copy change.
- No production database/feed replay, device battery/CPU profiling, production prune timing, lock-contention benchmark or full hour retention-timer soak.
- The iPhone detail sheet's pre-existing one-shot health detail request was left unchanged; if that independent behavior needs improvement it should be a separately scoped change.
- To build the iPhone application outside this sandbox, follow `native/Apple/README.md`: generate `native/Apple/project.yml`, then build scheme `DeployIOS` for `generic/platform=iOS Simulator`, with derived data in a temporary directory. Verify on a 390-point iPhone that (a) returning after answering/withdrawal never flashes replayed waiting items, (b) a new/reopened item appears, (c) Live/computer changes and heartbeat ages remain fresh through at least 90 seconds idle. Capture Waiting on you before/after replay and Live/computer state before/after a health change. There is no new listening fixture server: replay and pacing fixtures are the socket-free URLProtocol servers in `V2Tests.swift` and `V2RefreshPacingTests.swift`; retention has the standalone temp-only command above. Existing port-5186 screenshot fixtures do not model this regression and were not started.
