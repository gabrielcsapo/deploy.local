# Resolve design conflicts in review

The implementation leaves `design/` unchanged. It uses `DesignReviewConflict.html`, `DesignReviewConflictPhone.html`, the full `resolve-conflicts` canvas note, and the shared choice layout as its specification. Nothing was committed, pushed, merged or deployed from this worktree.

## Run the fixture

From the repository root, with Playwright Chromium available:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5182 node --import tsx docs/evidence/resolve-conflicts/fixture-server.ts
```

The fixture accepts ports 5180–5199 and binds only to `127.0.0.1`. It creates a temporary database, repository, render cache and Vite cache. All 28 displayed boards are on that repository's canvas. There is no remote and no agent worker. Update requests queue records only in the fixture; the approval timer can land approvals into its temporary main. Stop with Ctrl-C.

Open one reset URL at a time; each resets the shared fixture and redirects to the real inbox review. The UI uses production routes and components, not a screenshot of the board.

| State             | Reset URL                                        | Expected                                                                                                            |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Unresolved        | http://127.0.0.1:5182/__fixture?state=unresolved | Tally, Designer, Project overview kept both, Project settings same part; 1 of 2 resolved; Continue review disabled  |
| Resolved          | http://127.0.0.1:5182/__fixture?state=resolved   | Same review with the proposal chosen for Project settings; 2 of 2 resolved; Continue review enabled; Undo available |
| Proposed by owner | http://127.0.0.1:5182/__fixture?state=owner      | You, no proposer task; Ask to update creates a task and the answered review links to it                             |

The settings screen opens first in the unresolved state. In the resolved state, select Project settings to inspect its saved answer. The proposal title and summary follow the approved web board.

Conflict metadata arrives without drawing the other screens. A separate request computes the ordinary review's pixel evidence in the background. Before that finishes, the Changes count is the ungrouped screen count; with Chromium, the fixture's four repeated header changes can group. Without Chromium it remains ungrouped and makes no claim that nothing else changed.

## Capture and inspect

Capture the web review at **1440 × 900** and **700 × 900**, light and dark. Reset before each state. Use the final redirected URL, or the reset URL, with:

```sh
node design/tools/capture.mjs 'http://127.0.0.1:5182/__fixture?state=unresolved' docs/evidence/resolve-conflicts/captures/DesignReviewConflict 1440,700 900
node design/tools/render.mjs --main DesignReviewConflict
python3 design/tools/pair.py docs/evidence/resolve-conflicts/captures/DesignReviewConflict-pair-1440.png output/design-main/DesignReviewConflict-1440.png docs/evidence/resolve-conflicts/captures/DesignReviewConflict-1440.png
```

Repeat for resolved and owner, and for 700 px. Inspect these behaviors:

1. The rail notice and Changed on main too group precede Changes. Kept both counts as resolved without an answer.
2. Keep main’s and Keep this proposal’s change only the overlapping parts. Undo removes the answer, and Continue becomes disabled again. Reload preserves a choice at the same revisions.
3. The conflict scrubber labels are Main and This proposal. Dragging and keyboard slider input compare those revisions; selecting an ordinary change restores Old and New.
4. Arrow keys cross conflict rows and ordinary changes. At 700 px, the picker contains both; slider arrows must not navigate the review.
5. Continue enables the ordinary Approve and Ask for changes controls. Approve retains the existing 30-second undo window.
6. Ask Designer to update sends the named screens to its existing task. In the owner state, Ask to update creates a project task; Open the task uses its ID.
7. Move main in the printed temporary repository after saving a choice: the next read/decision must require a new answer. A choice submitted against the old main receives 409.
8. On an iPhone using the fixture API, inspect at **390 × 844** against `DesignReviewConflictPhone`: Project settings / Conflict 2 of 2, caption and resolved count, scrubber, then the two answers instead of the normal toolbar. Throttle other preview responses to confirm the first conflict remains usable. Swipe across the conflict pages and into the normal review. Test VoiceOver, Undo and task navigation.

## What is implemented

- Conservative lossless HTML parsing and merging by stable layer IDs, including own attributes/text, mixed text, child order, compatible additions/removals and deletion-versus-descendant-edit conflicts. Unsupported or unmergeable markup becomes a whole-screen choice. Merged boards are synchronized with the effective component library before landing.
- Persisted per-item/per-screen choices bound to main and proposal commits; null undoes a choice. Different canvas notes merge; competing edits to the same note use the same choice mechanism. Choices from older revisions never authorize a decision.
- Review summaries and screens carry kept-both/same-part, plain change descriptions, chosen side, and main revision. Approval and change requests recheck under the repository write lock. Both conflict and ordinary previews remain available, including comments on the Main revision.
- Web conflict rail, counts, quiet update action, gated Continue, shared choice controls, Main/This proposal scrubber, keyboard navigation and task links.
- iPhone conflict pages, pure-core readiness/navigation rules, fast initial metadata, independent evidence loading, inline choices/Undo and task links. The old sheet remains only for older coordinators that do not send resolutions.
- CLI guidance to resolve unresolved screens in the review; no CLI choice controls. No CLI help text changed.

## Differences and unverified work

No intentional change to the approved layout or interaction is proposed. Actual browser and iPhone visual parity has **not** been verified. No screenshots were produced in this sandbox.

Fixture data is synthetic: timestamps and commit hashes vary; only Designer and the design task are seeded. Change descriptions are derived from real layer names/text, so the settings row includes the layer name and changed text rather than the board's hand-authored breadcrumb example. The ordinary Changes count remains 28 until pixel evidence permits grouping; the reference illustrates an already-grouped count of four. Neither the ungrouped fallback nor a missing preview is reported as visual evidence of a match.

The full DeployKit package could not run here: the default Swift module cache was not writable; redirecting caches allowed compilation but package dependency acquisition failed. An isolated temporary package copied the unchanged DeployCore target and its tests, excluding the UI dependency; that compiled the updated core and passed the focused review suite. An exploratory run of all 216 core tests in that temporary package had 11 issues: ten missing repository-relative capture fixtures and one certificate-trust expectation. Those unrelated failures were not changed. The focused result does not establish an iOS build.

The three changed DeployUI files were syntax-parsed successfully, but iOS-only code was not typechecked, built or run. The orchestrator must perform that validation and the 390 px capture.

A broader existing CLI integration suite attempted to bind `127.0.0.1:5180` and failed with `listen EPERM`. It was not rerun; the new CLI tests and existing inbox-wait unit tests run without sockets and pass. No listening server or browser was successfully started.

## Changed Apple files

All paths are relative to `native/Apple/Packages/DeployKit/`:

- `Sources/DeployCore/V2/V2DesignReview.swift` — resolution models, navigation/readiness and API requests.
- `Sources/DeployUI/V2/V2DesignReview.swift` — conflict pages and controls, Main comparison revision, task links.
- `Sources/DeployUI/V2/V2ReviewState.swift` — choices, progressive loading, revision-aware preview cache and readiness.
- `Sources/DeployUI/V2/V2ReviewPreview.swift` — Main/This proposal labels.
- `Tests/DeployCoreTests/V2DesignReviewTests.swift` — decoding, conflict order, resolution counts, choices and undo.

## Checks

Commands use the installed pnpm via `PNPM_CONFIG_PM_ON_FAIL=ignore`; no package-manager or dependency configuration was changed.

| Check                                | Observed output/result                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server + board tests                 | `ℹ tests 72`, `ℹ pass 71`, `ℹ fail 0`, `ℹ skipped 1` (Chromium test intentionally skipped)                                                                                       |
| Web review model                     | `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`                                                                                                                                            |
| CLI conflict + inbox-wait unit tests | `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`                                                                                                                                              |
| Isolated DeployCore review suite     | `✔ Test run with 18 tests in 1 suite passed`                                                                                                                                     |
| iOS source syntax parse              | No output; exit 0; not an iOS typecheck                                                                                                                                          |
| `pnpm typecheck`                     | `$ node scripts/flight-router.mjs && tsc --noEmit`; exit 0                                                                                                                       |
| `pnpm lint`                          | `Design literals: no local pixel type sizes or literal colors.`; `Workspace motion: shared duration tokens and native animations.`; native parity checks passed; warnings remain |
| `pnpm format:check`                  | `All matched files use the correct format.`; exit 0                                                                                                                              |
| `pnpm build`                         | `✓ Done in 982ms`; `Built dist/edge.js, dist/supervisor.js, dist/log-worker.js and workspace workers`; exit 0                                                                    |
| Fixture without ports/browser        | `Fixture self-test: 3 states, 28 canvas boards, 3 review redirects and client transform passed.`                                                                                 |
| `git diff --check`                   | No output; exit 0                                                                                                                                                                |
| `git diff -- design/`                | No changes                                                                                                                                                                       |

Reproduce the server, web, CLI and fixture checks without ports or a browser:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 DEPLOY_TEST_NO_LISTEN=1 DEPLOY_TEST_NO_BROWSER=1 node --test --experimental-strip-types server/v2/design.test.ts server/design/board-html.test.ts
node --test --import tsx --import ./scripts/test-css-stub.mjs app/routes/dashboard/v2/design/review-model.test.ts
DEPLOY_MDNS_ADDRESS=127.0.0.1 node --test bin/cli-inbox-conflicts.test.mjs bin/cli-inbox-wait.test.mjs
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5182 DEPLOY_TEST_NO_LISTEN=1 DEPLOY_TEST_NO_BROWSER=1 node --import tsx docs/evidence/resolve-conflicts/fixture-server.ts
```
