# Slice 8 · computers, models and updates

This is a **partial implementation of slice 8**, not completed acceptance of the whole task.
It uses existing fleet tables and generic workspace records; no schema or design source changed.
No live service, worker, container or installed application was stopped, restarted or changed.
The only preview servers started were the fixture and Vite on 5190/5191; both were stopped.

## Implemented, by task item

1. **Computers:** GET `/api/v2/computers` returns `{ computers: Computer[] }`; GET
   `/api/v2/computers/:id` returns `{ computer }`. Fleet computers and owner-scoped workspace
   workers share one projection. The local worker joins the coordinator; remote workers use
   `worker:<workerId>` identities. Names alone never merge computers. Administrator-written
   `v2-computer-roles` records can preserve explicit worker-to-fleet links; there is not yet a
   linking UI or enrollment producer for those remote links. Roles, online state, reported
   CPU/memory/disk, active apps/tasks/jobs and version are exposed. Missing measurements stay
   absent and render Unavailable. Only selected fields leave the API; credentials do not.
   PATCH accepts `{ roles: Role[] }`. Coordinator stays on. Take tasks is enforced on local
   and remote run admission and job claims; existing runs are returned/continued. Use the screen
   is enforced before an interactive command is claimed. Unsupported roles are rejected.
2. **Add:** `/dashboard/computers/add` and the list action open one dialog. An administrator
   enters a reserved computer name and POSTs `/api/v2/computers/enrollment`; this calls the exact
   `createNodeEnrollment` implementation behind `/api/nodes/enrollment`. The actual supported
   headless command is `sudo deploy computer join <coordinator-origin>` on Linux with the CLI
   installed, followed by the code at its prompt. The code has the existing ten-minute TTL.
   The dialog polls computer inventory for connection, reports expiry and can create another code.
   Existing desktop apps use password sign-in and `/api/workspace/workers/enroll`, as inspected in
   `desktop/src/worker.mjs`; those registrations appear in this list without a second fleet key.
3. **Remove:** GET `/api/v2/computers/:id/removal` returns `{ computerId, allowed, reasons, apps,
tasks }`. DELETE rechecks that plan immediately before revoking credentials. It refuses the
   coordinator, apps (including another owner's apps and desired placements), queued/active or
   unknown work, and a reported model-serving role. It lists other online Run apps computers
   without asserting their capacity or data compatibility. Idle removal revokes worker and/or
   fleet credentials, leaves disk data alone, and hides the removed identity. Non-admin mutations
   are refused. These checks do not claim a cross-database global deployment reservation.
4. **Models:** GET `/api/v2/computers/models` returns `ComputerModels`; PUT `{ defaults }` saves
   owner-scoped defaults for writing-code, reviewing and answering-questions. Model choices come
   from worker-reported model options and reported local inventory. Claude/Codex usage projects
   the latest reported weekly window, never inventing usage or summing potentially shared quotas.
   Local inventory uses node `capabilities.models` entries `{ id, name, loaded }` and appears only
   on Serve models computers. Missing usage is Unavailable. The Models page is the sole new
   defaults editor.
5. **Updates:** GET `/api/v2/updates` returns `ComputerUpdates`. The target is the current
   deploy.local app's **Live project Release**, using `currentProjectReleases` from the v2 release
   engine, so a failed Watch is not propagated. The UI links to that project's existing release
   page. Per-computer status distinguishes current, waiting, ready, offline and unavailable.
   `followRelease` is a tested runtime integration hook: it requires a caller-provided reservation,
   rechecks idleness after reserving, never installs during a task/job, and always releases the
   reservation. **It has no production caller or installer.** `automatic` is deliberately false.
   The split-process edge now serves `server/edge/restarting.ts` when forwarding to the coordinator
   fails. This is standalone HTML/CSS, 503/no-store/Retry-After, no external assets or JavaScript,
   with an escaped computer/version label and five-second refresh. App proxy routing is unchanged.
6. **Tests:** focused tests exercise merged identities, unknown metrics, role admission without
   interrupting a current task, admin rejection, app/queued/active removal refusal, credential
   revocation, model defaults/owner isolation/weekly usage, HTTP envelopes, agent credential
   rejection, idle update gating, release-state gating, and static Restarting response behavior.

## Not implemented and why

- **Run apps / Serve models toggles:** shown as configured, disabled in the UI, and changes are
  refused server-side. The fleet has no independent role reconfiguration or model-service control
  protocol. Changing a generic role record alone would misrepresent actual runtime behavior.
  Take tasks and Use the screen are implemented; their absence from supportedRoles means the
  corresponding runtime has not reported support. No desktop roles UI was edited.
- **Installers and local model inventory producer:** signed Mac/Windows/Linux download artifacts
  have not been published by the desktop slice, so download buttons are disabled with a reason.
  No Lemonade discovery/loading protocol exists in this checkout; this API accepts the inventory
  shape above but no existing node runtime publishes it. No synthetic local models are injected
  into production. Installing the CLI and certificate trust remain the existing installer flow.
- **Moving apps/tasks/backups during removal:** the slice-4 runtime explicitly refuses remote
  project staging and activation. Removal therefore requires apps to be moved first and tasks to
  finish or be reassigned; it cannot perform the board's “Move everything and remove”. There is
  no backup-destination migration adapter in this slice. The parallel backups owner must add its
  destination dependency to removal admission before remote backup destinations are supported.
- **Composer consumption:** the shared Composer/task routes are outside this task's write scope
  (the task-page fix is owned by another agent). This branch supplies typed defaults but does not
  change their model pill or task dispatch. Consume `defaults[job]`, look up `choices[id]`, then use
  its `provider` and `model` for a new chat unless that chat has an explicit override. Do not treat
  a null/unknown default as an invented model. Model defaults do not yet change worker execution.
- **Coordinator self-release and automatic worker installation:** the existing project adapter
  releases application graphs, while this install's coordinator runs under its host supervisor.
  There is no host-coordinator packaging/activation adapter or worker binary-update protocol.
  This branch does not turn the running coordinator into a project, switch its installed code,
  start an updater, or satisfy the ten-minute automatic-install requirement. `UPDATE_INTERVAL_MS`
  defines that interval for the future polling runtime only. The caller must supply an admission
  fence shared with new task claims, a verified artifact/install mechanism, and a recoverable
  coordinator activation/rollback adapter before enabling automatic updates. No “Update now”
  button falsely claims this exists. Edge Restarting is implemented independently.
- **Visual acceptance:** Chromium cannot launch in this sandbox. No implementation captures or
  paired PNGs exist; do not count this as visual parity. See `captures.md` and `capture.log`.

## Board parity and deliberate differences

Read the settled brief, both design READMEs, all named HTML/CSS sources, both-width web renders,
Restarting and the read-only ComputePhone reference. Followed the existing v2 shell and primitives.
The fixture uses SER, MacBook Pro, bazzite, home-gym, Scout and Warden.

- **Compute:** same tabs, page heading, computer rows and Models notice. Fixed role names are used
  literally rather than the board's prose conjugations. Provider sign-in and hardware descriptions
  are not fabricated. A small Updates link exposes SelfUpdate on the existing computers route.
- **Computer:** same measurements, Runs/Roles columns (stacked on narrow windows) and coordinator
  notice. Unknown metrics explicitly say Unavailable; total-only memory does not get a fabricated
  used percentage. App process state is not substituted with verified health. Terminal and the
  unimplemented overflow menu are omitted. Run apps/Serve models display their actual configured
  state with an explanatory disabled switch. Unsupported worker roles are disabled. The notice
  links to Updates, which links to the real project release if one exists.
- **Models:** retains local models, subscriptions and defaults hierarchy. Native selects save the
  three job defaults requested by this task, including Answering questions rather than the board's
  Tracking row. Weekly usage is shown only where reported. Per-agent weekly attribution, model
  loading, fallback policy, tracking defaults and agent overrides are omitted: the existing reports
  and contracts have no truthful values/actions for them. These omissions shorten the page.
- **AddComputer:** adds the computer-name field required by existing enrollment, code expiry and
  the actual CLI command/prompt. The board's curl `--join` shortcut is not supported by this
  install script. Desktop download buttons are disabled, with the missing artifact explanation.
  Joining by an already-installed desktop app is supported through its existing sign-in path.
- **RemoveComputer:** lists each app and available destinations, shows explicit refusal reasons,
  and disables Remove until dependencies are gone. It does not promise safe data movement or task
  checkpoint migration. Backups are not invented as a current dependency without a destination
  producer; see the integration requirement above. No data-erasing action exists.
- **SelfUpdate:** same computer list, release notice and settings group; the unavailable runtime
  updater is visible instead of an enabled automatic switch or Update now. No invented “updated
  2 min ago” timestamp or app-store auto-update promise. The page is `?updates=1` because the settled
  route table has no separate updates route.
- **Restarting:** same centered 460px content, logo, heading, explanatory copy, spinner and recovery
  instruction. The host name/version are real configuration when available; no SER/version is
  hard-coded in production. The static page uses a system-font fallback when Hanken Grotesk is not
  already installed, does not fake an elapsed timer, and refreshes every five seconds. It works
  without coordinator assets, network fonts, or scripts; dark mode and reduced motion are supported.
- **Shared shell:** the fixture supplies current sidebar APIs but does not alter the owned shell.
  Vite showed the existing `workspace-icons.json?ssr` parse issue and returned its client-render
  fallback; production build succeeds. HTTP inspection confirmed the fixture served that HTML.

## Validation

- `pnpm install --frozen-lockfile`: passed (`install.log`); no lockfile change.
- `pnpm typecheck`: passed (`typecheck.log`).
- `pnpm lint`: passed with warnings, no errors (`lint.log`).
- `pnpm format:check`: passed (`format.log`).
- `pnpm build`: passed (`build.log`).
- `node --test server/v2/computers.test.ts server/v2/updates.test.ts`: 9 passed, 0 failed
  (`focused-tests.log`). All database state is temporary; no real update runs.
- Full `pnpm test`: 709 tests, 692 passed, 4 failed, 13 skipped, 0 cancelled (`full-suite.log`).
  The failures are unchanged and recorded by prior slices: two `server/ca-profile.test.ts`
  assertions with system LibreSSL, Home Assistant readiness in `server/catalog-api.test.ts` with
  Docker unavailable, and Linux `/proc/self/fd` in `server/legacy-preserving-update.test.ts` on macOS.
  A temporary preload uses the earlier slice's `test-guard.mjs` to constrain listeners to 5180–5199
  and changes test-file concurrency from four to one. An unavailable Docker socket and fake Docker
  executable prevent live Docker access. No test was rewritten to hide those failures.

## Handoff

Contracts are additive in `shared/v2/contracts.ts`. The single computersApi import/dispatch also
handles `/updates`; preserve other agents' dispatches and the four route component substitutions
when merging. Runtime role admission lives in `server/workspace/computer-roles.ts`; worker-reported
capabilities cannot overwrite owner-selected roles. `DEPLOY_VERSION` and `screenSupported` are
now accepted in worker registration; the remote worker sends them when known. The iPhone owner can
consume computers/models/updates without touching legacy nodes or worker credentials. Finish the
missing runtime/enrollment/linking/default-consumption work and all visual captures before calling
slice 8 complete.

## Visual review (added by the orchestrating session)

Captured with the fixture and Vite on 5190/5191, and paired at 1440 and 700 (`<Board>-<width>.png`, board left). An earlier attempt hit another agent's server on 5190 and produced blank captures; it was redone.

- **Compute, Computer, Models, AddComputer, RemoveComputer, SelfUpdate and Restarting** match their boards in structure and wording.
- **Footer:** the sidebar shows "Account" because the fixture does not serve `/api/user`.
- **SelfUpdate:** states "Runtime updater not available" for other computers, because coordinator self-release and the worker installer aren't implemented (see Still incomplete).
