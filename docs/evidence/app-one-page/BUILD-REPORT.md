# Build report: One page for an app, under its project

Changes are left in the working tree. No Git writes, commits, pushes, deployment, or edits to `design/` were performed. Read `AGENTS.md`, `app/AGENTS.md`, `design/README.md`, all nine specified boards and canvas note `projects-live-link`.

## 1. App page under its project

- Reused the existing Live detail as `AppDetail` on project app Overviews: title/status, meta, provenance, Health, In this release, worker chart and Latest error. Removed its extra tab row and head Logs button; kept the rollback action.
- Added Projects › project › app breadcrumbs; single-app projects stop at the project. Project paths select the existing Projects sidebar item.
- Legacy `/dashboard/live/:app` replaces its location with the project app URL. A nested one-app Overview replaces its location with the project root. Standalone/Discover `app:<name>` projects are supported, including encoded dots and spaces.
- Files: `app/routes/dashboard/v2/live/page.client.tsx`, `projects/app.client.tsx`, `projects/page.client.tsx`, `projects/routing.ts` (all web paths in this report are below `app/routes/dashboard/v2/`).
- Tests: `projects/routing.test.ts` passes; typecheck and build pass.
- Board interpretation: the separate `OneAppProject.html` specifies the compact web-app Overview with Restart/Open, so that existing variant is retained for single web apps. Multi-app app pages and workers use the Worker health/provenance layout. This resolves the tension between numbered item 1's general Live-detail instruction and the one-app board without inventing a combined layout.
- Existing data limitations retained from Live: the health contract does not carry the board's queue target, heartbeat interval, process explanation, per-app changed-code annotations or migration application time. The UI uses real measurements, generic sibling kinds, and migration reversibility. Its chart is percentage history, with the existing summary rather than a fabricated release-onset annotation. The existing Open logs link beneath Latest error remains. Missing repository/source/history information remains unavailable rather than being invented.

## 2. App tabs

- Multi-app web app: Overview, Requests, Releases, Logs, Settings. Worker: Overview, Releases, Logs, Settings.
- Releases points to the project release page with `?app=`; that context persists across release selection. Logs points to the project log page with `?app=` and filters to that app. Both pages keep the app tab row when entered in app context.
- Single-app pages retain the board's project extras (Code, conditional Pull requests/Issues, existing pipeline tabs) and its Releases-before-Requests order. The Settings tab opens app settings; the existing Project settings link still opens shared project configuration. Releases remains available before the first release.
- **Performance is omitted:** there is no existing route. No Performance page or dead link was added.
- Files: `projects/routing.ts`, `projects/page.client.tsx`, `releases/page.client.tsx`.
- Tests: routing tests cover web/worker tabs, encoded scope, absence of Performance, and single-app work tabs; all pass.
- AppSettings/AppRequests changes are scoped to navigation. Existing settings controls and request data handling are retained; the settings implementation still lacks the board's domain-management/removal controls and resource selectors. Those were not built as unrelated features.

## 3. Live links

- Changed app-name links, Open worker, stopped-app names and sibling-app links to the project app destination. Kept the Live table, project/release links, decisions and health wording intact.
- Files: `live/page.client.tsx`, `projects/routing.ts`. The existing Live status wording was extracted into `live/presentation.ts` for reuse.
- Tests: routing and presentation tests pass. Visual capture is blocked by the sandbox; no visual-parity claim.

## 4. Projects health

- Aggregates the Live response already used by Projects; no additional health checks or health model. Shows counted failures, warning labels including High memory, Not running when all received apps are stopped, or Healthy. No status for a project with no apps or without received health data.
- Non-memory warnings retain Live's existing wording (Learning baseline, Report overdue, Queue delayed, Checks unavailable), rather than falsely reporting High memory. Failures take precedence over warnings; a stopped sibling does not make a running healthy app “Not running.”
- Files: `projects/page.client.tsx`, `live/presentation.ts`, `live/presentation.test.ts`.
- Tests: health aggregation cases pass. Uses existing Status/dl-status tones.
- Board difference outside the requested health change: the existing web Projects list has no Active/Maintained/Done sections or care/proposal copy; those remain unchanged. No stage data was invented.

## 5. Project Running section

- Copy now ends exactly: “Open an app for its health, releases, logs and settings.” Shared release/source/time context remains when available. App rows open the app under its project.
- Files: `live/presentation.ts`, `projects/page.client.tsx`, `live/presentation.test.ts`.
- Tests: shared-release, mixed-release and empty-data subtitle cases pass.

## 6. One-app projects

- `single` depends only on having one app. Tasks, PRs and issues no longer turn the project root back into a project summary. PR and Issues tabs remain; the “get their own tabs once there are some” note is hidden when those records already exist.
- Preserved the compact single-web-app Overview and Restart/Open actions; single workers use the health detail. Nested Overview links canonicalize to the project root.
- Files: `projects/page.client.tsx`, `projects/app.client.tsx`, `projects/routing.ts`, `projects/routing.test.ts`.
- Tests: tab regression case includes open PRs/issues and no releases; passes. Capture fixture also has a single app with task, PR and issue records.
- Existing OneAppProject gaps retained: no memory-usage measurement exists in the Live contract, so the existing request-rate/latency metrics remain; the existing Runtime and Recent releases groups are retained instead of the board's Memory stat and creation/release “Recent” feed. Existing Add an app action remains. No creation event or uptime was invented.

## 7. Running release Output

- Added owner-scoped `GET /api/releases/:id/output` returning `{ output }`. It first checks ownership of the release, then resolves only that owner's upload/build-log pairing. Existing agent/worker restrictions remain.
- Reads at most 64 KiB from the file, retains at most 200 lines, handles UTF-8 boundaries and missing files, and closes file handles. Does not read an entire large build log into memory.
- Running releases poll every two seconds; Output is absent until text exists. Shows an existing Group and Term with a quiet Full log link to project logs, retaining app scope. Polls abort on unmount; terminal releases show their existing result view.
- Files: `server/v2/releases-api.ts`, `server/v2/release-build-log.ts`, `server/v2/release-build-log.test.ts`, `releases/page.client.tsx`.
- Tests: mapping, missing output/file, appended output, owner isolation (including colliding pairing records), missing releases, agent restriction, line/byte bounds, and UTF-8 tail; all pass.
- Board limitation: releases without a build-log mapping (including some PR-started releases) have no Output group, as required for no output. Other existing release layout/copy remains unchanged; no new stop-activation control or deployment steps were invented.

## 8. iPhone app inside Projects

- Live taps, notification/deep-link app opens and WorkerPhone fixture navigation select Projects and push the project followed by its app. Project app links use the same navigation destination. Removed the worker's nested NavigationStack/Done dismissal, so Back returns to its project.
- Added App beneath Health with a Releases row opening the existing project release screen; uses real release/time metadata.
- **Logs and Settings rows are omitted:** no existing native app logs or app settings screens exist. The existing noninteractive project log description is not treated as a screen.
- Files: `V2Root.swift`, `V2Places.swift`, `V2Projects.swift`, plus `DeployCore/V2/V2AppPresentation.swift` (full paths below).
- Swift compilation and simulator navigation are deferred to the orchestrator, as requested. No Swift build was attempted. UI files retain their `#if os(iOS)` guards.
- Other existing WorkerPhone differences remain: health uses existing native measurement wording/icons; sibling release rows do not show the board's migration row because `V2LiveDetail` does not expose release migration contents. No new migration data API was introduced.

## 9. iPhone Projects health

- Added an optional status at the right of the existing project title line. Uses the same aggregation, wording and existing HealthState tones as web; no status for empty projects. Projects refresh now also refreshes Live.
- Files: `V2Components.swift`, `V2Places.swift`, `V2Root.swift`, `DeployCore/V2/V2AppPresentation.swift`, `Tests/DeployCoreTests/V2AppPresentationTests.swift`.
- Added Swift tests for health words/tones, failure counts, stopped/mixed apps, memory/baseline warning and fallback project identity. Written but **not run**; orchestrator must run them.
- As on web, existing list structure/care summaries remain; no Active/Maintained/Done UI was added beyond the requested health status.

## Every changed Swift file

All paths below are relative to `native/Apple/Packages/DeployKit/`:

- `Sources/DeployUI/V2/V2Root.swift`
- `Sources/DeployUI/V2/V2Places.swift`
- `Sources/DeployUI/V2/V2Projects.swift`
- `Sources/DeployUI/V2/V2Components.swift`
- `Sources/DeployCore/V2/V2AppPresentation.swift` (new)
- `Tests/DeployCoreTests/V2AppPresentationTests.swift` (new)

## Validation and capture status

- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS, with repository lint warnings; design literals, motion and native token parity checks pass.
- `pnpm build`: PASS, including client/server and server extras.
- `node --test app/routes/dashboard/v2/live/presentation.test.ts app/routes/dashboard/v2/projects/routing.test.ts server/v2/release-build-log.test.ts`: PASS, **11 tests**.
- `git diff --check`: PASS.
- `node --check docs/evidence/app-one-page/fixture-server.mjs`: PASS.
- Swift syntax parse of all six changed files: PASS with `swiftc -frontend -parse -target arm64-apple-ios18.0-simulator` (toolchain warns its default sysroot is macOS; this does not typecheck SwiftUI or replace an iOS build).
- No full `pnpm test` run. No iOS build or Swift tests run.

The installed pnpm is 11.25.0 and Node is 26.8.1. Plain pnpm initially stalled attempting the repository-pinned package-manager download. Successful pnpm checks used the process-only environment `pnpm_config_pm_on_fail=ignore`; no package, lockfile or pnpm config was edited. The normal typecheck script built the missing local react-flight-router outputs. An initial direct test run exposed an existing extensionless import and late test import ordering; both were fixed before the passing run.

The sandbox rejects listening on 127.0.0.1:5180 (EPERM), so browser flow checks and 1440/700/390 visual comparisons remain for the orchestrator. No screenshots or false parity evidence are supplied. `captures.md` lists startup, URLs, fixture limitations and native navigation checks. New capture support is in `docs/evidence/app-one-page/{fixture-server.mjs,fixture.client.tsx,fixture-router.tsx}`; it serves real components against synthetic in-memory APIs only. Both this report and `captures.md` are untracked.
