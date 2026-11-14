# Slice 4 · project releases and rollback

This is a coordinator implementation with explicit remaining gaps, **not a declaration that slice 4 is complete**. No live coordinator, worker, service, container or installed app was changed. All databases used for validation were temporary. The isolated UI fixture and Vite processes on 5195 and 5196 were stopped.

## Implemented

- `server/v2/projects.ts` is the membership projection. It reads workspace projects and the same `repositoryInfo().deployment.application` relation used by `/api/application-repositories`. Unlinked apps become stable `app:<application name>` projects. IDs take precedence over names; duplicate names require IDs. Ambiguous app membership is rejected. A worker classification comes from its active graph, not a guessed name.
- Project releases, current pointers, activation ancestry, runtime receipts, backups, rollback records, approval rules and exclusive project runs use the existing workspace `records` table. No coordinator schema migration is needed. Events are persisted alongside progress changes. Records remain owner scoped.
- All requested v2 routes are present. Additional `GET /api/projects/:project/rollbacks` supplies history after reconnect. Starting a release ignores a supplied `startedBy` and records the authenticated username. Agent/worker credential headers are refused by both the v2 router and upload entry point.
- The engine enforces prepare → verify → activate → watch, verifies complete project membership, reserves all apps, returns 409 for overlapping releases/rollbacks, takes required backups before activation, and maintains actual activation ancestry across failed attempts and rollbacks. `DEPLOY_RELEASE_WATCH_MS` configures the default ten-minute watch.
- The coordinator adapter reuses the graph executor, Docker health probes and backup module. It freezes source trees (or a requested committed repository ref), builds all components, retains image digests, verifies on isolated networks and copied volumes, requires a sustained process plus a health signal for workers, stages every app, and commits app routes/endpoints together. It quiesces the project during activation; this is not a zero-downtime claim. A staging failure restores the old processes and route set. Old images/source receipts are retained for rollback.
- Ordinary graph uploads now call the project engine, leaving existing source/archive and CI admission intact. The change to `server/api.ts` is confined to imports, admission, a small execution branch and preserving runtime status when Verify fails. CI admission also refuses an active project run. The old single-app execution/revert block remains for compatibility paths.
- Lifecycle jobs have no reverse command in the existing manifest contract, so they are conservatively irreversible. The adapter takes cold pre-release backups through `application-backups.ts`. Rollback verification can use those backup archives. A restore requires the precise `confirmBackupId` returned with HTTP 409 and a `dataLoss` object describing affected apps and cutoff. An allow rule never silently authorizes that data loss. Unknown reverse operations are refused; the existing component-profile logical rollback is the supported reverse-operation hook.
- Warden defaults to a native rollback InboxItem. `mode: never` forbids it; only a matching unrestricted `warden` / `rollback` / `allow` rule permits it automatically. Project rules override global rules. Free-text limits are not interpreted as authorization. Decisions share first-answer-wins semantics with the inbox; starting a replacement release or rollback withdraws obsolete pending rollback decisions. Watch/migration failures after activation request rollback through this gate.
- Release list/detail routes use the v2 primitives, fetch real data and long-poll typed events. They show live/progress/failure states, whole-project rollback confirmation, exact backup/data-loss confirmation, and a rule-attributed rollback report. Loading, empty, disconnected and missing-release states are included.

## Remaining work and operational limits

- **Remote computers are not supported by this adapter.** The existing remote command path has per-app deploy/backup actions, not isolated project staging and a project activation barrier. Remote placement returns a visible failed Prepare before runtime activation. Completing this needs worker protocol changes outside the files assigned to this slice.
- **Host-bound/privileged graphs are refused**, including host networking, external/bind resources, devices, Docker socket access and extra Docker networks. Those cannot be isolated by the available copy/health machinery. No fallback silently deploys one app.
- **The existing repository relation declares one application per repository.** The projection and engine support multiple app links and are tested with two apps, but the current repository manifest/API cannot author those multiple links. A later ownership/schema decision is needed to express the two-deployment home-gym fixture through the existing relation. Components inside one application graph are handled together today.
- **General reversible migration metadata is absent.** The existing schema records job execution and profile operations; it does not provide arbitrary down commands. This change does not invent a new deploy.yaml dialect or claim to reverse migration 0042 without an actual registered operation. Ordinary jobs require backup restore. Profile-version upgrade admission remains owned by the existing profile workflow; project releases do not synthesize that upgrade.
- **Legacy-preserving/adoption paths that return early from upload retain their existing behavior.** They are not all converted to project releases. Catalog/reconciliation paths outside the allowed file scope are not rebased here.
- **Crash recovery is fail closed.** A project-run reservation survives process exit. It is not stolen on a timeout. There is no operator recovery endpoint for these reservations yet. A partially failed data restore also retains the reservation. Recovery must inspect runtime/data receipts before releasing it.
- **Cross-path fencing needs expansion.** The new project API and upload/CI admission reject active project runs, but unrelated legacy runtime mutation routes do not share the project reservation. The upload source-admission check and project-run reservation are not one transaction across the two databases. A complete system-wide mutation fence is still needed before treating this as production-ready project atomicity.
- **First-release adoption has no synthetic prior Release.** Rollback requires a complete prior project receipt; an old per-app build is not invented as one. Source/image retention currently has no pruning policy.
- The legacy CLI upload receipt completes after Watch. Its default 600-second wait may expire before a ten-minute Watch plus build finishes. Use a longer `--wait-timeout`; a later CLI change should follow the project release ID/events directly.

## Design references and deliberate differences

Read the brief, both design READMEs, the four named board sources, and their 1440/700 renders. `design/v2` is unchanged.

- Releases keeps the project header, tabs, narrow release navigation and detail column. At 700 the list stacks above the detail and retains the board's narrow navigation width.
- The frozen Release contract has no separate PR title, task ID, app computer assignment or log lines. The page uses `source.ref` as its title, `startedBy` as attribution, and actual step details as the log. It does not fabricate a PR author, task notification, computer, elapsed duration, successful job count or stack trace.
- Tabs with unavailable counts (Pull requests and Issues) are omitted. Apps links to its first app because no project app-list route is registered. Project settings and full logs link to their existing route placeholders.
- The reference's Stop before activating, Ask Scout to fix it, and automatic Undo actions have no implemented contracts; they are omitted rather than presented as working controls. The failure banner says Nothing changed only if Activate was skipped. A migration/Watch failure does not make that claim.
- AutoRollback is a **Live board**, whose page is owned by the parallel Live slice. This slice puts the rule-attributed report in release detail and exposes rollback history/events for the Live owner to render the board's banner. The Live table and Undo flow are not implemented here.
- The sidebar remains the foundation slice's fixture shell; this branch does not edit the sidebar owned by the Inbox slice. The release row uses the existing send icon because the shared v2 icon set has no rocket.

## Visual evidence blocker and reproduction

**No implementation screenshots or side-by-side pairs were produced. Visual parity and keyboard/scrolling checks remain unverified.** Native Chrome and Safari access both returned `cgWindowNotFound`. Headless Chrome, using the already-installed official browser, aborted under the sandbox (`SIGABRT`; its cleanup also reported `EPERM`). No approval escalation was available. No substitute screenshot is represented as implementation evidence.

`fixture.mjs` serves the four board states without a real coordinator. `capture.mjs` captures the actual React routes at both widths when browser execution is available:

```sh
node docs/evidence/v2/4-releases/fixture.mjs
DEPLOY_DATA_DIR=/tmp/v2-releases-ui DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5195 pnpm exec vite --host 127.0.0.1 --port 5196 --strictPort
node docs/evidence/v2/4-releases/capture.mjs
```

Then pair each image with its board using `design/v2/tools/pair.py` and review all differences. The fixture ports must be free, and both processes must be stopped afterwards.

## Validation

- `pnpm install --frozen-lockfile`: passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with warnings, no errors.
- `pnpm format:check`: passed.
- `pnpm build`: passed.
- `node --test server/v2/releases.test.ts server/v2/releases-runtime.test.ts server/v2/api.test.ts server/ci-releases.test.ts`: 41 passed, 0 failed; see `targeted-tests.txt`. The graph-runtime tests use the real executor and database with a fake Docker transport; no Docker processes are created.
- Full `pnpm test`: **656 tests; 639 passed, 4 failed, 13 skipped, 0 cancelled**. See `test-results.txt`. The failures match prior evidence: two unchanged `ca-profile.test.ts` assertions under system LibreSSL; Home Assistant readiness in unchanged `catalog-api.test.ts`; and the Linux `/proc/self/fd` assumption in unchanged `legacy-preserving-update.test.ts`.
- The full suite used temporary data directories and a temporary Node preload limiting every listener to 5180–5199. Initial concurrent attempts collided with other slice listeners; the final recorded run used serial file execution and skipped those occupied preview ports. The preload is not part of the application. Touched tests were rerun after the final recovery/backup adjustments.

## Integration for the next slice

Import `projectReleaseService` from `server/v2/releases-api.ts` to request Warden rollback via `requestAutoRollback(owner, project, reason)`. Do not invoke runtime rollback directly. `rollbackRule` and the service enforce the rule gate again at execution admission. Native rollback decisions use `createInboxItem`/`registerInboxAction`; clients should surface a returned `dataLoss` review and then send `confirmBackupId` only after an explicit restore choice. API projections never include the private source/runtime/backup execution receipts.

The server and web event union now includes `{ type: 'release', release }` and `{ type: 'rollback', rollback }`, with the existing cursor envelope. The Inbox and Live owners should merge the small additive inbox/events changes before wiring these states. The backup review and project-run recovery paths need end-to-end review before deployment.

## Visual review (added by the orchestrating session)

The four board states were captured with the fixture and Vite on 5195/5196, then paired with their boards (board left, implementation right) at 1440 and 700: `Deployments`, `ReleaseLive`, `ReleaseFailed` and `AutoRollback`. Raw captures are in `captures/`.

Vite's dev server returns 404 for `/dashboard/projects/deploy.local/...`. It treats a path segment containing a dot as a static file. The capture used `deploy%2Elocal`. Project URLs need to survive dotted names in dev and production: encode them, or use the project id.

The structure matches: release list with states, detail header, steps, log and rollback action. Differences to polish:

- Project tabs omit Pull requests and Issues even when they exist.
- The failed release lacks the error excerpt and the board's actions: Add the variable, and Ask Scout to fix it.
- The head lacks its search icon.

The board's "Released by Scout" is wrong per the v2 rules, since agents never ship; the implementation's "started by Gabriel" is right.
