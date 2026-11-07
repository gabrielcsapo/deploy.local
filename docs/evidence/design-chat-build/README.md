# Design chat and sent review handoff

Approved source: `8448663e`, DesignChat, DesignChatPhone, DesignReviewSent and the `review-sent` canvas note. No boards or canvas files were changed. All implementation changes are uncommitted.

## Round 2: real-capture corrections

The supplied captures were inspected: `pair-DesignChat-1440.png`, `pair-DesignChat-700.png`, `pair-DesignReviewSent-1440.png`, `pair-DesignReviewSent-700.png` and `real-iphone-chat.png` in `/private/tmp/claude-501/design-chat-captures/`. This round adds no design changes or new on-screen wording. No commit, push, merge, SER access or real data directory access was performed.

Logical changes for review/committing:

1. **Web decision ownership** (`InboxDecision.tsx`, `Review.tsx`, task `page.client.tsx`, `chat-history.test.ts`): a waiting design decision renders the approved Before/After card with Review and Open in Design. The task's fallback card does not mount or fetch previews when that proposal already has a decision event. Other decision kinds and closed decision rendering stay unchanged. Answered reviews retain their outcome in folded chat history; the latest answered event does not acquire a second fallback card. Their full review remains available through the existing task Design tab (`DesignReview` → `DesignItemReview`); no new answered-card wording was added. The iPhone already dispatches each decision to either `V2DesignCard` or `V2Decision`, and excludes rendered event IDs from its context fallback; it has no equivalent duplicate-card bug.
2. **Native fixture contracts and ownership** (`fixture-server.ts`, `V2CaptureFixtureTests.swift`): fix fixture responses, with no production Swift changes this round. The native task payload was missing `task.workspacePath` and `task.baseRevision`; its diff was missing `baseRevision` and `headRevision`. The real server supplies these fields. Both normal review payloads already decoded successfully. Swift's URL encoder sends the project as `deploy%2Dlocal`; the fixture failed to decode its path, so review/count requests returned 404 and the card's `try?` discarded the error. The card therefore never reached preview loading. Decode the fixture path as the real router does. Use separate Welcome and Agents task IDs, including after reset; supply the Agents task destinations. Put the existing agent reply and user text into the native message snapshot, which was empty. `--dump` starts only an isolated HTTP fixture on 127.0.0.1:5199, exports its actual responses for Swift decoding tests, cleans its temporary root and exits. It never requests a preview or launches Chromium.
3. **Fixture grid geometry** (`fixture-preview.ts`, `design-chat-fixture.test.ts`): the fixture incorrectly used `after.rect` directly as the SVG crop and reported a 900 px height for phone boards. Use the approved sent contact sheet's crop and outline at the native board width, and the board's native height. For Agent details on iPhone this is crop `(0,92,390,440)`, outline `(20,140,350,250)` and native height 844 px. The former arbitrary fallback was crop `(117,250,156,240)`, making the tile 2.5 times closer across its width. `ReviewPreviews.tsx` and the production crop calculation are unchanged. Both the earlier `DesignReview.html` and `DesignReviewSent.html` already use the same `(0,92,390,440)` viewBox; the supplied zoomed tile came from this fixture, not a newly approved grid behavior. The screenshot pixels still come from current repository boards, so this fixture does not recreate historical image revisions.

Before-fix regressions actually run:

| Test                                                                                  | Observed before fix                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `nativeTaskDecodesActualFixtureJSON`                                                  | `DecodingError.keyNotFound` for `task.workspacePath`             |
| `nativeDiffDecodesActualFixtureJSON`                                                  | `DecodingError.keyNotFound` for `baseRevision`                   |
| `nativeEncodedReviewURLDecodesActualFixtureJSON`                                      | fixture 404 JSON could not decode: missing `item`                |
| `fixtureReviewsBelongToTheirOwnTasks`                                                 | both items had task ID `welcome`; sent review task was `welcome` |
| `nativeConversationIncludesTheAgentReply`                                             | no assistant message in native task snapshot                     |
| `sentReviewTaskDestinationDecodesActualFixtureJSON`                                   | fixture 404 JSON could not decode: missing `task`                |
| `design decisions use one preview card and keep answered history and other decisions` | 0 approved preview cards, expected 1                             |
| `capture fixture keeps the approved phone grid context and native height`             | got `(117,250,156,240)`, expected `(0,92,390,440)`               |

The first native run had 7 tests: 2 passed, 5 failed (6 issues). The added Agents destination regression was run separately before its fix: 7 passed, 1 failed. The normal chat and sent review JSON decoding controls passed before any fixture fix. Logs: `/private/tmp/design-chat-round2-swift-before.log`, `design-chat-round2-task-before.log`, `design-chat-round2-web-before.log`, `design-chat-round2-grid-before.log`.

Round 2 checks actually run:

- `pnpm run typecheck`: passed. An earlier run found incomplete inputs in the existing `chat-review.test.tsx`; those test inputs now supply a complete inbox item.
- `pnpm exec oxfmt --write` on all changed source/test files: passed; Swift files are ignored by oxfmt.
- Focused web/model/conversation/native-source/fixture/design-server command: **61 tests, 60 passed, 1 skipped, 0 failed**. The skipped test requires Chromium. Log: `/private/tmp/design-chat-round2-tests.log`.
- Full Mac Swift package suite with the temporary-cache command below: **185 tests in 9 suites passed**, including all 8 actual-fixture response tests. iOS-only tests are conditionally excluded on macOS. Log: `/private/tmp/design-chat-round2-swift-full.log`.
- `pnpm run lint:design`: passed. `pnpm run build`: passed.
- Six HTTP smoke groups passed: encoded native review URL / Welcome / two screens; web and native Welcome/Agents task destinations and native diffs; native assistant message; reset ownership / later-round sent record; answer mutation / answered inbox; self-proposed reset / final reset. No preview or image request was made.
- Full `pnpm test`: **not a pass**. Router: **26 files / 232 tests passed**; worker: **7 passed**; web: **172 passed**. The server partition stopped producing output and was interrupted (command exit **130**), then flushed **1,476 tests: 1,413 passed, 5 failed, 35 cancelled, 23 skipped**. Four tests in `server/workspace/repositories.test.ts` timed out with `spawnSync ps EPERM`; its restart test expected `ready` and got `preparing`. The five failing names and all 35 cancelled files are the same as the list at the end of this README. Cancellations report a pending promise after the event loop resolved. Docker/unavailable-tool cases and the Chromium rendering test were skipped by their existing guards. Log: `/private/tmp/design-chat-round2-full.log`. `DEPLOY_MDNS_ADDRESS=127.0.0.1 DEPLOY_TEST_NO_BROWSER=1 DEPLOY_SKIP_SWIFT_TESTS=1` was set; the complete Swift package suite ran separately with its working sandbox/cache command.
- `git diff --check` and an explicit `oxfmt --check` over all 13 changed JS/TS/Markdown files: passed.

Reproduce the focused checks (no browser):

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 DEPLOY_TEST_NO_BROWSER=1 node --test --import tsx --import ./scripts/test-css-stub.mjs app/routes/dashboard/v2/design/chat-review.test.tsx app/routes/dashboard/v2/design/chat-history.test.ts app/routes/dashboard/v2/conversation/render.test.ts app/routes/dashboard/v2/design/review-model.test.ts server/v2/design-chat-native.test.ts server/v2/design-chat-fixture.test.ts server/v2/design.test.ts
```

Still requiring orchestrator verification:

- Restart fixture and Vite with the commands below. Recapture **DesignChat** and **DesignReviewSent** at **1440×900 and 700×900**, pair against the boards, and inspect the result. Check one preview card, both destinations, first grid tile context and outline, folded answered history and ordinary decisions. Capture commands are below. This sandbox did not launch Chromium or Electron and did not measure browser timing.
- Rebuild **DeployIOS** using the existing build commands below, then relaunch the fixture on a **fresh simulator app cache**. Open Welcome → Chat. Capture at **390 pt** against `DesignChatPhone.html`: existing agent message, exactly one review, header **Welcome / 1 of 2 screens changed**, **Design 2**, Before/After images side by side at **120 pt** with captions, Review opening the full review. The code already has these header/count/preview rules; they depended on the broken fixture requests. Verify images actually complete on the simulator; HTTP decoding tests do not prove image loading or SwiftUI layout. The orchestrator's previous DeployIOS build succeeded; no iOS build or simulator run was attempted here.
- **Checks remains.** It was already absent from `DesignChatPhone.html` before `8448663e`; that approved commit did not change the phone tabs. The existing Swift picker includes Checks. Its absence from the board is pre-existing, with no evidence of an approved removal in this diff.
- **Preview failure recovery remains a product gap.** `V2ReviewState.loadPreview` sends errors through `coordinatorErrorDescription`, which returns `error.localizedDescription` for `DecodingError`; the full review displays that error verbatim. `V2DesignCard` also discards review-load errors with `try?`, and does not display its preview error, leaving shimmer on an actual failure. No error wording or failure UI was added; this needs approved wording/state. The red text in the supplied chat capture came from the malformed native task response, not preview metadata.
- Out of scope and left unchanged: composer placeholder/chips, “This task” panel, sidebar breakpoint (handled on another branch), other pre-existing chrome/layout differences and the known 700 px scrolling-pin issue. No new rendered parity, focus, scroll, Electron, iOS interaction, native image decoding or performance result is claimed here.

## Logical changes

1. Web/Electron corrections: use the approved four-screen glyph; keep Review and Open in Design together; keep the card's approved zoom when a changed wrapper spans most of the screen; keep the sent-pin notice in later rounds and remove the unsent notice after approval. Tests: `app/routes/dashboard/v2/design/chat-review.test.tsx`.
2. iPhone implementation: first screen in canvas order; independent Before/After crops at the narrow web width; 120 pt previews, captions and Review button. Keep the review's decide page open after changes or approval, preserve its pins, show the sent notice and approved footer copy, and provide Open the task / Open in Design. Existing conflict-update dismissal and note previews remain. Pure rules and tests live in DeployCore; source contract checks live in `server/v2/design-chat-native.test.ts`. Source contract checks do not prove SwiftUI compilation.
3. Capture fixture: `fixture-server.ts` and `capture.mjs`. In-memory mutations only; temporary data root; no Git processes, coordinator, workers, models or real data. Preview rendering is lazy and requires Chromium on the orchestrator. The chat's preview HTML comes from the approved board's embedded Welcome revisions. The 22-screen review uses current repository screens and the approved screen names/counts; it does not recreate historical pixel revisions. Its pin texts are synthetic. Compare its notice, pins, state and footer; historical thumbnail content is not parity evidence.

## Failing checks before fixes

All were run before their corresponding implementation:

- `chat card uses the approved four-screen glyph`: assertion failed with 0 rectangles instead of 4.
- `chat card keeps Review and Open in Design together`: assertion failed because a growing spacer separated the links.
- `chat crops keep the approved zoom even when a changed wrapper spans the screen`: expected 748.8 CSS px crop width, got 1388.8. Fixed crop width is 748.8 for that 1440 px test fixture. This is geometry, not a performance measurement.
- `sent changes retain their notice in later review rounds`: failed because `changesNotice` did not exist; it now covers later rounds and approval/update exclusions.
- `iPhone design chat delegates decisions to the full review`: source assertion found direct Approve/Ask for changes and V2BoardComparison.
- `iPhone decisions keep the record open and provide the approved onward destinations`: source assertion found unconditional dismissal.
- Swift `decisionFooterAndSentNoticeKeepTheReviewRecord` and `chatCropUsesEachSidesChangeAtTheApprovedZoom`: failed at compilation because outcome/sentNotice/cardRegion were missing. They subsequently executed and passed.

Initial web test invocation also failed at module loading until `node scripts/flight-router.mjs` built the workspace router. Initial plain SwiftPM invocation was blocked by `sandbox-exec: sandbox_apply: Operation not permitted`; the command below runs package tests with temporary caches and SwiftPM's nested sandbox disabled.

## Checks actually run in the initial round

- `pnpm run typecheck`: passed after fixture type corrections.
- `pnpm exec oxfmt --write` on every changed source/test file: passed; oxfmt handles the six TS/TSX files and ignores Swift. README/capture formatting is checked separately before handoff.
- `pnpm run lint:design`: passed.
- `pnpm run build`: passed.
- Focused web/model/native-source checks: 16 passed, 0 failed.
- `DEPLOY_TEST_NO_BROWSER=1` design server suite: 42 tests, 41 passed, 1 skipped (the Chromium rendering test), 0 failed.
- Full Mac Swift package suite: 177 tests in 8 suites passed. iOS-only tests are conditionally excluded on macOS.
- Fixture HTTP smoke checks: six passed (22/4/3 waiting state, later-round sent state, no-task state, approval mutation, task card event, approved board/static serving). No preview/render request was made here.
- Simulator-target Swift parser: passed with a warning about the default macOS sysroot. Parsing is not typechecking or an iOS build.
- `git diff --check`: passed.

Full `pnpm test` was attempted twice. Router: 26 files / 232 tests passed; worker: 7 passed; web: 171 passed in both attempts. The first server partition eventually reported 1,475 tests: 1,411 passed, 6 failed, 35 cancelled, 23 skipped. One failure was `boards render to PNG at a commit when Chromium is installed`. The second used `DEPLOY_TEST_NO_BROWSER=1`: 1,475 tests, 1,412 passed, 5 failed, 35 cancelled, 23 skipped. Both runs stopped producing output for several minutes and were interrupted (exit 130); the server processes subsequently flushed these summaries. Neither full run is a pass. Four repository tests timed out with `spawnSync ps EPERM`; the repository restart test had an assertion failure. Cancelled files report a pending promise after the event loop resolved. `DEPLOY_SKIP_SWIFT_TESTS=1` was set in these runs because the complete Swift package suite was run separately with the working temporary-cache command. Docker and unavailable package-manager cases were skipped by their existing tests. Logs are in `/private/tmp/design-tab-*.log` on this machine. No production server path or `scripts/perf/design-review.mjs` was changed; no Git process was added to any measured path. Review timing/browser performance was not measured here.

## Start the capture fixture

From the repository root, in two terminals:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 pnpm exec tsx docs/evidence/design-chat-build/fixture-server.ts
```

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 DEPLOY_DATA_DIR=$(mktemp -d /private/tmp/design-chat-vite.XXXXXX) DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5194 pnpm exec vite --host 127.0.0.1 --port 5195 --strictPort
```

The fixture binds only 127.0.0.1:5194 and proxies assets to 5195. `GET /fixture` lists the task/review URLs and item IDs. `GET /fixture/reset` restores waiting state. Reset options: `?state=changes`, `?state=approve`, `?state=changes&round=2`, `?state=changes&self=1`. Reset before each independent capture; reload the app afterward. The fixture ignores credentials; browser storage should contain `deploy-sh-auth={"username":"Gabriel","token":"fixture"}`.

On the browser-capable host:

```sh
node docs/evidence/design-chat-build/capture.mjs /private/tmp/design-chat-captures
node design/tools/render.mjs DesignChat
node design/tools/render.mjs DesignReviewSent
node design/tools/render.mjs DesignChatPhone
```

The capture helper saves DesignChat and DesignReviewSent at 1440×900 and 700×900. It authenticates the fixture, waits for previews, and actually asks for the three changes before the sent capture. It has not been executed in this sandbox. Compare each capture with `output/design/<Board>-<width>.png`, using `design/tools/pair.py`. Inspect the card crop/zoom, adjacent footer links, later-round sent notice, retained pins and single onward action. Check keyboard focus and the task/Design destinations manually. The known 700 px scrolling-pin issue and stale ProposalDesign boards remain outside this task.

## iPhone build and capture

The orchestrator must run the actual iPhone build on its dedicated simulator:

```sh
xcodegen generate --spec native/Apple/project.yml
xcodebuild -project native/Apple/Deploy.xcodeproj -scheme DeployIOS -configuration Debug -destination "id=$SIMULATOR_UDID" -derivedDataPath /private/tmp/design-chat-ios build
xcrun simctl install "$SIMULATOR_UDID" /private/tmp/design-chat-ios/Build/Products/Debug-iphonesimulator/Deploy.app
```

Launch the app's existing debug fixture mode with `--v2-fixture http://127.0.0.1:5194`. Use a fresh simulator app container/cache for the fixture; no new evidence-navigation hooks were added. Open the **Welcome: ask first** task from Work, then Chat. Compare at 390 pt width to **DesignChatPhone.html**: header, screen count, 120 pt Before/After images and captions, Review-only footer. Tap Review and verify it opens the full review rather than answering.

For the 22-screen record, open **Agents you make yourself** from Waiting on you. Go to Finish review (More → Ask for changes navigates there), send the three existing pins, and capture the still-open page. Compare its existing **DesignReviewDecidePhone** structure plus the approved **review-sent canvas note**: sent notice, retained pins, `Changes requested · just now · you looked at 4 of 22`, Open the task. There is no approved separate sent-phone board, so no new phone page layout was invented. Also verify approval → `Approved · this is the design on main` / Open in Design, and self-proposed → the exact no-task footer from the note. Capture the task and Design destinations after tapping them. Run iOS-only V2ReviewStateTests if the simulator test harness supports them; Mac package tests do not cover those interactions.

Not verified here: Chromium previews/capture helper, rendered parity at any width, keyboard/focus/scroll behavior, iOS SwiftUI typechecking/build, simulator interactions, Electron shell behavior, or review timing. No new wording or layout was invented for missing preview failure/notes-only screenshot states; those need their own approved references before a redesign.

## Swift command used

```sh
CLANG_MODULE_CACHE_PATH=/private/tmp/design-tab-clang-cache swift test --disable-sandbox --cache-path /private/tmp/design-tab-swift-cache --package-path native/Apple/Packages/DeployKit --scratch-path /private/tmp/design-tab-swift-build
```

## Full-suite failures and cancellations (both rounds)

Five failed tests in `server/workspace/repositories.test.ts`:

- durable import stays responsive, preserves dirty source and isolates authority; browsing pins source and HTTP push works
- empty source initializes without altering upstream; failures retry and cancellation is durable
- restart requires explicit retry; atomic prepared storage can be recovered without replacing it
- task preparation accepts a first message, fences execution, and can recover queued cancellation
- a hosted repository starts empty and syncs both ways with a remote, pausing when main changed on both sides

The 35 cancelled test files after interruption:

- `server/workspace/coordination.test.ts`
- `server/workspace/job-artifacts.test.ts`
- `server/workspace/remote-worker-restart.test.ts`
- `server/workspace/repositories.test.ts`
- `server/workspace/repository-browsing.test.ts`
- `server/workspace/repository-capabilities.test.ts`
- `server/workspace/repository-creation.test.ts`
- `server/workspace/repository-lfs.test.ts`
- `server/workspace/repository-lock.test.ts`
- `server/workspace/repository-settings.test.ts`
- `server/workspace/run-queue.test.ts`
- `server/workspace/run-recovery.test.ts`
- `server/workspace/task-detail.test.ts`
- `server/workspace/task-files.test.ts`
- `server/workspace/task-presentation.test.ts`
- `server/workspace/task-shell.test.ts`
- `server/workspace/terminal-pty.test.ts`
- `server/workspace/terminal-relay.test.ts`
- `server/workspace/transcription.test.ts`
- `server/workspace/turn-diff.test.ts`
- `server/workspace/update-base.test.ts`
- `server/workspace/verification-output.test.ts`
- `server/workspace/video.test.ts`
- `server/workspace/worker-lease.test.ts`
- `server/workspace/worker-loss.test.ts`
- `server/workspace/worker-process.test.ts`
- `server/workspace/worker-reconnect.test.ts`
- `server/workspace/worker-repository-access.test.ts`
- `server/workspace/worker-update.test.ts`
- `server/workspace/workspace-checks.test.ts`
- `server/workspace/workspace.test.ts`
- `shared/check-attempts.test.ts`
- `shared/check-label.test.ts`
- `shared/repository-address.test.ts`
- `shared/task-title.test.ts`
