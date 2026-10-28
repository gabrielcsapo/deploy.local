# Final polish

The requested API and client controls are implemented, with remote-only backup
retention still requiring integration with the parallel worker/backup work. Visual
acceptance remains pending: Chromium cannot launch in this sandbox. The supplied
boards were read at their web widths and SettingsPhone at 390. No design source,
live service, worker, container, installed app, or other worktree was changed.

## Completed

1. **Approvals:** five matrix actions with the current board's subtexts. Always
   yours contains screen use, deletion/removal, secrets and starting a release.
   Both rule writers reject retired actions. Legacy types/records remain readable;
   `isAllowed` refuses screen/secrets/install/spend/ship even with an old Allow.
   The brief explains why its earlier action list was wrong. Empty project-rule
   sections are hidden; scoped overrides remain visible when present.
2. **Project writes:** `PATCH /api/v2/projects/:p/settings` accepts
   `{keepReleases: 1..100, verifyMigrations: boolean}`. Defaults are 5 and true.
   Retention preserves the current release plus N earlier complete rollback plans;
   expired plans cannot be rollback targets. Audit and backup receipts survive.
   Verify-off skips migration jobs on the verification copy; app verification and
   activation-time migrations still run. Rollback data verification remains on.
   Both local and remote verification adapters receive the preference.
3. **Remove:** `DELETE /api/v2/projects/:p` requires `{confirm: <project name>}`.
   It checks ownership, fleet guards, active releases/rollbacks and app mutations;
   preserves local backup copies before removing runtime/data; frees deployment
   routes and membership; and retains copies for 30 days after completion.
   Remote stop must return success before the existing delete command removes its
   relay. Failed removal retains a durable receipt and can be resumed. Removal
   blocks new project releases. Local backup archives are isolated from app-name
   reuse and expire through an hourly sweep and access-time cleanup.
   `GET /api/v2/projects/removed` lists retained copies, with an owner-only
   `/api/v2/projects/removed/:archiveId/backup` download. Old release backup paths
   are detached so a reused app name cannot expose another owner's files.
4. **Project UI:** retention and Verify save; Remove has a typed-name confirmation
   and real error handling. `settings?key=NAME` edits an existing variable/secret
   or opens an Add variable editor with that name. `editSecret` still works.
5. **Dialogs:** shared Dialog portals to document.body, retaining native showModal,
   centering, scrim, Escape and focus restoration. RestoreData, NewProject and every
   other shared v2 dialog use this. Removed a page-global blur override. The only
   custom native dialog is Markup: its top placement is intentional, and it has
   explicit horizontal auto margins. It was not redesigned.
6. **CI and SSR:** the runner discovers server and app `.test.ts`, plus docs
   `.test.mjs`. The account SSR error was transitive `workspace-icons.json?ssr`,
   not qrcode. Flight's query bypassed Vite's JSON transform. A narrow pre-transform
   emits the JSON default export; the real account route returned 200 with no parse
   error or CSR fallback (`ssr.log`). The qrcode import remains unchanged.
7. **Desktop:** offline uses the coordinator computer name, remembers it across
   process restarts and clears it when switching coordinators. The last running
   task on this computer is retained and shown with “Paused at its last checkpoint”.
   Names/titles come from Computers and the task/run records; SER is fixture data.
8. **iPhone:** owner-scoped agent control GET/PATCH endpoints support pause/resume
   and mute for one hour/unmute. Pause blocks new agent conversation work and
   unattended Warden rollback, including automatic proposals. Mute suppresses that
   agent's push notifications until expiry. GET/PATCH `/api/v2/notifications`
   supports Decisions, Failing apps, and quiet hours (22:00–07:00 in the supplied
   IANA timezone), except rollback decisions. Turning a category off or explicitly
   muting an agent still takes precedence. Pair-derived APNs registrations are
   bound to the authenticated session, not a caller-supplied device ID. Revocation
   deletes its token; delivery also checks session validity to close races.
   Native settings, agent menu and a paired-devices sheet use these endpoints.
   The explicitly excluded Swift files were not edited.

## Deliberate differences and limits

- No screenshot parity claim: `captures.md` is the exact capture/pairing handoff,
  and `capture-attempt.log` records the single failed Chromium launch. No computer
  use or desktop browser was used. The fixture uses real components and renderer.
- Approvals defaults still Ask; board sample privileges are fixture-only. Suggested
  rules still open the editor for review. Scoped rules appear only when they exist.
- Retention governs available rollback plans. Shared Docker image caches and old
  immutable source directories are not garbage-collected by this preference;
  audit and backup history are intentionally separate from rollback eligibility.
- Remove retains existing backups; it does not invent a fresh backup. Managed
  runtime data is removed, while external bind mounts remain untouched. Backups
  that live only on a remote computer remain there under the existing worker
  lifecycle; this change neither fetches nor expires remote-only archives. The
  retained-copy download contains coordinator-local archives. Remote backup access
  remains with the parallel backup/worker work. No backup sub-router was edited.
- RestoreData keeps the existing copy-first restore flow, rather than the board's
  destructive one-step copy. NewProject keeps placement at Ship, as the previous
  slice documented. Those flows were not changed by this centering pass.
- Desktop evidence renders shell content without an imitation OS desktop/titlebar.
  It does not promise automatic draft sending. Existing worker code is unchanged.
- Agent Pause affects new agent work; it does not kill already-running task
  processes or add a standing-agent scheduler. Quiet hours default off to preserve
  prior delivery behavior until chosen; the phone supplies its actual timezone.
  Alerts suppressed by preferences are consumed, not replayed as a burst later.
- Swift package and Simulator-target compilation passed, but no Xcode app install,
  native capture, or physical APNs delivery was attempted. The native fixture from
  the previous slice needs these new endpoints before recapturing SettingsPhone.

## Validation

- Frozen dependency install passed. The generated tracked pnpm cache is restored.
- Typecheck, lint (warnings only) and format checks passed before each commit.
- Production build passed (`build.log`).
- Focused Node tests: 99 passed, 0 failed (`focused-tests.log`). Includes new
  owner/scope/retention/verification/removal/retry/expiry/download/control/push cases.
- Desktop rendering tests: 16 passed (`desktop-tests.log`, also in focused tests).
- Swift package build and arm64 iOS Simulator package build passed (`swift-build.log`,
  `swift-ios-build.log`). Swift tests: 29 passed (`swift-tests.log`), including actual
  request shapes for preferences, mute/pause and device revocation.
- Full suite: **840 tests, 823 passed, 4 failed, 13 skipped, 0 cancelled**
  (`full-suite.log`). The failures are the four known environmental cases:
  two CA-profile checks requiring OpenSSL options unavailable in system LibreSSL,
  Home Assistant readiness without Docker, and legacy rollback's Linux-only
  `/proc/self/fd` expectation on macOS. All discovered web app/docs tests passed.
  Validation used temporary data, an unavailable Docker socket and a test-only
  Docker stub. The evidence preload serializes test files and restricts TCP/UDP to
  5180–5183. This permits CI HTTP's three-listener fixture without touching live
  services. The live test's old two-port restriction now uses the suite's normal
  5180–5199 search range, bounded to this task's ports by the validation preload.

## Implementation commits

- `a3421bc` Fix dialog placement, dev SSR and desktop offline context; include web tests
- `8c95f53` Match approval rules and wire iPhone agent, notification and device controls
- `a5d5852` Implement project release preferences and confirmed removal with retained backups

## Next slice

Capture and inspect the listed pairs. Exercise native toggles, mute expiry,
revoke-the-current-phone and APNs delivery on a dedicated device/simulator. Merge
the small API import/dispatch and additive shared type with the parallel branch.
Integrate remote archived-backup retrieval/retention with the backup/worker owner.
Apply `agentControl(...).paused` / `isAllowed(...)` at any future agent scheduler
admission point. No scheduler is implied by an agent's textual schedule today.

## Visual review (added by the orchestrating session)

**Fixture fixes needed before capture:**

- `fixture-server.mjs` answered any path containing `/logs` with fake log data, including `/app/routes/dashboard/v2/projects/logs.client.tsx`. The module loaded as text/plain and every page using it was blank. The rule is now scoped to `/api/`.
- `Approvals` crashed on an agent without `job`, which the fixture omitted. The row now tolerates a missing description.

**Captures** were paired against the current boards (`<Board>-<width>.png`, board left):

- **SettingsAgents** matches. The five delegable actions with their subtexts; Use the screen, Delete data, Read or change secrets and Start a release under Always yours.
- **ProjectSettings** matches. Real Ask me, keep-N and Verify migrations controls, plus the Remove section.
- **RestoreData and NewProject** dialogs are centered over a scrim.
- **Offline** (desktop) names SER and shows the paused-task row.

## iPhone build and capture after the final merge (added by the orchestrating session)

- From the merged branch (`7caf957`): `xcodegen generate`, then `xcodebuild` DeployIOS (Debug, iOS Simulator) succeeds. DeployMac also built from `fe3f7ce`.
- The part 2 fixture (`docs/evidence/v2/12-ios-2/fixture-server.mjs`) now also serves `/api/v2/notifications`, `/api/v2/devices` and `/api/v2/agents/:id/control`. Without them, Settings showed "Fixture endpoint unavailable (404)".
- Captured on the dedicated 390-pt simulator and paired (`ios/SettingsPhone-390.png`, `ios/AgentMenuPhone-390.png`, board left):
  - **SettingsPhone** shows Decisions, Failing apps and Quiet hours as real switches, plus paired devices.
  - **AgentMenuPhone** shows Mute for 1 hour, Tune and Pause, as on the board.
