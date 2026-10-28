# Slice 3 · Task, pull request and Ship

Branch: `codex/v2-task`. This follow-up inspected all 22 orchestrator-provided pairs, board
left and implementation right, for Task, TaskChanges, TaskChecks, Review, PullRequests,
FirstTask, TaskStalled, TaskFailed, NewProduct, LongChat and ShipDialog at 1440 and 700.
The brief, design README, design-system README, board markup and component CSS were read.
No design source, schema, live service, other worktree or installed app was changed.

## Screenshot review fixes

- **ShipDialog:** fixed the shared native Dialog's positioning explicitly: fixed inset,
  automatic margins, intrinsic height, responsive width and the dimmed native backdrop.
  The CSS reset had removed the browser's default centering. Kept `showModal`, native focus
  containment, Escape, backdrop dismissal and focus restoration. Its body now spaces the
  introduction, settings and steps like the board; Ship uses the board's 560 px maximum.
  Who can open it is the Just me / Everyone at home segmented control when access is known.
- **Task / NewProduct:** Ship… is a bordered button. Chat / Changes / Checks use the board's
  segment, followed by state, stored checkpoint number and short elapsed/relative time.
  The task snapshot now supplies checkpoint count/time and the run's actual update time.
  Update from main is visible, with its unavailable reason. The ⋯ menu offers Refresh task
  and Open project. The panel has a Close action and the conversation shows Waiting for your
  answer only while one of its actual inbox decisions is still waiting.
- **This task:** removed the long individual-file list. Work shows the actual file count,
  summed additions/removals and Changes link, then checks passed and what ran. Screenshots
  show their count and request time if stored, otherwise their capture time. Releases shows
  None yet / Ship it whenever you are ready, plus the explicitly requested panel Ship action.
  Started uses relative time and stored provenance when supplied. The board's row order is
  preserved; associated pull requests and their merge state follow those rows. Failed detail
  fetches say unavailable rather than inventing zero changed files or passed checks.
- **Dates:** `app/routes/dashboard/v2/data/time.ts` formats relative, elapsed, clock and local
  calendar labels. Task headers/panels, check durations, PR rows, reply attribution,
  conversation day headings and the shared InboxDecision use it. No raw locale timestamp
  remains on these screens. Tests cover local midnight, year boundaries, daylight saving
  dates, future timestamps and invalid/missing values.
- **TaskChanges:** tightened the inset and file-column proportions, and shared Diff headers
  now show real additions/removals. Both change/check sections expose Publish pull request.
- **TaskChecks:** grouped rows under the checkpoint heading, added commands, short measured
  durations and status-colored icons. First check output is visible below the group; selecting
  another check changes the output. Run again is visible with its unavailable reason.
- **Review:** added reply author/time attribution and PR identity in the header. The unified
  panel includes this version's check results and linked PR status.
- **PullRequests:** added New task, an open count, compact inline Search, shorter row spacing,
  elapsed update times and chevrons. The capture URL uses `deploy%2Elocal` to avoid Vite's
  dotted-segment 404.
- **FirstTask:** restored the muted teaching surface, lightbulb and highlighted first step.
- **TaskStalled / TaskFailed:** header/state now says Paused / Stopped; dates use the same
  short forms. Stored work and decisions remain available with the existing recovery banners.
- **LongChat:** earlier-day rows are rounded disclosures, use Today / Yesterday / weekday /
  short-date labels, and correctly singularize event counts. Decisions never fold away.
- **Screenshot gallery:** preserves the phone/laptop aspect ratios in one horizontally
  scrollable row. The fixture now has three distinct SVG assets made from the board's sample
  app markup, not three copies of a landscape placeholder. The product fixture supplies a
  real 14-file, +612/−0 patch and three passing checks so its panel can match the board.

## Deliberate differences and remaining integration, per board

These differences are intentional; they are not claims of post-fix screenshot verification.

- **All task boards:** work logs initially fold, as required by the brief and the original
  slice task, although the boards expose their steps. Shared inbox cards retain their agent
  attribution, real answer provenance and answer input where applicable. Shared shell/sidebar
  content comes from one fixture account, so the list of tasks/decisions differs between the
  boards and these captures. Live now uses the board's failing fixture state. Disabled
  controls have real disabled styling and explanatory titles. Unavailable actions are never
  simulated with a successful no-op.
- **Task:** Ship remains available when a project source can be resolved, even though this
  board's header does not show it. Update from main has no coordinator command on this base,
  so its visible control is disabled. Checkpoint metadata comes from stored checkpoints only.
- **TaskChanges:** file totals come from the actual patch; the release fixture contains two
  files, not the board's four-file inventory. Binary/rename/new-file metadata stays visible.
  View file is omitted until an authoritative file-view route exists. Publish pull request
  and Update from main are disabled because this slice has no matching command endpoints.
- **TaskChecks:** Passed comes from check status, not a test count parsed from terminal text.
  Durations appear only with timestamps. Output is selectable; only one check's output is
  shown at a time. Run again is disabled because task and pipeline checks need different
  admission commands. PR checks still match the displayed commit; old green runs never count.
- **Review:** keeps Chat/Changes/Checks and This task as required by the unified-page brief.
  Author/time comes from the typed reply, without inventing a reviewer model, opened time,
  conflict-free status or combined merge-and-release guarantee. Merge only uses the existing
  revision/base/head-checked command. A merge decision appears only when an inbox producer
  supplies one (the fixture supplies one in memory). The board's automatic rollback promise
  is not independently generated by this UI.
- **PullRequests:** no guessed issue/app/release tabs or counts, reviewer identities, check
  totals, release IDs or Ready to merge claim. Rows use actual source/target branches and
  update times. Counts describe loaded records, not unseen pages. Imported historical PRs
  without task associations remain disabled because the current API cannot link them.
- **FirstTask:** teaching dismissal remains browser-local and appears only for the account's
  first task. Shared sidebar contains the whole fixture account rather than an empty account.
- **TaskStalled / TaskFailed:** retain the unified section bar and failure banner. No invented
  offline time, heartbeat age or recovery command. Move/retry decisions are rendered when
  supplied by the inbox; their production producers still belong to later work.
- **NewProduct:** screenshot taking/markup belongs to slice 6. The local task read type accepts
  optional `requestedAt` on stored screenshots; without it the panel says Taken at, not Asked
  for at. The fixture includes request time. Browser/capture computer, project creation,
  commit count and model usage are not claimed without metadata. `startedBy` / `startedFrom`
  are optional provenance; the fixture supplies “you” / “From New task, no agent”, while the
  production snapshot leaves absent provenance unavailable. The empty Releases row and panel
  Ship are retained per this follow-up's explicit requirement. There is no projectless-task
  product-creation workflow in this slice.
- **LongChat:** runs in the task fixture because the agent route and Tracking panel belong to
  the agent slice. Agent search/filter controls and aggregate briefs/shipped summaries are
  not invented. Calendar headings and counts describe stored events.
- **ShipDialog:** access segments are read-only/disabled. The agreed POST remains exactly
  `{ source: { kind: 'ship', ref } }`; it cannot save access or placement. An authoritative
  release-plan/settings API is still needed. Production says unavailable when preview data
  is absent. The fixture supplies SER, address, household access and Postgres. Unsupported
  free memory, certificate issuer, commit count, new-data guarantee and Warden assignment are
  omitted; the dialog says Project configuration and Watch the release for 10 minutes.
  Native close-button focus is visible on opening. It ships a published PR branch or actual
  project default branch, never silently treating the task's initial baseline as its edits.

The shared contracts were not changed. Whole-project release admission, combined merge/release,
first-message-to-running product creation and historical PR/task linking remain backend work.

## Recapture status and reproduction

**The checked-in paired PNGs and `captures/` are the orchestrator's pre-fix evidence. All were
opened individually in this follow-up. No post-fix captures were produced in this sandbox.**
The required `capture-all.mjs` was attempted after the fixes against the fixture and Vite.
Chromium failed before opening a page with `bootstrap_check_in … Permission denied (1100)`.
See `capture-error.log`. No computer-use or desktop-browser fallback was used.

```sh
node docs/evidence/v2/3-task/fixture-server.mjs
DEPLOY_DATA_DIR=/private/tmp/v2-task-preview-data DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5188 pnpm exec vite --host 127.0.0.1 --port 5187 --strictPort
node docs/evidence/v2/3-task/capture-all.mjs
```

`captures.md` lists every exact URL, width and height. `capture-all.mjs` calls the prescribed
capture tool and pairs each result, board left. ShipDialog opens through `#ship`; capture does
not ship. `TASK_SHIP_UNSUPPORTED=1` exercises the missing-engine error. Fixtures have no
coordinator/database/worker/Docker imports; mutations stay in memory. Dates are relative to
fixture startup, so wall-clock labels naturally vary. The SVG fixtures preserve the board's
sample-app styling, independent of the production app.

The orchestrator must inspect all regenerated pairs and check modal centering, dimming,
scrolling, Tab containment, Escape and focus restoration at both widths before visual sign-off.
HTTP fixture checks are not a substitute for browser verification. Vite's existing SSR icon
JSON parse warning still falls back to client rendering; the production build passes.

## Validation

- `pnpm install --frozen-lockfile`: passed.
- `pnpm typecheck`: passed (`typecheck.log`).
- `pnpm lint`: passed with warnings, no errors (`lint.log`).
- `pnpm format:check`: passed (`format.log`).
- `pnpm build`: passed (`build.log`).
- Focused `node --test`: **29 passed, 0 failed** (`focused-tests.log`), covering server task/API,
  task commands, real Conversation rendering, event folding and the new time formatter.
  The task snapshot test additionally verifies checkpoint count/time and owner isolation.
- Full `pnpm test`: **654 tests; 626 passed, 4 failed, 11 cancelled, 13 skipped**, exit 1
  (`full-suite.log`). The four failures match earlier slices: two certificate assertions in
  `ca-profile.test.ts`, Home Assistant readiness in `catalog-api.test.ts` with Docker disabled,
  and the Linux `/proc/self/fd` assumption in `legacy-preserving-update.test.ts` on macOS.
  `server/api.test.ts` cancelled eleven auth cases after its child server hit a test-port
  collision, repeatedly tried a forbidden fallback port and exhausted its heap. All v2 tests
  passed. This is not a green full suite. Consecutive repeated log lines are explicitly
  compressed in the evidence log; the unabridged run was saved in `/private/tmp`.
- Full-suite isolation used temporary data and a failing fixture docker executable, unavailable
  Docker socket, and `../1-inbox-api/test-guard.mjs` to restrict listeners to 5180–5199.
  Only this follow-up's fixture/Vite preview processes were started and stopped. No live
  service, worker, container or app was stopped, restarted, reconfigured or released.
