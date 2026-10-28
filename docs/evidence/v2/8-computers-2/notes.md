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
