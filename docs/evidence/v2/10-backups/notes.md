# Slice 10 · backups and restore

Implemented on `codex/v2-backups`, continuing `0570321`. This is a coordinator-local graph restore implementation with the limitations below, not a claim that every backup format or client can restore yet. No live installation, service, worker, container or application was changed. No schema or design source was edited.

## Implemented

- The Backups route reads scheduled application backups, recovery bundles and project pre-release backups. It shows contents, recorded location, source computer, capture time, size, and test-restore status. Admins also see the existing application backup and recovery-bundle schedules. It reports actual schedules, including disabled ones; it does not claim every install already backs up nightly.
- Copy creation validates graph manifests and archive hashes, checks code/configuration compatibility and complete resource coverage, and starts pinned images with separate volumes on an isolated network. Copy endpoints never replace live endpoints. A ready copy returns its address for review. Current project membership and release identity are rechecked before switching.
- Switch requires explicit `{ "confirm": true }` and uses `ProjectReleaseService`, including its project reservation, prepare/verify/activate/watch progression and recovery locks. It freezes the checked copy, backs up all current project data, and activates the checked data through the existing release adapter. Original writers stay stopped between the final backup and activation. A backup failure restarts the exact previous processes, without rebuilding or replacing them. The prior live data remains in a retained release backup.
- Cancel removes only the copy's containers, volumes and network. It is repeatable and fences a racing Switch. A failed creation can retry cleanup through Cancel. Switching is refused while a project release is running or after the current project changes.
- Test-restore for recovery bundles invokes the existing operations-handler verify and rehearsal operations with the supplied passphrase. Application backup tests create and remove a disposable graph copy. Test results are persisted in records; private runtime receipts and configuration values are not returned to clients.
- The page supports backup selection, copy review, Switch, Cancel, release progress, test-restore, recovery passphrase input, loading, empty and error states. The route import is the only change to `app/routes.ts`.

## API and next slice

All paths start with `/api/v2`. Use the existing signed-in session. Agent and worker headers are refused.

| Request                                                            | Result                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `GET /backups`                                                     | `BackupsResponse`: `backups`, `restores`, `schedules`                                  |
| `POST /backups/:id/restore`                                        | 201 `{ restore }`, including `addresses` after creation                                |
| `POST /backups/:id/restore/:rid/switch` with `{ "confirm": true }` | 202 `{ restore }` and `releaseId`                                                      |
| `POST /backups/:id/restore/:rid/cancel`                            | 200 `{ restore }`                                                                      |
| `POST /backups/:id/test`                                           | 200 `{ status: "passed", testedAt }`; recovery bundles require `{ "passphrase": "…" }` |

Encode backup IDs as URL segments. Poll GET while a restore is creating or switching; release progress also uses the existing release detail API. The public types are additive exports in `shared/v2/contracts.ts` from `0570321`; existing types were not changed. Receipts and test results use `records` kinds `v2-backup-restore` and `v2-backup-test`. No migrations are required.

Remaining integration and operational limits:

- **Copy addresses work only in a browser on the coordinator.** The graph adapter publishes to loopback. The UI states this and the API preserves `localhost` instead of incorrectly rewriting it to a network hostname. An authenticated edge preview route is needed for another computer or iPhone; the edge and worker protocols are outside this slice's file boundaries. The iPhone agent must not treat a loopback address as locally reachable.
- **Restore execution currently requires a local graph archive and a complete current project release.** Legacy archives, remote-worker backups, unavailable archives and coordinator recovery bundles remain listed, with restore availability/reason. They never fall back to an in-place restore. A coordinator bundle is verified and rehearsed here; full recovery belongs to setup on a new computer.
- The release adapter refuses graphs whose host access cannot be isolated. Upgraded profile-volume bindings are also refused. A backup from a different spec/configuration requires the original project release first. These guards deliberately narrow the supported set rather than risking live data.
- A coordinator crash during creation can leave a `creating` receipt and copy resources. A failed switch retains release recovery reservations where required. Operator reconciliation, cross-path mutation fencing, restart recovery and retention/pruning remain needed, as described in slice 4. Successful switches leave stopped copy resources and the checked archive retained; Cancel is intentionally unavailable after Switch. Previous live backups are kept indefinitely, with no deletion-confirmation flow in this slice.
- Listing reflects saved backup records, not proof that a subsequent external rsync completed. There is no remote destination free-space or location classification contract. Computer identity may be an existing ID (`coordinator` for the local runtime) rather than a display name.

## Parity and deliberate differences

Read the brief, both design READMEs, board markup, shared component CSS and the Backups/RestoreData renders at 1440/700, plus RestorePhone at 390. The iPhone board is reference-only.

**Visual parity remains unverified.** The prescribed capture command could not launch Chromium: `bootstrap_check_in … Permission denied (1100)`. No browser fallback was attempted. There are no implementation captures or paired images to inspect. `captures.md` gives the exact capture and pairing commands; `fixture-server.mjs` serves only in-memory data. Both temporary fixture/Vite servers were stopped.

Deliberate differences from Backups:

- The same Settings navigation, grouped status/destination/data/recovery sections and responsive wrapping use the existing v2 controls. Devices replaces the board's Notifications link to follow the current settings vocabulary. Icons use the available shared set (settings, folder, down and clock) instead of adding new shared glyphs outside scope.
- Summary text describes the returned records, with absolute localized timestamps and actual counts/sizes. The health rows include last-saved and test results; this adds wrapping compared with the board. There are no invented “6 projects”, “30 kept”, free-space values, passphrase-confirmation dates or nightly guarantees.
- Back up now, Add off-site copy and the house-location warning are omitted: they have no implemented contract or reliable source metadata in this slice. The existing job configuration remains unchanged. Destination rows include schedules and distinct recorded folders, and duplicate folders are collapsed.
- Test-restore now replaces the board's Test a restore/Check it wording. Recovery passphrase input appears only during rehearsal. The heading says “If your coordinator is lost” because this API does not provide its display name. Restore copies is an additional section once a copy exists.
- The fixture uses home-gym, SER, bazzite, Immich, Vaultwarden and deploy.local, with the board's sizes and three home-gym recovery choices. Its actual saved counts and status metadata drive the page. The live shared sidebar has fixture account/inbox/Live data but no task-history fixtures, so Today/Yesterday are omitted.

Deliberate differences from RestoreData/RestorePhone:

- The boards' one-step Restore database action contradicts the settled copy-first task. The implementation uses Restore to a copy, then Open the copy and I checked it · Switch. Check first/Switch/Undo replaces the board's immediate Downtime/Lost claims. There is no fabricated one-minute duration, workout count or migration reversal.
- “Data” covers non-database resources too. Native radio buttons select recorded dates, and each choice shows kind/size. The dialog includes test health and a Test-restore action; unavailable backups explain why. Ready/switching/Live/error states and Cancel are additional functional states. The previous backup and release link remain reviewable after switching.
- Live data is preserved before switching and afterwards; it is never replaced by the initial copy action. The code-only rollback notice is generic because arbitrary reverse migration commands are not available. No design files were changed, per the task's explicit boundary.

## Validation

- `pnpm install --frozen-lockfile`: passed; no lockfile/dependency changes.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with warnings, no errors.
- `pnpm format:check`: passed.
- `pnpm build`: passed.
- `node --test server/v2/backups.test.ts`: **10 passed, 0 failed**; `focused-tests.log`. Includes real graph execution with a fake Docker transport, copy isolation, actual Cancel cleanup, failed-backup restart, the final writer freeze, retained live bytes, owner scoping, test rehearsal, and service/HTTP release-conflict checks. All database/filesystem fixtures are temporary; no Docker containers were started.
- Full `pnpm test`: **710 tests, 693 passed, 4 failed, 13 skipped, 0 cancelled**; `full-suite.log`. The failures match earlier slice evidence in unchanged files: two CA-profile assertions under system LibreSSL, Home Assistant readiness in `catalog-api.test.ts` without Docker, and the Linux `/proc/self/fd` assumption in `legacy-preserving-update.test.ts` on macOS. This is not a green full-suite result.
- Full-suite execution used a temporary `DEPLOY_DATA_DIR`, unavailable Docker socket and stub Docker executable, and a temporary Node preload based on the existing slice-1 guard to restrict listeners to 5180–5199 and serialize test files. These constraints were not added to application infrastructure. No live coordinator calls or restores were made.
