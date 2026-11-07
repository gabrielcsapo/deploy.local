# iPhone loading implementation handoff

Source: the seven approved loading boards, `OfflinePhone`, and the full `iphone-loading-patterns` note in `design/canvas.json`. No design files changed. Changes are uncommitted; no commit, push, merge, SER access, deploy.local request, or real data directory access was performed.

## Logical changes for separate commits

1. **Shared state and resource reads.** `DeployCore/V2/V2LoadState.swift`, `V2Store.swift`, `V2Client.swift`, and the core loading tests. Presence is tracked per resource, including successfully empty disk caches. Store reads complete independently and retain successful siblings. Navigation invalidates request tickets; old replies cannot finish a newer visit. Foreground status starts immediately and retains its completion timestamp. Polls preserve existing status without starting or completing a foreground line. The original refresh pacer and its light-read cadence remain in place. Inbox snapshots merge independently without discarding newer event positions or legacy responses. A missing Projects endpoint requires an actual workspace/project fallback; it cannot invent an empty success after workspace failure.
2. **Destination UI and shared presentation.** `DeployUI/V2/V2Loading.swift`, `V2Components.swift`, and the audited views in `V2Root`, `V2Places`, `V2Conversation`, `V2Composer`, `V2Projects`, `V2AgentDetails`, `V2SettingsApprovals`, `V2Backups`, `V2Devices`, `V2Packages`, `V2Design`, and `V2Releases`; `V2LoadingReadTests.swift`. Static token-colored skeletons, exact resource slow wording, cache/no-cache failure notices, Try now, last-known treatment, and foreground header status are shared. Decorative shapes are accessibility-hidden; status announcements are deduplicated. Package sections reveal independently. Changes and Checks each request the existing diff endpoint on demand in their own tab; chat history does not block either. Local successful reads are cached in the signed-in store's memory, including empty responses. No new offline send/queue behavior was added.
3. **Simulator capture support.** This directory, `V2LoadingFixtureTests.swift`, `V2Evidence.swift`, and the fixture-navigation/preparation hunks in `V2Root.swift`. The existing debug Simulator launch flags route before data arrives. Loading captures use a fresh temporary cache for every app launch; only HomeRefreshingPhone seeds it, from `/fixture/cache`. Physical-device and release builds cannot activate this route. The existing design-chat fixture also accepts `DEPLOY_FIXTURE_DUMP_PORT` so its decoding tests can use 5195 instead of their default 5199.

## Capture commands for the orchestrator

These commands were **not** run here. Xcode builds, the Simulator, Chromium, rendered board screenshots, and image pairs remain the orchestrator's work.

Generate and build using the repository's existing XcodeGen workflow:

```sh
xcodegen generate --spec native/Apple/project.yml
xcodebuild -project native/Apple/Deploy.xcodeproj -scheme DeployIOS -configuration Debug -destination "id=$SIMULATOR_UDID" -derivedDataPath /private/tmp/iphone-loading-ios build
xcrun simctl install "$SIMULATOR_UDID" /private/tmp/iphone-loading-ios/Build/Products/Debug-iphonesimulator/Deploy.app
```

Use a portrait Simulator with a **390 × 844 pt** viewport. For each row below, restart the fixture with the listed board, then relaunch the app with the same board. No Vite server is needed; 5195 stays available for the existing decoder fixture tests.

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 pnpm exec tsx docs/evidence/iphone-loading-build/fixture-server.ts --board HomeLoadingPhone
```

In another terminal:

```sh
xcrun simctl launch --terminate-running-process "$SIMULATOR_UDID" local.deploy.workspace.ios --v2-fixture http://127.0.0.1:5194 --v2-board HomeLoadingPhone
xcrun simctl io "$SIMULATOR_UDID" screenshot /private/tmp/HomeLoadingPhone.png
```

Change **both** `--board` and `--v2-board` to the desired row:

| Board                | Deterministic behavior and capture point                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HomeLoadingPhone     | Work resources never answer. Capture before 10 seconds.                                                                                                                            |
| ProjectsLoadingPhone | Projects never answers; other startup resources succeed. Capture the Projects tab before 10 seconds.                                                                               |
| TaskLoadingPhone     | Workspace supplies the known “Fix the sync worker” title; task history never answers. The conversation sheet opens directly. Capture before 10 seconds.                            |
| LiveLoadingPhone     | Live never answers; other startup resources succeed. Capture the Live tab before 10 seconds.                                                                                       |
| HomeLoadingSlowPhone | Same never-answering Work request. Capture after 10 seconds and before URLSession's eventual request timeout.                                                                      |
| HomeRefreshingPhone  | A temporary saved snapshot appears immediately; foreground reads never answer. Capture Updating… before 10 seconds; capture the slow banner and Waiting for SER… after 10 seconds. |
| HomeUnavailablePhone | Requests immediately return HTTP 503. Capture the failure and Try now; there are no saved rows or last-heard timestamp.                                                            |
| PackagesPhone        | Opens the actual Packages sheet. Both Private and Copies never answer. Capture before 10 seconds and again after 10 seconds for each exact slow line.                              |
| PackageVersionsPhone | Private packages succeeds and opens the known package's versions sheet independently of Copies; versions never answers.                                                            |

The fixture deliberately holds sockets without replying. A client timeout is a known failure and should replace the pending state; it is not suppressed to fake endless UI loading. Each independent capture gets a new temporary native cache on relaunch. HomeRefreshingPhone is the only seeded-cache launch.

Control responses while the app remains open. Packages uses the separate `private` and `copies` controls instead of `behavior`:

```sh
# Resolve held Work/Projects/Task/Live/versions reads.
curl 'http://127.0.0.1:5194/fixture/state?behavior=success'

# Fail those held reads, including over HomeRefreshingPhone's saved rows.
curl 'http://127.0.0.1:5194/fixture/state?behavior=fail'

# Packages: Private arrives while Copies stays pending.
curl 'http://127.0.0.1:5194/fixture/state?private=success&copies=hang'

# Keep Private readable while Copies fails, then recover it.
curl 'http://127.0.0.1:5194/fixture/state?copies=fail'
curl 'http://127.0.0.1:5194/fixture/state?copies=success'

# Reverse the independent package case.
curl 'http://127.0.0.1:5194/fixture/state?private=hang&copies=success'
curl 'http://127.0.0.1:5194/fixture/state?private=fail'

# Diagnostics: paths requested and currently parked requests.
curl 'http://127.0.0.1:5194/fixture'
```

Success mode supplies a small real-contract sample, not a historical recreation of the entire refreshed Work board's seven decisions. For a missing resource after success, relaunch into its board to clear temporary memory. For retry behavior, leave failure mode active and tap Try now (failure stays), then set `behavior=success` and tap again (or allow its visible-resource retry to complete).

Render and pair the approved boards on the orchestrator:

```sh
node design/tools/render.mjs HomeLoadingPhone
# Repeat for all seven board names. Render PackagesPhone as its existing content reference.
uv run --no-project --python 3.13 --with pillow python design/tools/pair.py /private/tmp/pair-HomeLoadingPhone.png output/design/HomeLoadingPhone-390.png /private/tmp/HomeLoadingPhone.png
```

Normalize a Simulator screenshot to its logical 390 pt width before pairing if it has a 2× or 3× pixel scale. Inspect all seven pairs, Packages, both independent package failures, cached slow/failure, navigation back during a request, returning to a screen, foreground reconnect, and persistent Updated just now → Updated 1 min ago. Turn on Reduce Motion and VoiceOver and repeat loading/failure/retry. Verify announcements occur once and skeletons are absent from the accessibility tree.

## Coverage and layout limits

Every destination in the note is wired: Home Agents / Waiting on you / Today; Answered; Projects and project detail; Live and app detail; Computers and models; Backups; Paired devices; task/agent conversation; Changes; Checks; Settings approvals and per-agent permission values; agent details/learned section; agent runs; Private packages / Copies / package versions; Design landing; releases list and detail.

The server intentionally has no learned-preferences feature yet (`server/v2/agents.ts` calls it a later feature). The existing “Nothing learned yet” section is now gated by a successful or cached agent read. No lessons endpoint, learned data, or new empty wording was invented.

The embedded Design canvas remains the existing WKWebView. Native Design-list requests now receive loading/refresh/failure handling, and a cached-empty review list's canvas receives the list's slow/offline notice. This does **not** add a native status model to the web canvas's own document/resource navigation.

No rendered layout comparison was possible. Known differences from source inspection, retained rather than expanding this task's navigation/content scope:

- The native Projects destination retains its existing single Projects list and inline selected-project section after loading; the board's loaded Active/Maintained/Done destination is not rebuilt here. The new loading region uses its approved two-group skeleton and explanatory paragraph.
- The existing native Live header has no Search action and Projects has no New project action. Those board controls are not added without their existing flows being specified. Work keeps its existing New agent control.
- HomeRefreshingPhone includes Team summary and a collapsed seven-decision presentation; the existing native Work content lacks that summary and renders its actual decision rows. The fixture supplies smaller contract-valid content. Loading status does not introduce those unrelated content features.
- Root pages now reserve their static center-header slot above the large title. Inline native sheets retain their actual title with the status below it; Task retains its title, tabs, existing project subtitle and composer. Precise vertical rhythm, truncation, safe-area geometry, and composer/tab-bar parity need the 390 pt captures. No pixel-parity claim is made.
- Project sections use each existing section's actual data/links and skeletonize before it is known; app/release navigation is never fabricated before its data exists. The two native diff tabs share one server endpoint, read separately on demand.

## Tests and evidence

Logs live in `/private/tmp/iphone-loading-*.log`. No timing on the Simulator or production network was measured. Deterministic clock tests check Updating at request start, slow=false at 9 seconds and true at 10, unchanged wait start across retries/polls, retained completion, and age at one minute. Existing pacer simulation checks zero full refreshes and four light refreshes across 60 idle seconds; transport tests check health and event bursts.

Before-fix failures actually observed:

| Test                                                                     | Result before its fix                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Six `V2LoadingTests` state tests                                         | Initial compile failed because `V2LoadState` did not exist. This is an API/implementation absence, not six observed runtime assertion failures.                                           |
| `workspaceFailureDoesNotDiscardIndependentAgentsLiveProjectsOrComputers` | Failed four expectations: all four successful sibling results were absent after a workspace 503.                                                                                          |
| `newerSnapshotRetainsItsRowsAndLegacyPagesStillLoad`                     | Crashed with “Fatal access conflict detected” in the new independent inbox merge during removeAll. Merge now uses local value copies, preserves cursor ordering and accepts legacy pages. |
| `captureCacheDecodesAndPreservesResourcePresence`                        | With the original malformed cache field temporarily restored, failed decoding `inboxPosition.waiting` (keyNotFound); corrected fixture restored afterward.                                |
| `absentProjectsEndpointCannotTurnFailedWorkspaceIntoEmptySuccess`        | Failed three expectations: a Projects 404 plus workspace 503 became successful empty cached Projects.                                                                                     |
| `inMemoryDecisionPreventsSkeletonBeforeItsListResponds`                  | Failed two expectations: a real waiting decision already in memory still reported no data and skeleton.                                                                                   |

Intermediate verification also caught regressions introduced during this work: `healthRefreshesLiveAndComputersPromptlyWithoutAFullRefresh` saw two full reads instead of one after an optional-resource failure, and `unauthorizedStopsRefreshAndKeepsSavedDraft` lost its authentication flag to a successful sibling. Both pass after correction. The first test edit also needed a Swift Testing macro fix: mutating state calls are evaluated before passing their Boolean to `#expect`.

Final checks actually run:

- Full Mac Swift package: **206 passed, 0 failed** — 203 core tests in 13 suites and 3 shared UI-state tests in 1 suite. Core run: 2.173 seconds; shared UI-state run: 0.012 seconds. Log: `/private/tmp/iphone-loading-swift-final.log`.
- `pnpm run typecheck`: **passed**, exit 0. Log: `/private/tmp/iphone-loading-typecheck-final.log`.
- `pnpm exec oxfmt --write` on every changed source/test/document path: **passed**; it formats the four TS/Markdown files and ignores Swift. A final invocation follows this evidence edit.
- Focused Node: **3 passed, 0 failed, 0 skipped, 0 cancelled**, 157.461333 ms total. Log: `/private/tmp/iphone-loading-node-final.log`. That duration is test execution, not a UI performance measurement.
- iOS-target syntax parse: **passed**, with the macOS-sysroot warning noted below. Log: `/private/tmp/iphone-loading-parse-final.log`.
- `pnpm run lint:design`: **passed**, including motion checks, palette parity (27 tokens in both appearances), and native control/icon checks. Log: `/private/tmp/iphone-loading-lint-design.log`.
- `git diff --check`: **passed**.

The initial missing-state compile failure covered these exact new test names: `onlyMissingDataUsesSkeletonsIncludingSuccessfulEmptyCache`, `failureIsNeverSuccessfulEmptyAndReplacesPendingImmediately`, `retriesAndPollsDoNotRestartTenSecondClock`, `navigationRejectsOldResponsesEvenForSameResource`, `pollsStayQuietAndCannotCompleteForegroundStatus`, and `cachedFailureKeepsReadableData`. All six now pass.

```sh
DEPLOY_FIXTURE_DUMP_PORT=5195 CLANG_MODULE_CACHE_PATH=/private/tmp/iphone-loading-clang swift test --disable-sandbox --cache-path /private/tmp/iphone-loading-cache --package-path native/Apple/Packages/DeployKit --scratch-path /private/tmp/iphone-loading-build
pnpm run typecheck
pnpm exec oxfmt --write <all changed source/test/document files>
DEPLOY_MDNS_ADDRESS=127.0.0.1 DEPLOY_TEST_NO_BROWSER=1 node --test --import tsx docs/evidence/iphone-loading-build/fixture.test.ts server/v2/design-chat-native.test.ts
swiftc -frontend -parse -target arm64-apple-ios17.0-simulator native/Apple/Packages/DeployKit/Sources/DeployUI/V2/*.swift
git diff --check
```

`pnpm test` was not run: its existing CLI/bundle/web-redirect fixtures select ports across 5180–5199, outside this task's assigned 5194–5195 range. This leaves the router, worker, full web and full server partitions unverified. The focused HTTP fixture binds only 127.0.0.1:5194 and the existing Swift decoder fixture now uses 5195 via the override. Before discovering its hardcoded dump port, the first full Swift attempt started the existing design-chat decoder fixture on its default 5199; subsequent runs use 5195. No browser was launched.

The Swift package runs on macOS, so iOS-only views and `V2ReviewStateTests` are excluded from type checking/runtime tests. The parse command checks iOS syntax only and warns about the macOS sysroot; it is not an iOS build. No Xcode build, Simulator interaction, actual screenshot, VoiceOver, Reduce Motion, touch/keyboard navigation, or device performance result is claimed.

## Orchestrator review

Built and captured on the Simulator against all seven boards. Fixed after comparing them: `Updating…`, `Waiting for SER…` and `Updated just now` no longer appear on a first load, which shows skeletons only; Try now is full width; Home hides + and Answered while their sections are skeletons; Home's rows no longer shift while a banner slot is empty; a build error in `V2Projects.swift`. One small gap remains: when a resource's own read is its first but rows are known from memory, `Updating…` ends with no `Updated just now`.
