# Design build check capture fixture

Run from the repository root, with dependencies and Playwright Chromium installed:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5181 node --import tsx docs/evidence/design-build-check/fixture-server.ts
```

The fixture binds only to `127.0.0.1:5181`. It creates its own temporary database, attachments, design render cache, Vite cache, and Git repository. It prints that directory and keeps it for inspection. It never uses the owner's data, contacts origin, starts an agent, merges, or releases. Stop with Ctrl-C.

Open one reset URL at a time. Each resets the shared fixture and redirects to the real task or inbox route, using Tally, Designer, and **A calmer Tally header**. Capture at **1440 px** and **700 px** after fonts and images finish loading. Use the boards’ authored heights: **900 px** for both task boards and **1160 px** for DesignBuiltDiffers.

| Board              | Reset URL                                                | Destination                                     |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------- |
| TaskDesignCheck    | http://127.0.0.1:5181/__fixture?state=TaskDesignCheck    | `/dashboard/tasks/tally-build/checks`           |
| TaskDesignChecked  | http://127.0.0.1:5181/__fixture?state=TaskDesignChecked  | `/dashboard/tasks/tally-build/checks`           |
| DesignBuiltDiffers | http://127.0.0.1:5181/__fixture?state=DesignBuiltDiffers | `/dashboard/inbox?item=<generated decision ID>` |

The task snapshot, report validation, inbox creation, screenshot attachment ingestion, and decision answers use production handlers. Checkpoint jobs are synthetic persisted records. The fixture stubs the workspace PR diff/check response and event long-polling; task refresh still reads the production snapshot. Merge/release calls return a fixture-only error instead of executing.

The approved design image is rendered by the production `/design/render` endpoint at the **approved immutable commit** and selected width. The synthetic Tally app HTML wraps History at 700 px; fixture captures use that HTML, then pass through `queueScreenshots` and `screenshotWorker` into task-owned attachments. The passing state captures the matching HTML at both widths. These are synthetic app captures, not evidence of this implementation's visual parity.

Check these interactions:

1. Waiting: a muted clock, **Design not checked**, disabled **Merge and release**, **Merge without the design check** in More, Approved design first, Checks count 4.
2. Matching: **Ready to merge**, green design check, **2 captures compared with the board · 1440 and 700 px**, and Compare opening both recorded widths.
3. Difference: What differs, approved design and attached app, Why, two answers, and Open the task. Change width and move the comparison slider with pointer and keyboard.
4. Fix the app: the same task gets the difference in a queued message; its check returns to waiting. The dashed Sent back receipt appears.
5. Keep it and update the design: the check passes as kept, and the same task receives instructions to change its own branch for the PR. The dashed Kept receipt appears.
6. Append `&noCapture=1` to DesignBuiltDiffers to verify that the approved design and words remain, with no empty app frame or comparison slider.

Additional resets: `http://127.0.0.1:5181/__fixture?state=fixed` and `http://127.0.0.1:5181/__fixture?state=kept` exercise answered states. No browsers are needed for the fixture's data/redirect self-test:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5181 DEPLOY_TEST_NO_BROWSER=1 DEPLOY_TEST_NO_LISTEN=1 node --import tsx docs/evidence/design-build-check/fixture-server.ts
```

For reference pairs, outside the restricted sandbox:

```sh
node design/tools/render.mjs TaskDesignCheck
node design/tools/render.mjs TaskDesignChecked
node design/tools/render.mjs DesignBuiltDiffers
# Save runtime screenshots to output/design-build-check/<Board>-<width>.png, then:
python3 design/tools/pair.py output/design-build-check/TaskDesignCheck-pair-1440.png output/design/TaskDesignCheck-1440.png output/design-build-check/TaskDesignCheck-1440.png
```

Repeat pairing for all three boards at both widths. Do not claim visual parity from this fixture until those images have been inspected.

## Known differences and unfinished copy

Keep it and update the design passes the check as Kept and tells the same task to change the board in its own branch; the board and the canvas note were changed to say so, and the footnote and the kept receipt now match them.

Fixture timestamps and commit hashes come from its temporary repository; they differ from illustrative board values. Only Designer and the build task are seeded in the sidebar. The PR's actual synthetic diff has one file rather than the board's illustrative three. Existing checkpoint rendering is retained (including its generic Passed summaries and disabled Run again action). The comparison uses real rendered HTML and capture images, not the board's illustrative inline Tally controls. It does not claim “1440 px matches” in the difference caption because the report has no per-width pass result. The who line uses the saved project display name (Tally), rather than the board’s lowercase tally. Matching reports open their supplied pairs in the shared dialog from Compare; there is no waiting decision for a match.

No browser captures or visual inspection were possible in the implementation sandbox. Binding port 5181 there also fails with `listen EPERM`; run the normal fixture command in the orchestrator's unrestricted capture environment.

## Verification results

The pnpm commands used `PNPM_CONFIG_PM_ON_FAIL=ignore` to use installed pnpm 11.25.0. Default pnpm tried to fetch pinned 11.1.3 and could not reach its registry in this sandbox. No package or lockfile configuration was changed. Node was v26.8.1.

| Check                                                            | Observed output / result                                                                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server tests: `design.test.ts`, `tasks.test.ts`, `inbox.test.ts` | `ℹ tests 62`, `ℹ pass 61`, `ℹ fail 0`, `ℹ skipped 1`                                                                                                                             |
| Web tests: `presentation.test.ts`, `design-check.test.tsx`       | `ℹ tests 10`, `ℹ pass 10`, `ℹ fail 0`                                                                                                                                            |
| `pnpm typecheck`                                                 | `$ node scripts/flight-router.mjs && tsc --noEmit`; exit 0                                                                                                                       |
| `pnpm lint`                                                      | `Design literals: no local pixel type sizes or literal colors.`; `Workspace motion: shared duration tokens and native animations.`; exit 0 (existing repository warnings remain) |
| `pnpm format:check`                                              | `All matched files use the correct format.`; exit 0                                                                                                                              |
| `pnpm build`                                                     | `✓ Done in 1.38s`; `Built dist/edge.js, dist/supervisor.js, dist/log-worker.js and workspace workers`; exit 0                                                                    |
| Fixture self-test                                                | `Fixture self-test: 5 seeded states, 3 real-route redirects, and client transform passed.`                                                                                       |
| `git diff --check`                                               | No output; exit 0                                                                                                                                                                |
| Repository `design/`                                             | No changes                                                                                                                                                                       |

Server command:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 DEPLOY_TEST_NO_LISTEN=1 DEPLOY_TEST_NO_BROWSER=1 node --test --experimental-strip-types server/v2/design.test.ts server/v2/tasks.test.ts server/v2/inbox.test.ts
```

The skipped test is the real Chromium PNG-render test. An initial run without the browser flag confirmed Chromium fails to launch in this sandbox. The preview-density test now passes without a browser: injected renderers no longer inherit an in-flight Chromium warm-up failure.

Web command:

```sh
node --test --import tsx --import ./scripts/test-css-stub.mjs app/routes/dashboard/v2/tasks/presentation.test.ts app/routes/dashboard/v2/tasks/design-check.test.tsx
```

Commits could not be created: both `git add` and `git commit` failed creating `/Users/gabrielcsapo/Documents/coding/deploy.local/.git/worktrees/deploy.local/index.lock` with `Operation not permitted`. That Git administration directory is outside this worktree sandbox's writable roots. Nothing was pushed, merged, or changed on another branch.
