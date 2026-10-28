# Slice 12, part 1: iPhone

This is an implementation handoff, **not completed visual acceptance**. No paired screenshots were produced. `simctl list`, `simctl io booted screenshot` and `simctl push booted` cannot connect to CoreSimulatorService in this sandbox. See `screenshot-blocked.log` and `simulator-push-blocked.log`. No browser facsimile or copied design render is presented as an app screenshot. All 20 source boards were inspected in a contact sheet; the running native screens could not be inspected.

## Implemented

- The existing `scripts/build-design-tokens.mjs` now regenerates all light/dark colors and space/type/size/form/radius constants in `WorkspaceStyle.swift`. Existing Mac-facing names remain as aliases. Regeneration is deterministic. No design source changed.
- iOS uses `DeployV2Root`, with Work, Projects, Live, Computers and Settings. Sign-in and the project hub compose the existing shared views without editing their sources. All new UI is guarded by `os(iOS)`.
- `V2Client` consumes inbox, long-poll events, Live and app health, projects, workspace tasks/messages/diffs, computers and user. It sends `on: iphone`, resolves 409 by reading the winning answer, and feature-detects projects on 404/501 (accepting both an array and `{ projects }`). Authentication failures do not trigger project fallback.
- The observable store caches last-known snapshots by account/coordinator, suspends polling in the background, and saves drafts before dispatch. Task creation and message IDs survive lost responses, relaunch and reconnect. Definitively rejected drafts require review; ambiguous sends cannot acquire a fresh operation ID. No credentials are written into the cache. Decisions cannot be answered offline.
- Work, answered history, in-context decisions, Live groups, worker health, project lists, read-only computers/settings, task chat/changes/checks, folded agent days, info and conversation menus are implemented. Typed conversation events are rendered; legacy messages are adapted only using their explicit user/assistant roles.
- The composer has per-chat model selection, project/computer selection, a question/change choice, system PhotosPicker, Files and camera. It never enumerates or requests access to the photo library. Picked files are retained locally, with remove controls and size limits.
- `POST/DELETE /api/v2/devices` persist owner-scoped registrations in generic records; no schema migration. APNs uses HTTP/2 and cached ES256 JWTs, with per-device delivery acknowledgement, failed-delivery backoff, invalid-token removal, inbox deduplication and transitions into failing. Background consumption also refreshes inbox/Live for registered users while phones are closed.
- The iOS notification delegate registers categories and tokens, checks notification account/coordinator scope, resolves offered actions through the inbox, surfaces failed answers as a local notification, and opens inbox/app routes. Approve and Not now require unlocking. Confirmation-required and free-text decisions use Open. Simulator entitlement and camera usage declaration are included.

## Unfinished behavior and API boundaries

These are outstanding work, not parity claims:

- **Question routing:** the existing workspace API only has tasks and task messages. Questions use a retained conversation task; there is no server-side question-versus-change classifier or authoritative Scout/Warden conversation lookup. Agent conversation associations are local to this iPhone. This does not yet meet the full “a question gets an answer; a change starts a task” routing contract across clients.
- **Attachment delivery:** no workspace upload endpoint exists in this branch. Photos/camera/files are picked and saved locally, but Send is disabled while they are attached. No bytes are silently dropped or sent as fabricated references. App screenshots and project-file picking await the attachment API. AttachedPhone is therefore incomplete.
- **Agents:** info uses existing task/inbox records. Schedules, learned preferences, per-agent task attribution, server mute/pause/tune and canonical agent conversations are absent. The menu has search, info and sharing, with the unavailable actions explained; AgentMenuPhone is incomplete.
- **Projects:** project listing and fallback work. The board's PR/issue counts and project metadata are unavailable from the current list; existing project hub composition offers available detail. Release detail/migrations/rollback progress remain part 2.
- **Settings:** decisions/failing-app notification permission reflects actual iOS settings; quiet hours are managed by iPhone Focus. There is no coordinator notification-preferences endpoint, so the board's editable switches and exception rules are not invented. Backups/approval details remain on a computer.
- **Push acceptance:** HTTP/2 stub and native action-client tests pass, but real APNs credentials, signed device provisioning, simulator interaction and lock-screen screenshots are unverified. This slice does not configure physical-device signing. Distribution needs the app's APNs capability/entitlement and a topic matching its provisioned bundle ID. Sandbox/production is selected by Debug/Release.
- **Build/visual gates:** XcodeGen succeeds. Both requested `xcodebuild` targets fail during package manifest resolution with `sandbox-exec: sandbox_apply: Operation not permitted`, before app compilation. SwiftPM builds the entire package for macOS and the arm64 iOS Simulator; separate Swift 6 compiler checks of both app entry points pass. These are useful checks, not substitutes for a signed Xcode app build or simulator acceptance.

## Board differences to review on a simulator

Native system text, status bar, navigation/sheet/keyboard controls and SF Symbols replace the canvas's web-rendered approximations. The application uses the v2 color mirror. No pixel or spacing parity is claimed without captures.

| Board          | Deliberate difference or unfinished portion                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HomePhone      | Uses actual task statuses/times and available agent context; no invented work summaries. Answered is directly accessible beside Waiting on you.                                                       |
| ComposePhone   | Real keyboard and native sheet; explicit question/change choice while routing API is absent. The computer chip names an available worker rather than promising an unimplemented scheduler.            |
| TaskPhone      | Native segmented Chat/Changes/Checks. Work logs start folded and expand. No Ship action is added in part 1.                                                                                           |
| AskPhone       | Renders available typed replies/decisions; canonical Warden routing is not implemented.                                                                                                               |
| ChangesPhone   | Lists returned files and patch; per-file line counts and “8 more files” aggregation are not fabricated from incomplete diff metadata.                                                                 |
| AttachPhone    | PhotosPicker, camera and Files are native. Screenshot/project-file actions explain their missing endpoint.                                                                                            |
| AttachedPhone  | Local file chips/removal exist; upload/send is blocked with an explanation. No claim of files saved on a task computer.                                                                               |
| ModelPhone     | Shows models actually offered by the selected computer. No invented usage percentages, cross-provider defaults or review-model rule.                                                                  |
| AnsweredPhone  | Shows authoritative answerer, source, time and chosen action; does not invent subsequent “healthy/released” outcomes.                                                                                 |
| LockScreen     | OS controls lock-screen presentation. Requested Approve/Not now/Open actions supersede the board's Review label. Confirmation-required items open the app. No screenshot or simctl action acceptance. |
| OfflinePhone   | Cached data is greyed, answers disabled, queued drafts visible. Keeps “Only on your home network”; no remote-access row.                                                                              |
| LivePhone      | Displays every waiting rollback decision and measured health groups. State labels remain Healthy/Warning/Failing/Stopped; summaries carry the cause.                                                  |
| WorkerPhone    | Shows available measured health and release siblings. No invented migration row or reversible-release promise.                                                                                        |
| Phone          | Warden's decision uses inbox actions and first-answer-wins behavior; authoritative release narrative depends on server events.                                                                        |
| ProjectPhone   | Uses available projects/tasks/apps plus the existing project hub. PR/issue summaries and release detail need project APIs.                                                                            |
| ComputePhone   | Read-only computers and offered models. No Add control, guessed disk/usage values or unverified Busy state. Non-admin endpoint denial is explicit.                                                    |
| SettingsPhone  | Real account and iOS notification permissions; Focus replaces unsupported quiet-hour preferences. No invented device count or backup success.                                                         |
| ScoutPhone     | Folds past days and renders typed events and decisions. Agent conversation identity/brief scheduling still needs server support.                                                                      |
| AgentInfoPhone | Real task/inbox context; no fabricated schedule, learned counts or approval/model defaults. Per-agent attribution remains incomplete.                                                                 |
| AgentMenuPhone | Search/info/share are available. Server mute/pause/tune are not implemented; no nonfunctional action buttons.                                                                                         |

## Fixture and capture handoff

`fixture-server.mjs` runs only on loopback, default port 5189 (allowed range 5180–5199), never connects to a coordinator, and serves the board names/data. Its nine endpoint smoke checks passed. The preview process was stopped after checks; no live service/worker/container or physical device was changed.

1. Run `PORT=5189 node docs/evidence/v2/12-ios-1/fixture-server.mjs`.
2. Build DeployIOS normally in an environment that permits Xcode/CoreSimulator. Boot a 390-point iPhone simulator.
3. Run `IOS_APP=/path/to/Deploy.app bash docs/evidence/v2/12-ios-1/capture.sh` from the repo root. Only Debug simulator builds honor `--v2-fixture` and `--v2-board`; the origin must be loopback on 5180–5199.
4. The script captures raw simulator PNGs, normalizes them to 390 px, and calls the required `pair.py`. Inspect every pair and correct differences. AttachedPhone still needs upload work; AgentMenuPhone and LockScreen need native interaction before their captures.
5. `push.apns` is a fixture payload for port 5189/account gabriel; `GET /fixture/push` regenerates the correct scope for another fixture port. Run `xcrun simctl push booted local.deploy.workspace.ios docs/evidence/v2/12-ios-1/push.apns`, exercise Approve/Not now/Open, and verify the answer's `on` is `iphone`. Test stale answers and an offline action too.

## Validation

- `pnpm install --frozen-lockfile`: passed; generated tracked pnpm cache file restored.
- Before each commit: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` passed (lint warnings, no errors).
- `node --test server/v2/push.test.ts`: 9 passed. See `push-tests.log`.
- `swift test --package-path native/Apple/Packages/DeployKit`: initially blocked by nested manifest sandboxing. With `--disable-sandbox` and scratch/cache/config/security paths under `/tmp`: 27 tests passed (9 new v2 tests). See `swift-tests.log`. This flag disables SwiftPM's nested build sandbox; the session's filesystem restrictions remain in force.
- Full `pnpm test`: **660 tests, 632 passed, 4 failed, 11 cancelled, 13 skipped**, exit 1. See `full-suite.log`. Uses a temporary data directory, unavailable Docker socket, fixture-only failing docker binary, and the prior slice's test guard to restrict listeners to 5180–5199. Unchanged failures: two CA/OpenSSL assumptions, Home Assistant readiness with Docker unavailable, and Linux `/proc/self/fd` on macOS. The application HTTP suite's 11 tests cancel after its startup fetch fails with `UND_ERR_SOCKET`.
- iOS Simulator package build: passed; `simulator-package-build.log`. Both iOS and unchanged Mac app entry points pass direct Swift 6 typechecking against the built modules (`app-typecheck.log`, `mac-app-typecheck.log`; compiler sandbox warnings).
- Requested iOS/Mac `xcodebuild`: blocked as above (`xcode-ios-blocked.log`, `xcode-mac-blocked.log`). `xcodegen generate` passed. No signed build or running-app claim.

## Next slice

Keep this slice open until its API gaps and simulator/visual gates are complete. The only shared server change is one import and one `pushApi` dispatch. APNs configuration is `DEPLOY_APNS_KEY_PATH`, `DEPLOY_APNS_KEY_ID`, `DEPLOY_APNS_TEAM_ID`, `DEPLOY_APNS_TOPIC`; missing configuration logs that push is disabled. No key material enters logs or fixtures. Provider behavior follows [Apple's token authentication documentation](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).

Releases should continue publishing typed inbox/health events; no direct push hook is required. Preserve `item.actions`, first-answer-wins, and `on: iphone`. Native project loading accepts an array or `{ projects }` and falls back only for 404/501. Add authoritative attachment and agent-conversation APIs before replacing the explicit unavailable states. Do not treat the local question conversation association as a shared server contract.
