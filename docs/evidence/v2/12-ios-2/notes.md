# Slice 12, part 2: iPhone

Implementation handoff, **not completed visual acceptance**. Xcode and CoreSimulator
are blocked in this sandbox before app compilation/capture. All assigned source
renders and markup were inspected. No browser facsimile or copied design image is
presented as a native capture. See `captures.md` for every destination and command.

## Implemented, by task

1. **Projects and releases:** native project sections consume actual pull-request
   and issue lists, show available apps, and expose project Releases. Lists and
   details use the two specified GET endpoints. The store consumes typed release
   and rollback events, replacing progress by operation ID. Details show app
   versions, migrations, four recorded phases, Live/failed/rolled-back states and
   failure detail. A failed release offers a prefilled Scout draft for review.
   Rollback requires explicit approval, moves the project, and shows progress in
   both the release list and the answered decision (including push-opened items).
   A data-loss 409 is never automatically confirmed or retried.
2. **Restore:** Settings → Backups lists recorded project backups, dates and test
   results. Restore creates a copy, refresh recovers existing operations, Cancel
   removes a cancellable copy, and Switch requires the checked-copy toggle plus
   explicit confirmation. Switching shows its release and retained Live backup.
   Coordinator-only preview URLs are explained rather than opened on iPhone
   localhost. Ambiguous writes are not silently repeated. Terminal states allow
   choosing another backup. No backup/restore runs against the live install.
3. **Tasks:** the title and task menu open Task info with project, repository,
   computer, recorded work/check results, screenshot records and project releases.
   Changes/Checks links select the corresponding task tab. Ship opens the native
   sheet and posts the project release using the task ID as source and an explicit
   repository ref. The server owns computer placement, addresses, access and data;
   the sheet describes those recorded settings instead of offering ignored fields.
   Typed release events now open native release details.
4. **Part 1 polish:** answered rows and decision records use Approved / Not now /
   Answered; they do not repeat action verbs. Times use short clock forms, Yesterday
   and localized month/day. The deploy.local project section is present, driven by
   the project APIs. Logs remain a computer-only row, as required by the brief.
5. **Pairing:** the native scanner consumes the sign-in branch's documented JSON
   payload. That branch is not merged here; its committed notes and contract were
   read via `git show` at `000872f`, without touching its worktree. A copy of that
   contract is `pairing-contract.md`. The app rejects expired, malformed, unknown-
   version and non-HTTPS codes. It fetches only public `/ca.crt` bytes without any
   credentials, verifies the DER SHA-256 digest against the QR, then uses a separate
   pinned TLS session for `/api/v2/devices/exchange`. This accommodates servers
   that do not send their root in the TLS chain. Hostname/chain validation remains
   enabled for all credential-bearing requests; redirects are refused. Device
   token, account, origin, certificate and pin are kept in a device-only Keychain
   record, and later v2/push clients use the same pin. Unsupported exchange routes
   (404/501) explain password fallback. Password sign-in clears a superseded pairing.
   Camera access starts only after tapping Scan; fixture mode cannot start it.
6. **Settings, menus, push:** notification detail reports actual OS authorization,
   explains Focus and opens iPhone notification settings. Agent menu offers search,
   info and Copy link; unsupported controls are explicitly unavailable. Existing
   unlock-required Approve/Not now/Open categories are retained. Failed-answer
   notifications now preserve account/coordinator scope, so Open reaches the item.
7. **Tests and capture:** 11 focused Swift tests cover release request bodies,
   typed progress, ambiguous sends, rollback data-loss refusal, restore switch/
   cancel guards, pairing expiry/payload/exchange/certificate mismatch, and labels.
   Tests live in an evidence-local Swift package to respect the source boundary.
   A loopback fixture and smoke test cover every new board route and the mutation
   shapes. `capture.sh` requires an explicit dedicated simulator UDID, navigates
   every new native board and pairs captures. It never asks for permissions or
   submits a push. The script terminates its simulator app on exit.

## Not complete and deliberate board differences

Native navigation, safe areas, sheets, SF Symbols and system typography replace
canvas HTML controls. No pixel/spacing acceptance is claimed without simulator
captures. These limitations are not silently treated as parity:

| Board                         | Difference / remaining work                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ReleasesPhone                 | Uses actual release IDs, source and app health. No fabricated release age. Rollback data-loss review remains on a computer; the phone safely refuses rather than approving missing loss detail.                                                                                                                                  |
| ReleasePhone                  | Uses the server's four phases and app records. Stop-before-activation has no endpoint and is omitted. Worker self-update ordering is not invented.                                                                                                                                                                               |
| ReleaseFailedPhone            | Reports the failed phase/detail; “Nothing changed” appears only when activation was skipped. No full native log screen (explicitly out of scope); Scout opens a reviewed draft.                                                                                                                                                  |
| ShipPhone                     | Read-only configured placement/access/data and explicit branch/commit replace unsupported pickers. A project must already have configured apps; iPhone does not provision a new database or app.                                                                                                                                 |
| RollbackPhone                 | Actual prepare/verify/activate/watch steps replace invented per-app migration/retry timings. No queued-job count or completion promise is fabricated. Progress is also available outside the Warden conversation.                                                                                                                |
| RestorePhone                  | Copy first, then inspect and Switch, per the settled recovery contract. No one-step destructive restore, invented workout-loss count, duration or nightly guarantee. Native preview remains coordinator-only until the server exposes an authenticated remote copy URL. Undo is a retained backup/release handoff to a computer. |
| SettingsPhone / notifications | Separate notification category preferences, quiet-hour exceptions, device counts and editable appearance are not implemented by the current API. Actual iOS authorization and Focus are displayed; no fake switches.                                                                                                             |
| LockScreen                    | OS-rendered notification, not a SwiftUI imitation. Approve/Not now require unlock. Simulator push interaction and physical APNs delivery remain unverified.                                                                                                                                                                      |
| AgentMenuPhone                | Native action sheet instead of canvas floating menu. Mute and Pause have no server contract; Tune is intentionally computer-only. Those limitations are visible.                                                                                                                                                                 |
| NewProductPhone               | **Screenshot images are not implemented.** Typed screenshot references are retained and shown, but this checkout has no screenshot retrieval/image-delivery endpoint. No requested preview is fabricated or run locally.                                                                                                         |
| TaskInfoPhone                 | Real project/computer/work/check/release data. Screenshot count comes from events; image viewing remains unavailable. No fabricated model usage percentage, commit count or task creator.                                                                                                                                        |
| ProjectPhone                  | Real PR/issue counts, app health and releases; includes project tasks. Empty nouns stay hidden. Logs is a computer-only explanation, not a native streaming log page.                                                                                                                                                            |
| SignInPhone                   | “Settings › Devices › Add iPhone” follows the parallel branch's actual route. Explicit Scan button before camera access; certificate pinning is app-scoped, never a system CA installation.                                                                                                                                      |
| AnsweredPhone                 | Outcome labels and short dates fixed. No inferred post-answer healthy/released outcome.                                                                                                                                                                                                                                          |

The existing question-versus-task routing and attachment-upload gaps from part 1
remain. Agent mute/pause and category-specific notifications cannot be completed
inside this slice's Swift-only boundary. The v2 agent server has tuning fields,
but no mute/pause operation; no unsupported request is sent.

## Validation

- `pnpm install --frozen-lockfile`: passed; generated tracked pnpm cache restored.
- Before each commit: `pnpm typecheck`, `pnpm lint` (warnings only), and
  `pnpm format:check`. Results are retained in their named logs.
- `swift test --package-path docs/evidence/v2/12-ios-2` with the temporary-path
  flags below: **11 passed** (`swift-tests.log`). Uses URLProtocol fixtures and a
  public test-only certificate; no real credentials, Keychain writes or network.
- Existing DeployKit Swift tests: **28 passed** (`existing-swift-tests.log`).
- `node --test docs/evidence/v2/12-ios-2/fixture.test.mjs`: **1 passed**, exercising
  12 board selections and release/rollback/restore/task endpoints. Fixture stopped
  after each smoke run. No test listener remains running.
- SwiftPM package builds: macOS and arm64 iOS Simulator passed (`swift-build.log`,
  `simulator-package-build.log`). Both app entry points pass direct Swift 6
  typechecking (`app-typecheck.log`, `mac-app-typecheck.log`). These are not full
  Xcode app builds.
- `xcodegen generate`: passed. Requested DeployIOS/DeployMac `xcodebuild` attempts
  both fail during package resolution: the sandbox refuses SwiftPM's manifest
  diagnostics cache. `simctl list devices` cannot connect to CoreSimulatorService.
  See `xcode-ios.log`, `xcode-mac.log`, `simulator-capture.log`. No app was installed
  or run and no paired screenshots exist here.
- Full `pnpm test`: **679 tests; 592 passed, 50 failed, 24 cancelled, 13 skipped**,
  exit 1, 507.8 seconds (`full-suite.log`). **Not green.** Fixed-port v2/CLI tests
  were rejected by the 5186-only guard; multi-listener HTTP/TLS/edge tests had port
  conflicts or closed sockets, with watchdog failures in proxy/repositories/
  transcription/workspace tests. The two unchanged CA-profile assertions and the
  unchanged Linux `/proc/self/fd` assumption also fail on this machine, as in prior
  evidence. Catalog HTTP setup cancelled. No unrestricted baseline run was made,
  so these counts must not be presented as a clean regression comparison. This
  Swift-only slice changes no server implementation. The test listener was gone
  after completion; no fixture service remains running.

SwiftPM commands use `--disable-sandbox` only to disable the nested compiler /
package-manifest sandbox; this session's filesystem and process restrictions still
apply. Scratch/cache/config/security paths are `/tmp/deploy-ios2-*`. The direct
compiler checks use `-typecheck -parse-as-library -disable-sandbox -swift-version 6`
and the corresponding temporary SwiftPM modules and SDK. Empty compiler logs mean
the commands exited 0 without diagnostics; see the checks recorded above.

The full JavaScript suite uses temporary `DEPLOY_DATA_DIR`, an unavailable Docker
socket and a fixture-only Docker stub. `test-guard.mjs` serializes files and permits
only TCP/UDP **5186**. Tests that require simultaneous independent listeners cannot
pass under this one-port constraint; the 90-second per-file watchdog bounds hangs.
No application/test infrastructure outside this evidence directory was edited.

## Next slice / orchestrator

- Merge the sign-in server and wire Settings Devices; run camera, certificate
  validation (including mismatch/expired/hostname failures), replay, Keychain,
  reauthentication and device-revocation acceptance on a dedicated simulator/device.
- **APNs revocation is still a server integration gap:** pair-device records and
  existing push registrations are separate stores. The sign-in notes explicitly
  call for linking a registration to the paired device/session and revoking both.
  Swift-only changes cannot enforce that. Do not claim remotely removing a paired
  device also stops APNs delivery until that server work lands.
- Add an authoritative screenshot/image-delivery API before claiming
  NewProductPhone/TaskInfoPhone screenshot parity. Retain explicit unknown states.
- Release creation has no idempotency key. The client never automatically retries
  a lost Ship/rollback response; review Releases before starting another operation.
- Run the Xcode builds and all captures, inspect/fix pairs, and complete lock-screen
  actions. The fixture is only on 5186. No live services, workers, containers,
  installed apps, other worktrees or design sources were changed. No push/merge/rebase.
