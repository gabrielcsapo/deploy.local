# Approved iPhone design review pager

Implementation of the approved `886961ae` phone boards and their `review-clarity-…Phone` canvas notes, using the server API from `docs/evidence/review-clarity-build/README.md`. Work is uncommitted on `codex/review-clarity-build`. The simulator follow-up below also changes server preview density and web density requests; design boards and deployment are unchanged.

## Simulator follow-up (2026-11-04)

Compared the supplied 402-pt cover, web viewer and grid captures with `DesignReviewPhone`, `DesignReviewViewerPhone`, `DesignReviewDecidePhone` and `DesignReviewGridPhone` HTML. Applied the requested corrections to the existing approved design; no commits.

- Menu decisions navigate to Finish review, and the model rejects approve/changes submissions from other pages. Successful answers dismiss to their opener and show the authoritative outcome for five seconds. Errors retain the review and allow retry. All review entry points share the completion presentation.
- Viewer headings truncate at one line above the counter; preview widths use ungrouped digits. The cover uses a 28-pt scalable bold heading with two lines maximum.
- Cover and grid crops fill their bounds, centered horizontally and aligned to the top. Grid rows use equal 122-pt image heights, two-line captions, individual seen/pin/status capsules, 17-pt semibold section names, a close button and the existing seen/Next unseen footer.
- Review preview and render routes accept a finite scale from 1–3 (default 1), use it as Playwright deviceScaleFactor and separate both cached and in-flight renders by scale. Dimensions, crops, layer boxes and pin coordinates stay in CSS pixels. iPhone requests display scale capped at 3; web requests devicePixelRatio capped at 2.
- Added server regression coverage for default/invalid/fractional densities, unchanged geometry, concurrent cache separation and image URL propagation. The browser-backed test also checks 2×/3× PNG dimensions. Added iOS model tests for menu navigation, Finish-only submission, successful outcomes and failure retention; the authenticated client test checks the scale cap.

Validation for this follow-up supersedes the earlier validation limitations below:

- `tsc --noEmit -p .`: passed using the installed binary (the pnpm shim could not verify its registry download in this sandbox).
- Web unit tests: **303 passed**. Production web/server build and all three design lint checks passed.
- `DEPLOY_TEST_NO_LISTEN=1 DEPLOY_TEST_NO_BROWSER=1 node --test server/v2/design.test.ts`: **32 passed, one browser test skipped**. Running the browser test separately confirmed Chromium aborts under this sandbox; real 2×/3× PNG rendering remains to be checked outside it.
- macOS `swift build` and `swift test`: passed, **153 tests passed**, using writable module caches and SwiftPM's `--disable-sandbox` (the outer workspace sandbox remains in effect).
- iOS simulator SDK `swift build --build-tests`: passed, including the new DeployUITests target. Those two iOS model tests compiled but could not execute without CoreSimulator access.
- No after screenshots or runtime parity claim: CoreSimulator service access is blocked here. Verify the corrected layout at 390 and 402 pt and the success/error navigation in the simulator. Existing unrelated Swift concurrency warnings remain.

## Board → code mapping

All source paths below are relative to `native/Apple/Packages/DeployKit/`.

| Approved board          | Implementation                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DesignToReviewPhone     | `Sources/DeployUI/V2/V2Design.swift`: project-scoped proposal list, plain titles, proposer/time/counts, conflict entries, usable projects, same-project canvas when nothing waits. The landing also accepts a nil project for a global list.                                                                                                                     |
| ProjectPhone            | `Sources/DeployCore/V2/V2Operations.swift`, `Sources/DeployUI/V2/V2Projects.swift`: “1 waiting on you”; compact-width Design opens the native landing. Existing iPad canvas route remains.                                                                                                                                                                       |
| WorkAgentsPhone         | `Sources/DeployUI/V2/V2Root.swift`, `V2Places.swift`, `V2Design.swift`: plain review title and “Design · N screens · proposer”, or the conflict count. Work and inbox open the same cover.                                                                                                                                                                       |
| DesignReviewPhone       | `Sources/DeployUI/V2/V2DesignReview.swift`: cover title, summary/fallback, proposer, totals, main-update status, four crop peeks, Start review and See all screens. No decision buttons on the cover.                                                                                                                                                            |
| DesignReviewViewerPhone | `V2DesignReview.swift`, `V2ReviewPreview.swift`: native horizontal `TabView(.page)`, one phone screenshot at 1:1, native-coordinate outlines and pins, screen counter, Show changes / Pin / All screens / seen-and-pins toolbar, progress track.                                                                                                                 |
| DesignReviewHoldPhone   | `V2ReviewPreview.swift`: press-and-hold swaps pixels and outlines within the same `UIScrollView`; release restores After without changing zoom or offset. Before capsule is transient. New/removed screens have only their available revision and no comparison control.                                                                                         |
| DesignReviewWebPhone    | `V2ReviewPreview.swift`: web starts at 1:1 around the first changed region with 48 px context; web pinch/pan, 72 px overview with viewport rectangle, overview-to-fit, double-tap fit ↔ 1:1, width chip/menu only when multiple widths exist. Change chevrons clamp at the ends and use API words. Outward horizontal swipes at preview edges pass to the pager. |
| DesignReviewPinPhone    | `V2ReviewState.swift`, `V2ReviewPinSheet` in `V2DesignReview.swift`: Pin tool then location, numbered draft, light haptic, medium/large native sheet, keyboard focus, Cancel / Pin N / Add. Trimmed-empty drafts cannot save; failed requests keep the draft. Saved pins support editing, removal and reopening.                                                 |
| DesignReviewGridPhone   | `V2DesignReview.swift`, `V2ReviewCrop`: large-detent sheet; three-column crops in authoritative canvas page/board order; seen/pin marks and status tags; Next unseen wraps once in pager order. Grid scroll anchor and selected widths stay in review state. Thumbnails do not mark seen.                                                                        |
| DesignReviewDecidePhone | `V2DesignReview.swift`, `V2ReviewState.swift`, `V2ReviewModel`: looked-at count, numbered pin rows, unresolved-pins primary action, Approve secondary with pins, Approve primary without pins. Menu decisions share readiness checks. Preview failures/loading and conflict checks disable decisions. Conflicts offer Ask to update / Close.                     |
| DesignReviewRound2Phone | `V2DesignReview.swift`, `V2ReviewModel`: Since your last review cover, original numbered requests, Addressed / Still open and replies; only revised screens in canvas order enter swipe navigation. Unchanged screens remain inspectable through All screens, outside the swipe sequence. Only unresolved pins are requested again.                              |
| DesignReviewNotePhone   | `V2ReviewNotePage` in `V2ReviewPreview.swift`: notes follow screens, separate note counter, complete prose, highlighted changed lines, hold for Before, passage-location pins using note ID and coordinates. Notes do not increment the screen count.                                                                                                            |

`Sources/DeployUI/V2/V2Conversation.swift` routes the task’s dedicated Design tab into this same review. The separate existing chat-preview card remains outside the dedicated pager, as the approved canvas notes specify.

## Model and transport

- `Sources/DeployCore/V2/V2DesignReview.swift` moves/extends the existing backward-compatible review types and adds summary, preview geometry, pin and project types. It implements canvas/pager ordering, round-two filtering, Next unseen, primary-action and change-stepping rules.
- Its `V2Client` extension implements the documented list, preview, seen and pin endpoints. Authenticated preview URLs go through the existing `WorkspaceClient.data` and therefore the same session, credentials, origin checks and pairing certificate pinning as other V2 requests. No `AsyncImage` or independent URL session is used for review images.
- Answers use the existing `V2Client.answer`, which sends `on: "iphone"`. A metadata/main check precedes the existing atomic answer transaction; a failed check retains pins and drafts.
- `Sources/DeployUI/V2/V2ReviewState.swift` owns loading, cached previews and widths, pin mutations and decisions. Decisions require authoritative pins/conflict metadata and all selected screen previews to be loaded successfully.
- Screen seen writes wait one continuous foreground second with the loaded page selected and the review’s sheets/covers closed. Changing screen, loading a new width, backgrounding or presenting a sheet cancels that wait. Server seen state is shared across widths; looking never resolves a pin.
- New review copy uses scalable SwiftUI text, wrapping rows, minimum touch targets, labelled tools and “Screen 3 of 22, [screen title], changed” accessibility descriptions. Screenshot pixels retain native scale.

## Files changed

- `Sources/DeployCore/V2/V2DesignReview.swift` (new)
- `Sources/DeployCore/V2/V2Operations.swift`
- `Sources/DeployUI/V2/V2DesignReview.swift`
- `Sources/DeployUI/V2/V2ReviewState.swift` (new)
- `Sources/DeployUI/V2/V2ReviewPreview.swift` (new)
- `Sources/DeployUI/V2/V2Design.swift`
- `Sources/DeployUI/V2/V2Projects.swift`
- `Sources/DeployUI/V2/V2Root.swift`
- `Sources/DeployUI/V2/V2Places.swift`
- `Sources/DeployUI/V2/V2Conversation.swift`
- `Tests/DeployCoreTests/V2DesignReviewTests.swift` (new)
- `Tests/DeployCoreTests/V2Tests.swift`
- This evidence note.

## Validation

- `npx tsc --noEmit -p .`: passed.
- Requested full web suite: **290 passed**, zero failures.
- `swift build && swift test`: build blocked before package compilation by the unwritable default module cache. Retrying with writable temporary caches reached `sandbox-exec: sandbox_apply: Operation not permitted` while loading the package manifest. A separate `swift test` attempt also failed before running tests. No successful full SwiftPM, iOS app or macOS app build is claimed.
- Actual changed Swift source parses with `swiftc -frontend -parse`; `git diff --check` passes.
- Supplemental isolated checks: **10 model/API checks passed**. They exercise the new test bodies as ordinary assertions, including order, note/screen separation, pins rule, Next unseen, second round, change bounds, geometry, dates, scoped landing, credentials, same-origin image enforcement, pin coordinates/reopening and iPhone answer source.
- To run those supplemental checks without compiler plugins, temporary copies under `/private/tmp` omitted Observation macros; the actual model and client logic was compiled into a temporary DeployCore library. This is **not** a substitute for the committed Swift Testing suite.
- The new review UI and its existing component dependencies also passed an isolated iOS 17 simulator-SDK type check using temporary copies with a property-wrapper alias for the SDK’s blocked State macro and plain Observable conformance. The existing WKWebView KVO concurrency warning remains. This does not validate macro expansion, the whole app, rendering or gestures. Repository sources retain their normal macros.
- No server tests were needed: no server code changed. No Xcode, Simulator, Chromium, screenshot, dev server, live deploy.local or SER access was used.

## Gaps and owner verification

- **Visual parity is unverified.** Build and capture the actual iPhone at 390 × 844 against all ten review boards plus ProjectPhone and WorkAgentsPhone. Check native sheet/keyboard detents, edge swipe versus web pan, long-press release, overview rectangle, Dynamic Type and VoiceOver. Full iOS and macOS compilation remain required outside this sandbox.
- Note “Seen” is local to the open review. The documented persistence endpoint accepts screens only; note viewing is kept separate and never submitted as a screen. Screen seen state and all pins persist through the server.
- Note pins retain their note ID, revision and rendered coordinates; changing Dynamic Type can reflow the prose around those coordinates. There is no semantic passage-anchor field in the existing API.
- Original pin revisions are retained. Pins older than the available Before revision remain readable/editable in Your pins but cannot be overlaid on an unavailable historical image; no unapproved revision-history selector was added.
- Unchanged round-two screens open as standalone pages from All screens and do not become extra swipe pages. Returning to the cover and reopening All screens retains the grid anchor and selected widths.
