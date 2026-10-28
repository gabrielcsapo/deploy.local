# Computers part 2: installer and private restore copies

This is a **partial implementation**, not completion of coordinator self-release or
idle fleet updates. The work stayed within the listed file boundaries. No running
service, worker, container, installed application, or other worktree was changed.
No deploy command was sent to the live coordinator. Test data was temporary;
listeners were constrained to 5186 and 5187. The isolated screenshot fixture was stopped.

## Work by task item

1. **Coordinator self-release — not implemented.** The existing GET `/api/v2/updates`
   still projects the current deploy.local project release. It does not turn the
   host-supervised coordinator into that project. The supervisor has fixed child
   entry paths; restarting the coordinator would also terminate an in-process
   release executor. A production adapter needs a durable external executor,
   verified build staging, verification against a copied data directory, an
   authenticated supervisor switch protocol, activation recovery and rollback.
   Small integration edits to `server/supervisor.ts`, `server/api.ts`, and
   `server/store.ts` were requested during the session because those files are
   outside the explicit list. No answer was received. They were not edited.
   No fake second-coordinator end-to-end test is claimed. The existing edge
   Restarting screen remains intact.
2. **Other computers follow — not implemented.** A verified worker installer now
   exists (item 3), but there is no production self-update job producer, worker
   job dispatch, shared task/terminal admission reservation, post-restart report,
   ten-minute scheduler, or persisted automatic-update control. `automatic` stays
   false. Existing `followRelease` remains only a hook. The SelfUpdate page
   currently renders text instead of a switch; that UI file is also outside this
   task's edit list. Enabling the flag without these runtime pieces would falsely
   imply updates are safe and operational. Failed automatic updates are therefore
   not yet projected into SelfUpdate.
3. **Installer — implemented for macOS and Linux.** `/install` embeds the served
   manifest's platform checksum, verifies the download before execution, signs on
   macOS, probes the executable, and stages on the destination filesystem before
   renaming. A missing manifest fails closed. `/cli` checks size and SHA-256 itself
   and refuses a requested version that no longer matches. `deploy computer join`
   downloads the matching build into the enrollment directory and installs the
   service using that worker executable; it enrolls the installed version. Join
   refuses Windows with the desktop-app-only explanation. The POSIX installer
   documents that Windows computers use the desktop app. The legacy Windows CLI
   installer remains a CLI installer, not a worker installation path.
   `deploy upgrade` uses the same verified swap helper. The previous inode is
   retained; a failed post-swap version probe restores it. Tests execute fake
   worker builds in temporary directories, never installed system binaries.
4. **Backup copy access — implemented for HTTP previews.** New ready copies expose
   `https://copy-<restore-id>.<app>.deploy.local` in `BackupRestore.addresses`.
   Private receipts retain the loopback port; it is not exposed publicly. The edge
   advertises active copy hosts, and the coordinator provisions certificate SANs.
   Listing upgrades older loopback receipts with a recorded matching copy and
   rechecks certificate coverage. Backend data, volume paths and secrets remain
   private. The public address list is empty once a copy is not ready.

   The edge reads session and restore state through read-only database connections
   on every request. It accepts the existing device headers (`X-Deploy-Username`,
   `X-Deploy-Token`) only for the restore owner. Browser navigation uses a canonical
   `deploy.local/_copy/open` handoff, a 30-second one-use ticket, and a one-hour
   host-only Secure/HttpOnly preview cookie. The coordinator's host-only session
   cookie is not broadened to app subdomains. Logout/device revocation and Switch,
   Cancel, creating, failed or Live restore states revoke subsequent access.
   Credentials are stripped before proxying. Responses cannot be publicly cached;
   app cookies cannot set a parent Domain or replace coordinator access cookies.
   Agent, workspace-worker and node credentials cannot open copies.

   **Limits:** WebSocket upgrades to copy hosts are explicitly refused. Existing
   HTTP responses already in flight are not forcibly closed on Cancel. A separate
   app release can regenerate the shared certificate without preview SANs;
   reopening Backups revalidates and repairs that coverage. Persisting preview SANs
   in every certificate rotation path needs a small `server/certs.ts` integration,
   outside this task's edit list. LAN mDNS and physical iPhone browser navigation
   were not exercised in this sandbox. Consumers should use the returned URL and
   existing device headers; no iPhone contract or UI change is needed. The other
   agent owns removal of the old coordinator-only UI explanation.

5. **Whole suite — final results below.** The harness disables live Docker access,
   serializes test files, suppresses multicast announcements and binds only the
   assigned ports. The agents test's fixed 5196–5197 range is remapped at both
   listen and connect to 5186–5187; no socket binds to the original ports. The first
   run lacked that mapping and had one additional harness failure, preserved in
   `full-suite-first-attempt.log`.

## Validation and evidence

- `pnpm install --frozen-lockfile`: passed; no dependency or lockfile changes.
- `pnpm typecheck`: passed (`typecheck.log`).
- `pnpm lint`: passed with warnings, no errors (`lint.log`).
- `pnpm format:check`: passed (`format.log`).
- Focused `node --test` run: 17 passed, 0 failed (`focused-tests.log`). Includes
  actual proxy requests, owner isolation, stripped credentials, one-use handoff,
  session revocation, all non-ready restore states, certificate hostname coverage,
  publication/Cancel race, checksum corruption, version mismatch and failed-swap
  rollback. Final installer-only verification also passed all 4 tests
  (`installer-tests.log`).
- Final `pnpm test`: **779 tests, 762 passed, 4 failed, 13 skipped, 0 cancelled**
  (`full-suite.log`, exit 1). Only the four known environmental failures remain:
  the two system LibreSSL assertions in `server/ca-profile.test.ts`, unavailable Docker/Home
  Assistant readiness in `server/catalog-api.test.ts`, and Linux `/proc/self/fd`
  semantics in `server/legacy-preserving-update.test.ts` on macOS.
- No new dashboard or phone screen was built. Reviewed SelfUpdate, Restarting,
  RestoreData and RestorePhone boards; design sources were not edited. Existing
  UI differences remain documented in slices 8 and 10. A regression capture of
  the existing Restarting screen was attempted, but Chromium was denied
  `bootstrap_check_in` permission. No PNG or paired screenshot is claimed.
  `fixture-server.mjs`, `captures.md`, and `capture.log` contain the fallback.

## Next slice

Do not enable automatic updates on the strength of the binary swap helper alone.
It verifies and stages a build, but it does not supply a task admission fence or
recover a replacement that passes `version` and then fails its long-running worker
startup. Coordinator switching needs a process that survives the switch, and its
activation receipt must cooperate with v2 release recovery before restarting the
coordinator. Request the integration-file scope first; no unapplied supervisor
patch or production updater is hidden in this branch.

The private preview reader is registered by `initEdgeRuntime` and shared through
`registerAppPageSource`, covering the HTTP app hot path in both server topologies.
Do not route copy hosts through the ordinary unauthenticated app route table.

## Continuation: supervised updates

Merged `codex/design-system-ser` first (fast-forward to `1101841`). This continuation
changes the approved integration files; it does not install or restart the live
system. All child processes and data used for validation were temporary fixtures.
No other worktree, schema, migration, polish-owned dialog, project write API,
iPhone endpoint or `scripts/test.mjs` was edited.

### Coordinator self-release

Implemented the external executor in `server/v2/coordinator-executor.ts` and wired
it into `server/supervisor.ts`. Its private, 0600 Unix socket requires a separate
256-bit credential; the existing public status socket cannot switch builds.
Prepare pins the manifest and every file by SHA-256, rejects paths outside the
bundle and symlinks, and stages a private copy. Verify copies the data directory,
using SQLite's backup API for WAL databases, then runs the bundle's verifier with
Node permissions: only the staged code and copied data are readable, only the
copy is writable, and network, subprocess, addon and worker permissions are absent.
A schema change fails verification. Live data is never used as a verification
write target or replaced on rollback.

The supervisor persists `starting` before stopping its own control child. It
requires matching authenticated HTTP readiness for 30 seconds, then publishes an
activation receipt. Failed startup restores the previous entry, working directory
and version. An interrupted unconfirmed switch restores the previous selection
on supervisor startup. Edge, repository and pipeline child specifications stay
in place. Coordinator disconnect exits the control child, avoiding an orphan
control process after the supervisor dies.

`SelfReleaseRuntime` routes only the deploy.local project through this executor;
ordinary app releases retain their adapter. The new coordinator's v2 recovery
waits for the external activation receipt, then resumes the existing release
steps and Watch. Rollback stages and verifies the earlier immutable bundle through
the same protocol. A build cannot become a fleet target until the v2 release is
Live and its coordinator activation was confirmed.

**Still disabled for ordinary builds:** the repository's existing build output
does not supply `coordinator-build.json` and an isolated verifier that exercises
its real initialization. This pass does not pretend an ordinary Docker release
updates the host coordinator. Shipping an unbuilt `main` ref is refused; the
supported input is an explicitly prepared bundle version. SelfUpdate explains the
missing verified bundle. Coordinator data migrations, mixed coordinator/app
projects, and incompatible data rollback remain refused. Completing the production
artifact recipe and validating real coordinator initialization under the copy
permissions are next-slice work. No live coordinator self-release was performed.

The fake-build end-to-end test starts a separate executor process and two real
fake coordinator processes against a temporary data directory. It checks the
SQLite copy, live-data isolation, checksum refusal, denied live-directory access,
actual process replacement, v2 release recovery from an in-flight activation,
rollback, failed sustained startup, socket authentication and interrupted receipts.
V2 recovery is exercised in the test coordinator context; this is not a real
production-server boot test.

### Other computers follow

- A 10-minute scheduler produces one durable self-update job per computer/release.
  The served worker manifest must match a proven Live coordinator release. Unknown
  versions, unsupported platforms and runtimes without the supervised protocol
  receive no job. The scheduler starts once with the API and reads the persisted,
  administrator-only switch. Automatic updates default to off.
- Claim rechecks the current release and switch, then reserves admission under
  the same SQLite write lock used by remote task/job claims. It checks linked
  workers across owners, uncertain runs, interactive sessions, app jobs and
  terminals. Task and screen roles, terminal admission and app-job claims honor
  the reservation. A local terminal check closes the reconnect/in-flight claim
  gap. A reservation has no unsafe timeout that would admit work during an
  uncertain update.
- New service installations use an immutable `worker-supervisor` inode. It starts
  the replaceable worker as a child; old installations that still run the mutable
  worker directly do not advertise automatic-update support. The verified binary
  installer retains the previous inode. The external worker supervisor waits for
  a successful coordinator heartbeat and 30 seconds of sustained startup before
  marking the replacement complete. A replacement that passes `version` and
  then crashes is rolled back. An unconfirmed swap is restored before starting a
  worker after executor restart. No service installation command was run here.
- Only an authenticated post-restart report with the job nonce and expected
  installed version completes an update and releases admission. Generic job
  success cannot do this. Repeated reports recover a crash between the app-job
  database write and the admission database write. Failed updates remain visible
  and are not automatically retried. If confirmation never arrives, SelfUpdate
  says it is overdue and explains that new tasks remain paused.
- Fake-node tests cover persistence/admin checks, proven Live targets, unsupported
  workers, idempotent production, active tasks/terminals, blocked subsequent
  admission, stale/wrong-version reports, rollback reports, disabled-switch
  cancellation and report recovery. Fake executable tests cover stable startup,
  failure after readiness and executor restart with an unconfirmed swap.

**Limits:** an old worker needs a manual installation of the supervised service
before it can participate. Windows and desktop-managed workers remain outside this
POSIX service protocol. A missing or corrupt previous executable leaves admission
closed for manual recovery. Unregistered processes and computers whose coding
worker has not been linked to the computer are not discoverable by the admission
model; owners must maintain those existing explicit links. No app binaries or
services were updated on this machine.

### SelfUpdate parity and deliberate differences

The existing SelfUpdate structure, group rows and Settings hierarchy remain. The
text placeholder becomes the design system's real `Switch`, labeled "Auto-update
computers", backed by PUT `/api/v2/updates`. Errors from saving are visible. Computer
rows now show update failure, startup verification and precise unavailability
reasons; the coordinator explanation reflects missing safe build support.

Differences from the board are intentional:

- The switch defaults to off in production, because consent to fleet updates is
  not inferred. The reference-data fixture can display it on and toggles locally.
- There is no "Update now" button that could bypass admission or missing runtime
  support. Failed jobs are retained rather than automatically retried.
- The notice says whether automatic updates are enabled; it does not promise every
  computer will update while some runtimes lack the protocol.
- Failure and unsupported-build explanations add lines absent from the happy-path
  board. Unknown times are not fabricated as "updated itself 2 min ago".
- Desktop/iPhone updates still read "On the device"; this pass does not claim a
  device update implementation. Existing shell/sidebar and busy-count differences
  are unchanged from slice 8.

Chromium was denied `bootstrap_check_in`; both UI fixtures were stopped. No new
PNG, pair, visual approval or browser interaction test is claimed. See
`self-update-fixture.mjs`, `self-update-capture.log` and the appended `captures.md`
for the exact 1440/700 captures to take in the orchestrating session. Design sources
were not edited.

### Continuation validation

- `pnpm install --frozen-lockfile`: passed; no dependency/lockfile changes.
- `pnpm typecheck`: passed (`continuation-typecheck.log`).
- `pnpm lint`: passed, warnings only (`continuation-lint.log`).
- `pnpm format:check`: passed (`continuation-format.log`).
- Direct `node --test` for the five touched/new test files: **12 passed, 0 failed**
  (`continuation-focused-tests.log`). The supervisor's existing test now copies
  the executor module into its private fake installation.
- Final `pnpm test`: **794 tests, 777 passed, 4 failed, 13 skipped, 0 cancelled**
  (`continuation-full-suite.log`, exit 1). Only the four known environmental
  failures remain: two LibreSSL CA-profile assertions, Docker/Home Assistant
  readiness in `catalog-api.test.ts`, and Linux `/proc/self/fd` behavior in
  `legacy-preserving-update.test.ts` on macOS.
- The first full run had additional fixture-port collisions and the supervisor
  test's missing copied module (`continuation-full-suite-first.log`). The second
  had only one extra failure: the newly merged Live test restricts its listeners
  to 5194–5195 (`continuation-full-suite-second.log`). The isolated harness now
  remaps those ports, as well as 5196–5197, to 5186–5187 at both listen and connect.
  No listener used another task's assigned port. The third run is the final result.

The full-suite command used a Docker-denying executable in a temporary PATH and
an unreachable Docker socket, plus the existing serial, loopback-only fixture
harness. No production Docker daemon was contacted. Reproduction:

```sh
mkdir -p /tmp/v2-updates-safe-bin
printf '#!/bin/sh\nexit 1\n' > /tmp/v2-updates-safe-bin/docker
chmod +x /tmp/v2-updates-safe-bin/docker
PATH="/tmp/v2-updates-safe-bin:$PATH" DOCKER_HOST=unix:///tmp/v2-updates-no-docker.sock NODE_OPTIONS="--import=$PWD/docs/evidence/v2/8-computers-2/test-harness.mjs" pnpm test
```

### Next slice after this continuation

Produce and review the real coordinator bundle before enabling self-release on an
installation. The manifest contract is `protocol: 1`, `version`,
`dataCompatibility: "unchanged"`, `entry`, `verify`, and a `files` map of relative
paths to SHA-256 hashes. It must include the complete runtime distribution and
matching `dist/cli` artifacts; the selected bundle directory becomes the control
child's working directory. The verifier must exercise real initialization on
`DEPLOY_DATA_DIR` under the executor's permissions. Do not replace it with a
version check or a no-op script. Data migrations still require a separately
reviewed compatibility/restore protocol.

Keep the v2 release recovery integration and the startup receipt together. Do not
expire admission reservations just to clear an overdue update. Old POSIX services
need the immutable supervisor installation before they can advertise protocol 1;
Windows, desktop-managed workers and separately managed coding-worker binaries
need their own supported update path. Finish the SelfUpdate captures and pair
review using `captures.md` before claiming visual parity.
