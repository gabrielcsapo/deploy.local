# Slice 2 · Live and health

Branch: `codex/v2-live`. References inspected: Live, LiveDark and Worker, their exact HTML and
bundle CSS, and all six 1440/700 PNGs. The v2 brief takes precedence over the older general
application design guide. Design sources, the shared sidebar and the database schema are unchanged.

## Implemented

- Owner-scoped Live list/detail APIs, typed health events on the existing long-poll feed,
  configured HTTP checks, request metrics/history, memory warnings, measured restart deltas,
  computer online state, and explicit missing-evidence states.
- Worker reporting through existing app CI tokens, assigned-computer credentials, or owner
  sessions, plus the importable `server/v2/health-report.ts` helper. Counts/history/baselines use
  existing generic workspace records, with no migration. The exact rule and integration are in
  `server/v2/README.md`: measured baseline, strict >10% and >5×, two continuous minutes.
- Warden rollback decisions for a failing worker in a project release's first hour, with stable
  project/release IDs, first-answer-wins and an honest unavailable response if execution is absent.
  `publishInboxItem` and `registerInboxAction` are minimal extensions to the base inbox module,
  which otherwise only knew question and control producers. The crash tracker gets a read-only
  delta accessor; existing collection behavior is unchanged.
- Both Live routes now render real API data through v2 components, with loading/empty/error
  states, retry, long-poll updates and a 15-second refresh. Live groups running apps by computer;
  Worker shows jobs, queue, process evidence, heartbeat, project release context and real history.

## Parity status: blocked, not verified

**No implementation screenshots or side-by-side PNGs could be captured.** Do not treat these
screens as visually signed off. Headless Playwright Chromium failed at startup with
`bootstrap_check_in ... Permission denied (1100)`. Computer Use inventory had no browser
providers; selecting Chrome returned `cgWindowNotFound`, and creating a Chrome tab returned
`Browser is not available: chrome`. The attempted Finder fallback was rejected by automatic
approval review: Computer Use was not approved to use Finder. No permission bypass was attempted.

Both URLs returned HTTP 200 through Vite on 5187, using the fixture API on 5188. This verifies
route loading, not browser rendering. The dev server reports the pre-existing
`workspace-icons.json?ssr` parse issue and falls back to client rendering, as the foundations
notes describe. The production build passes. Keyboard, scrolling, recovery interactions and
light/dark browser parity remain unverified.

`fixture-server.mjs` contains the board's seven apps, SER, bazzite, home-gym, Warden decision,
stopped recipes, resource values and job history. It is isolated evidence tooling and is never
imported into production. To finish capture, with both ports free, run in separate terminals:

```sh
node docs/evidence/v2/2-live/fixture-server.mjs
DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5188 pnpm exec vite --host 127.0.0.1 --port 5187 --strictPort
```

Capture `/dashboard/live` at 1440×1100 and 700×1100 in light and dark, and
`/dashboard/live/home-gym-sync` at 1440×1000 and 700×1000. Use browser theme emulation for dark.
Save implementation captures in `captures/`, then pair against the corresponding board using
`design/v2/tools/pair.py`. Stop both test processes afterward. No live credentials are required
or used. The fixture's Not now action affects only its in-memory test decision.

## Deliberate differences from the boards

These are implementation decisions, not claims of screenshot-verified parity:

- The shared shell/sidebar remains owned by the Inbox screens slice; its base fixture state is
  not replaced here. Header search/more controls are omitted because these routes have no such
  actions. The shared Approval uses its decision glyph instead of the board's Warden avatar;
  the text explicitly attributes the decision to Warden.
- Role labels use the fixed vocabulary “Take tasks” and “Run apps”, rather than “Takes tasks”
  and “runs apps”. App metadata does not invent “from Discover” when the contract lacks it.
  Production addresses follow current routing (`https://<app>.local`); fixture addresses match
  the board. Unknown releases/resources/traffic are unavailable, not fabricated zeroes.
- Rollback links open the project's release review. They do not call a missing rollback API or
  perform a legacy per-app rollback. Not now uses the shared inbox answer API. Error text and
  unavailable/retry states are real rather than board-only decorative controls.
- Not running rows open health details; there is no Start button in this health-only slice.
  Folder/process glyphs reuse the currently available v2 primitives. No new icon system is added.
- Worker Jobs uses the server's plain-language summary and measured baseline, without inventing
  a SQL error or “usually” statistics. Queue omits an unsupported usual drain time. Process
  shows measured restarts or Unavailable, not an unsupported running claim. Heartbeat omits the
  board's assumed 10-second interval because reporting accepts 10–60-second windows.
- The release section lists actual project apps and links to release/migration review. Migration
  0042, its reversibility, renamed columns and rollback effects are not in the health contract,
  so none are manufactured. Settings, Logs and Releases links appear only with a project.
- History plots measured completed/failed **percentages**, clearly labelled, rather than
  suggesting unsupported absolute counts. It shows an unavailable state without enough samples.
  Latest error links to project logs; no example stack trace is shown as real runtime data.
- The existing AppHealth `http` object requires status, p95 and request rate together. It is
  omitted until real request p95 exists; a successful check can still appear in the summary.
  Likewise `jobs` is omitted during baseline learning rather than representing unknown as zero.
  No existing shared type was changed to weaken this contract.

## Validation

- `pnpm install --frozen-lockfile`: passed; tracked pnpm cache database restored.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with warnings, no errors (including a local no-shadow warning).
- `pnpm format:check`: passed.
- `pnpm build`: passed.
- `node --test server/v2/health.test.ts server/v2/live.test.ts server/v2/api.test.ts`:
  **25 passed, 0 failed**. See `focused-tests.log`. Includes real HTTP shapes, app/computer auth,
  owner isolation, report validation, measured baseline thresholds, gap/reset/stale behavior,
  crash deltas, p95 honesty, runtime guards, Warden deduplication and inbox answer integration.
- Final `pnpm test`: **648 tests; 620 passed, 4 failed, 11 cancelled, 13 skipped**, exit 1.
  `full-suite.log` retains output. Failures match the previous slices' recorded environment issues:
  two `ca-profile.test.ts` assertions (system OpenSSL verification flags and expected exception),
  Home Assistant readiness in `catalog-api.test.ts` with Docker unavailable, and
  `legacy-preserving-update.test.ts` reading Linux `/proc/self/fd` on macOS. The application API
  suite's 11 tests cancelled after its startup fetch failed with `UND_ERR_SOCKET` on an isolated
  test port. No v2 test failed. The earlier run, before five added regression cases, had
  615 passed, the same 4 failures, 11 cancellations and 13 skips.

Full-suite isolation uses temporary `DEPLOY_DATA_DIR`, an unavailable Docker socket and a
fixture-only docker executable returning failure. The existing evidence preload
`../1-inbox-api/test-guard.mjs` restricts TCP/UDP listeners to 5180–5199 and bounds test files.
This constraint affects the test environment; a non-green suite is not claimed as passing.
No live coordinator API, service, worker, container or installed app was changed.

## Next slice

- Releases: call `recordLiveRelease` at whole-project activation, with project ID/name, release
  ID, actual activation time and app names. Register the `rollback` decision's durable enqueue
  through `registerInboxAction`, sharing admission/current-release checks with the project
  rollback POST API. Until then the action returns 501 and stays waiting. Project release
  metadata is deliberately not guessed from legacy per-app deploy history.
- Inbox/sidebar: consume `summary` from `/api/live` and health events. Existing sidebar is
  untouched by this slice. A worker must first establish a measured baseline; absent baseline
  stays Warning. The task's exact two-minute rule overrides the brief's one-minute statement.
- Worker authors: send non-overlapping 10–60-second deltas using the documented helper. No
  changes to existing job execution loops or installed apps are needed by this patch.
- Finish the blocked browser checks and six paired screenshots before accepting visual parity.
  Multi-component HTTP admission, HTTPS-only probes, and migration/raw-error details need their
  own authoritative APIs; this slice reports missing evidence rather than inferring them.

The two preview processes on 5187/5188 were stopped after verification. No other listeners
were stopped. All changes are committed locally; nothing was pushed, merged or rebased.

## Visual review (added by the orchestrating session)

Captured with Playwright Chromium against `fixture-server.mjs` and Vite on 5187/5188, paired with `design/v2/tools/pair.py` (board left, implementation right): `Live-1440.png`, `Live-700.png`, `Worker-1440.png`, `Worker-700.png`; raw captures in `captures/`. Dark theme was not captured.

- **Live** matches in structure, grouping by computer, health words, traffic and release columns, and the Not running group. Differences to polish:
  - Warden's decision card uses the generic attention icon, where the board shows Warden's avatar.
  - Immich reads "Warning" where the board says "High memory". The state word should name the cause.
  - Not running has no Start action.
- **Worker** matches the layout. Differences to polish:
  - The health rows use neutral icons. The board marks each row by state: failed in red, running/restarting with the warning refresh, ok in green.
  - The comparison column reads "Baseline 1%" where the board says "Usually under 1%".
  - The release block lacks the migration row and the release title, which needs release metadata from the releases slice.
  - Latest error is a link to logs instead of the last error lines.
