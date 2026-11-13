# Project workspace implementation evidence

Current client ownership: Electron in `desktop/` is the Mac, Windows and Linux app. The Swift Mac target has been retired under cleanup step 9; `native/Apple` remains the iPhone app. References to Swift Mac builds below record the earlier implementation.

Updated: 2026-10-15 (America/New_York)

This branch implements a shared project/task harness, repository collaboration, and mesh CI/CD pilot.
It does not finish the full [project workspace plan](project-workspace.md) or retire live Groffee.
The portable-site runtime, entry points, and packaging have been removed; shared legacy schema/module cleanup remains.
The owner approved removing its data inventory on 2026-11-13. No portable-site data inventory is
required. This decision supersedes the earlier inventory prerequisite; dated evidence below remains
history. See [the one-server plan](one-server.md) for the remaining cleanup sequence.
No live repositories, deployment data, Git remotes, or production services were migrated/restarted.

## Current acceptance priorities (October 15, evening)

Codex and Claude subscription workflows are the release focus. The compatible endpoint remains
available for larger models; Qwen3-8B quality is no longer a release blocker, per the user's decision.
Its observed failures below remain evidence, not work scheduled for more model-specific tuning.

Automatic approval continuation passed with both Codex and Claude: one user prompt, one approval,
exactly one scroll/click, verification, and agent cleanup. Claude is signed in with its subscription.
Physical iPhone HTTPS sign-in, Codex/Claude cross-surface continuation, coordinator reconnect,
draft retention, and signed-update login retention now pass. Physical iPhone Wi-Fi recovery,
expired-session renewal on all three clients, and macOS credential retention/LAN HTTPS now pass.
The current remaining gates are listed below; distribution acceptance remains open.
The 21-minute Codex run, coordinator/client reconnect,
durable retry journal, and abrupt-worker-loss fencing checks now pass (see later evidence). Historical remaining-work lists below describe
that stage of the pilot; later dated evidence supersedes them.

## Current remaining gates

The subsequent reference-led design pass is documented in
[the design review](design-review-2026-10-15.md), with actual matched captures in
`docs/evidence/workspace/design-review/`. Mac, iOS simulator, and signed physical-device builds
passed; updated Mac and iPhone apps were installed. Navigation, disclosure, model pickers,
draft entry, and Mac draft preservation were checked interactively. The iOS screenshots for
this pass are simulator captures; installation on the physical phone is not visual acceptance.

This list supersedes historical remaining-work lists farther down this chronological evidence log.

- **Device lifecycle:** actual Mac sleep/wake and reboot, additional OS/device coverage. Sleep/wake
  listeners now save drafts and restart event polling; real sleep/wake remains unverified.
- **Performance:** end-to-end event-to-render p95 and typing/scrolling with live
  window capture. The warm loopback API measurement below excludes rendering and LAN latency.
- **Shared questions:** macOS and iOS simulator UI continuation pass with Codex and Claude.
  Physical-device question interaction remains pending because iPhone Mirroring timed out.
- **Provider parity:** native provider questions, permissions and steering beyond the supported
  execution/control-approval flows. Codex and Claude are the current release focus; Cursor and
  small Qwen quality are not gates for this release.
- **Computer control:** wider application compatibility, remote viewing/input, monitor scaling,
  lock/disconnect/permission-revocation coverage. Bounded TextEdit acceptance is complete.
- **Distribution:** production signing/notarization and update delivery. The installed Apple
  Development apps are pilot builds; this is not public distribution acceptance.
- **Retirement and recovery:** shared legacy module/schema cleanup, single-home upgrade rehearsal,
  finish the Groffee archive (seven unreadable root-owned files), explicit live cutover, online
  retention/remote-worker backup and a complete fleet restore drill. Live data remains unchanged.
- **Daily use:** one week across ordinary and native/game work. This requires elapsed real usage.
  Windows execution is deferred; Fedora/Ubuntu desktop clients remain a later release.

## Implemented and checked

- Projects are the browser dashboard entry point, with direct Applications/Computers access.
  Projects use workspace API authentication independently from deployment dashboard data loading.
- Hosted bare Git repositories, initialized projects, import from local committed history or Git
  remote, authenticated Git HTTP clone/fetch/push, and dedicated per-task worktrees. Local dirty
  source changes remain untouched and are not included in an import.
- Owner-scoped projects/tasks/conversation/runs, monotonic durable events/cursors, operation
  deduplication, payload collision rejection, task revisions, exclusive task writers, and persisted
  messages. Provider completion moves a task to review, not automatically to done.
- Independent ordinary-user local worker: real Codex CLI JSON events, retained session reference,
  follow-up resume, command/tool evidence, cancellation of process groups, partial file retention,
  and unresolved writer state after an ambiguous worker restart.
- HTTP worker protocol: sticky explicit placement, unique online process identity, assignment
  generation, ordered events and durable acknowledgments, local spool bounds, cloned worker-local
  working files, remote diff evidence, and no automatic reassignment on disconnection.
- Scoped worker enrollment tokens: only the enrolled identity and assigned Git reads, no client
  commands/unrelated repository access/Git writes. Worker secrets are not passed into agent child
  environment. Worker provider credentials stay on the worker.
- Diff/check review: tracked and bounded nonignored untracked textual content; private env/key,
  oversized, and unsupported files are explicitly listed as excluded. Local shell checks queue durably and execute asynchronously in the independent worker; they retain
  command, output, status, timeout/cancellation evidence, and exit status without blocking the API. Remote check recipes are unsupported and disabled in UI.
- A second `compatible` adapter implements an actual provider-independent tool loop against an
  explicitly configured Chat Completions-compatible endpoint. It has repository reads/writes,
  search/listing, shell commands, retained context, usage, cancellation, and bounded tool steps.
  Model/endpoint/billing mode must be explicitly configured; it never falls back to another model.
  Cross-adapter handoff uses a bounded shared transcript summary and separate provider sessions.
- Production build includes independent local/HTTP worker and compatible-runtime bundles.

Nine focused server integration tests cover Git/worktree/import/clone/push; duplicate commands
and revisions; independent worker execution/resume/cancellation; HTTP assignment and event replay;
untracked/excluded review; HTTP worker authorization and competing identities; operation payload
collisions; asynchronous check responsiveness/idempotency/writer fencing/process timeout and stop cleanup; and the compatible tool loop against a synthetic local provider. TypeScript checking
passes. Browser production build passes. The synthetic provider test proves protocol/tool execution,
not the quality or entitlement of any additional real model.

## Live disposable pilot evidence

Only `/tmp/deploy-workspace-qa-20261014` and separate
`/tmp/deploy-workspace-http-worker-20261014` contain pilot state. API uses loopback port 17843,
Vite uses 15173. The preview reuses existing account/session storage but does not start deployment,
Docker, portable-site, or fleet reconciliation loops.

- Real authenticated Git HTTP clone, local commit, and push succeeded.
- Real Codex read of imported `README.md` returned the expected heading through persisted events.
- A follow-up resumed the retained Codex thread and completed successfully.
- Exact model alias `gpt-6.1-sol` was rejected by the installed CLI's ChatGPT account catalog.
  That failure remains visible; an independently requested default-model run succeeded. The app's
  display names must not be assumed to be valid CLI model IDs.
- A separate worker process using a different disk root cloned the authenticated repository over
  HTTP, ran real Codex, uploaded acknowledged events, and completed with the expected heading.
  This validates transport/process/storage isolation on one Mac, not a second physical machine.
- Fresh browser login and project rendering passed with no page errors. Parent task owns native
  macOS/iOS build, visual checks, and shared conversation continuation evidence.

## Apple clients and visual acceptance

Two Swift application targets now share the `DeployKit` package under `native/Apple`.
macOS and iOS simulator builds pass on Xcode 27 / Swift 6.4. Three Swift tests pass, including
three credential-redirect cases, origin restrictions, and replay deduplication.

Observed through the actual interfaces on this computer:

- macOS: sign-in, create a hosted repository, Command-N task creation, Command-Return dispatch,
  and a real Codex task creating `hello.js` / `package.json` and successfully running `npm test`.
- iOS 27 iPhone 18 Pro Max simulator: sign-in, navigate to that task, send a follow-up to the same
  Codex session, and inspect the generated-file diff in the compact tools sheet. Login survived
  reinstall/relaunch after adding the simulator-only Keychain entitlement.
- Browser: same task and iOS follow-up result, generated source patches, successful checks,
  and editing a draft while an asynchronous five-second check was running. Cancellation of a
  longer check was exercised through the Stop control.
- Fixed during visual testing: browser authentication loop, unreadable theme contrast, cramped
  page layout, iPhone compact navigation/tool access, and simulator Keychain entitlement.
- Fixed during review: coordinator-blocking check commands, cross-origin credential redirects,
  native retry payload preservation, stale connectivity errors, and native code-block whitespace.

The Mac locked before the final native rebuild could be visually rechecked. The resulting source
and both builds are verified, but native post-rebuild Keychain/session fallback, final durable-check
rendering, and final Markdown layout need a follow-up visual pass after unlock. Ad hoc macOS binary
updates can invalidate access to an older Keychain item; the app avoids blocking system prompts
and supports a session-only sign-in with an explicit warning. Proper distribution signing remains
unconfigured. Physical-iPhone and second-physical-machine acceptance remain outstanding.

Browser screenshot: [workspace acceptance](../evidence/workspace/browser.jpg).
Build/setup instructions and native limitations: [Apple README](../../native/Apple/README.md).

## Reuse mapping and retirement boundary

Groffee inspection covered `packages/git/src/index.ts` and
`packages/web/app/api/routes/projects.ts`. Its useful contracts are ordinary bare Git plus
smart HTTP, committed source identity, owner authorization, revision-checked task mutation, and
review evidence. This slice adapts those storage/protocol contracts to deploy.local's native
Node HTTP authentication and SQLite ownership; it does not import Groffee's Hono/Drizzle identity
or create a second writable board. The dirty Groffee checkout was not changed.

Groffee repository/LFS/issue/PR/review/user/credential/pipeline inventory, durable ID mapping,
verified backups, rehearsed rollback, and cutover remain unfinished. No Groffee service can yet be
retired. LFS support and asset storage/retention are not implemented by this pilot.

The portable-site runtime is removed. The remaining schema, Home identity, application, and recovery
dependencies are tracked in [the one-server plan](one-server.md). No portable-site data inventory
is required under the owner’s 2026-11-13 decision. Ordinary node enrollment, application storage,
and Home recovery remain supported; their shared code is retained while those dependencies are
separated. The October 15 retirement evidence below records the earlier boundary.

## Remaining acceptance work

- Physical second worker and physical iOS device; LAN/TLS setup, sleep/reboot/network loss,
  long-run durability, retention/storage exhaustion, recovery reconciliation UI, and telemetry.
- Real independent model endpoint and model quality/tool compatibility; additional existing-agent
  adapters after their documented account/entitlement constraints are validated. No paid model
  request was made by the compatible protocol tests.
- Provider permission/user-question round trips and steering. CLI cancellation/resume do not imply
  these unsupported capabilities. No browser/computer automation bridge exists in the adapter.
- Worker-backed browser/computer sessions, capture/input authorization, target identity, takeover,
  adapter tool exposure, and cross-client observation. Native preview/capture UI alone does not
  satisfy the full browser/computer-use milestone.
- Model discovery per worker, explicit OS/toolchain inventories, enrollment/revocation UI,
  remote check commands, and recovery/retention for existing task checkpoints.
- Versioned generated Swift/TypeScript bindings and shared replay fixtures; performance traces,
  long-history pagination/virtualization and input/scrolling measurements.
- Application context and repository integration with the existing `deploy.yaml` deployment flow, native/game output acceptance,
  Groffee migration, remaining portable schema/recovery cleanup under the one-server plan, and a week of daily-use pilot evidence.

## Host execution and remaining blocking work

Task worktrees separate Git/file ownership; they are **not security sandboxes**. Checks and the
compatible adapter's shell tool execute on the worker host as its ordinary user, with that user's
filesystem/network authority. Provider API keys, model session paths, and worker credential/config
variables are removed from tool/check subprocess environments. The model request process retains
its configured provider key to authenticate inference. This environment filtering does not prevent
a trusted host shell command from reading other files available to its OS user.

Repository creation/import now runs in the independent repository service described below.
Large task worktree preparation also runs in the independent repository service. Task diff
inspection remains synchronous, and its performance acceptance is still outstanding. Import/check responsiveness is measured by
their dedicated tests and does not establish overall performance acceptance.

## Visual redesign verification (October 14, 2026)

A SOL 6.1 design agent used the installed frontend-design skill and downloaded actual product references. Sources and visual decisions are documented in `docs/design/reference-sources.md`; native layout review is in `docs/design/native-direction.md`.

- Web: full-height conversation shell, quiet repository/task navigation, optional review panel, readable Markdown and code, compact growing composer, human-readable run/check results, responsive navigation. Shared dashboard colors/navigation typography were aligned with the new workspace; this is not a full redesign of every legacy feature page.
- Apple: compact native navigation, optional inspector, smaller composer, editable model sheet, readable Markdown/code, structured check results, accessible contrasting diff additions/deletions, and top-aligned iOS forms. Removed the nonfunctional computer-control tab from primary navigation; browser remains a manual preview.
- Real UI verification: web project/task creation, keyboard send through Codex, successful npm test result, draft restoration, review/check output, desktop/mobile navigation. The resulting conversation appeared on macOS and iOS. A Mac-triggered `git diff --check` passed and appeared in iOS review. Native model sheets, iPhone back navigation/review, Mac keyboard inspector shortcut and selectable source diff were inspected.
- Validation: web typecheck and production build pass; macOS and iOS Simulator builds pass; Swift tests pass (three tests, including three redirect cases). Physical iPhone testing and production distribution signing remain unverified.
- Screenshots: `docs/evidence/workspace/web-redesign.jpg`, `macos-redesign.jpg`, `ios-redesign.jpg`; corresponding `*-review-redesign.jpg` files show changes/checks. iOS screenshots are actual Simulator app views; Mac follows the computer's dark appearance.

## Codex information hierarchy pass (Astra high)

The next pass uses a top-level Tasks section for independent conversations and collapsible project
folders containing their own tasks. A global New task action opens an inline first-message composer;
Project is optional. Per-project + starts with the project selected. Search covers both groups.
Existing sidebar selection and revision-safe actions remain; web polling now guards against stale
selected-task responses. Shared native navigation mirrors this grouping and first-message flow.

Projectless tasks are real owner-scoped records with `projectId:null`, isolated scratch directories,
and no synthetic project. Their deterministic empty Git baseline supports diff review on local and
remote workers. Remote assignments explicitly return `project:null`; remote work never implicitly
moves to another machine. HTTP assignment/baseline tests cover this path; a second physical host has
not been exercised for projectless work.

Validation: 11 backend tests pass, 4 Swift tests pass (including nullable and project-backed task
payloads), both Apple app builds pass. Web typecheck/build pass. Browser QA created and ran a real
independent task, created a project and started a nested task with the keyboard shortcut, switched
between existing project tasks, searched, collapsed groups, and verified narrow-screen navigation.
Evidence is in `docs/evidence/workspace/web-hierarchy-*.jpg`.

Native visual review was subsequently completed after the Mac was unlocked; see the fresh
typography evidence below. Earlier `*-redesign.jpg` files show the previous hierarchy.

## Typography, iconography and spacing refinement

Astra refined the web’s type scale (13px navigation, 15px body/prompt, 28px new-task heading), secondary
contrast, SVG optical sizes, common folder/task text edge and conversation/composer inset. Context
selectors size to their selected value while retaining native keyboard-accessible select controls.
The mobile conversation/composer share a 31px text edge. Native shared type/icon metrics align folder
children and composer text, increase phone row targets and tighten the new-task layout.

Web typecheck, scoped lint, formatting and production build pass. Native builds pass. After unlock,
fresh browser captures verified the new-task and independent-conversation layouts. The latest Mac
build was relaunched and connected; the latest iOS build was installed and opened in Simulator.
Native inspection covered grouped navigation, existing independent and project conversations,
global New task, project-prefilled New task on Mac, Cmd-N, Cmd-Shift-I, and expanded diffs in the Mac
inspector and iOS review sheet. Both clients show the same existing workspace data. This visual
pass did not submit another agent run or test on a physical iPhone.

Fresh screenshots are `docs/evidence/workspace/deploy-web-type-*.jpg`,
`deploy-mac-type-*.jpg`, and `deploy-ios-type-*.jpg`. Mac uses the system dark appearance and iOS
Simulator uses light appearance. Remaining visual refinements: Mac new-task project/computer
pickers are unnecessarily wide, and iOS composer/search placeholder contrast is faint. The
`web-type-before-*` files remain prior baselines.

## Codex reference and elevation pass

The user's iPhone Codex screenshots are the direct reference for lightweight navigation and floating
controls. The iOS sidebar now uses compact header actions, an on-demand search field, project compose
icons, and a raised bottom New task action. Task timestamps are omitted on iOS to prioritize titles.
The conversation composer is a growing capsule with an agent/model menu. Its placeholder contrast
was corrected. Mac retains keyboard-oriented navigation and gains material-backed composer surfaces
and compact context menus sized to the selected value. Conversation text and project rows remain
visually quiet; elevation is reserved for interactive surfaces.

Web uses a near-white canvas, white raised composer/context controls, and an inset floating review
panel. Shadows have distinct small-control and floating-panel levels. The sidebar remains subdued.

Both final Apple builds pass. Visual QA inspected macOS dark appearance, iOS Simulator light
appearance, desktop web and 390px mobile web. Verified Mac Cmd-N and project menu selection, iOS
agent menu/model sheet and multiline draft entry (the temporary draft was cleared without sending),
and web review-panel toggling. The simulator used hardware keyboard entry; software-keyboard layout
and physical-device testing remain unverified in this pass. Evidence: `deploy-*-depth-*.jpg` in
`docs/evidence/workspace`. CSS formatting passes. No backend changes or new agent runs in this pass.

## Agent coordination implementation — October 15, 2026

Implemented a shared six-tool coordination surface for computer discovery, source checkpointing,
asynchronous jobs, result recovery and cancellation. Codex uses the stdio MCP bridge; the compatible
model loop exposes the same functions. Added the Claude Code CLI adapter with session resumption,
MCP injection and normalized conversation/tool events. Jobs use isolated checkpoint directories and
a separate execution loop, allowing the coordinating agent to keep running. Owner/task-scoped run
credentials, operation replay checks, worker-instance/generation fences, timeouts and restart-unknown
states are enforced in the control plane. See `workspace-api.md` for the contract and pilot limits.

The shared task detail includes jobs; web and both Apple clients show status, computer, checkpoint,
output and cancellation in the conversation. The native model's optional jobs field preserves
compatibility with older coordinators. Source remains in the primary task workspace.

Acceptance used real separate local and HTTP worker processes on this Mac. A real Codex run captured
two source files, dispatched `node --test sum.test.mjs` to both workers before collecting results,
and reported both successful exit codes from the same checkpoint. A separate long-running job was
cancelled through the web UI, and its terminal state appeared on macOS and iOS Simulator. Visually
verified expanded job output on all three clients. Preview task: “Coordinate checks across computers”.
Evidence: `docs/evidence/workspace/deploy-{web,mac,ios}-coordination.jpg`.

The deterministic backend suite covers snapshots, isolation, credential scope, retry conflicts,
timeouts/cancellation, restart fencing, MCP-to-HTTP execution, and Claude event/error normalization,
alongside the original workspace suite. Typecheck, production web/server build and both Apple builds
pass. Live Codex MCP execution passes after configuring per-tool approval for this first-party server.
The real Claude test reached its CLI but was blocked by an expired OAuth session; authenticated
Claude execution must be repeated after sign-in. Physical Linux/LAN execution has not been tested.

The Markdown pipe-table gap observed in coordination acceptance was resolved in the conversation
refinement below; both web and native now render semantic tables.

## Conversation refinement — October 15, 2026

Computer names now sit immediately left of conversation status, with a compact second row on
narrow layouts. Removed duplicated placement labels. Sidebar project names use a clearer type
level above chats, aligned indentation, quieter selection and no inactive timestamp clutter.

Web uses react-markdown/GFM with syntax highlighting; Apple uses pinned MarkdownUI 2.4.1 with
semantic light/dark styling. Both support tables, nested and task lists, quotes, links, images,
headings and fenced code with copy controls. Wide content scrolls within the message. Raw HTML
and executable link schemes are not enabled. Message rendering is memoized across task polling.

Verified desktop web, 390px web, macOS dark appearance and iOS Simulator light appearance.
Native code-copy contents were verified by pasting into an empty draft and then clearing it;
web copy showed success (the browser automation virtual clipboard does not mirror the page clipboard).
The rich preview is an explicit formatting fixture, not a claim of physical Mac Studio/Linux execution.
Both Apple builds, web production build/typecheck, scoped renderer lint, two semantic/safety
renderer tests and four Swift tests pass. Screenshots: `docs/evidence/workspace/deploy-*-rich-*.jpg`.
Physical iPhone and Dynamic Type extremes remain unverified.

## Project shortcuts and model controls — October 15, 2026

Added a muted New task row above chats in every expanded project, with the project preselected.
Web, macOS and iOS now show Agent / Model / Effort controls in both new and existing conversations.
Custom model IDs remain available. Codex suggestions use the installed app-server's `model/list`
with pagination and bounded asynchronous refresh; a disk cache proved insufficient because another
client's catalog included a model the worker rejected. Claude offers its model aliases and effort
flag. Compatible endpoints accept model IDs but do not advertise an unimplemented effort mapping.

Model and effort are validated before writing a message, stored on each run, passed to local and
remote executors, and restored from the latest run when opening a task on another surface. Provider
errors now produce a failed task status instead of Ready to review. Choices apply to the next run;
active runs keep their original settings. Provider/account policies remain authoritative.

Acceptance: the web project shortcut created a task with GPT-6 Astra and low effort, the real Codex
CLI completed it, and macOS restored both values from that task. The initial GPT-6.1 Sol attempt was
rejected by the worker account and retained as a failed run. Native model/effort menus and project
shortcut, iOS visible controls, desktop web and 390px wrapping were visually checked. Both Apple
builds, production build, typecheck, scoped lint, 19 backend tests and four Swift tests pass. Claude
flag forwarding is covered with a subprocess fixture; authenticated Claude execution still requires
renewing its expired sign-in. Evidence: `deploy-{web,mac,ios}-model-effort.jpg`.

Integration references: [Codex model discovery](https://learn.chatgpt.com/docs/app-server#list-models-modellist),
[Codex effort configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
and [Claude model/effort configuration](https://code.claude.com/docs/en/model-config).

### Provider usage footer (2026-10-15)

Web and shared Apple sidebar now expose per-worker provider status, the highest-used allowance as a compact meter, and expandable per-window percentages, remaining amounts, reset dates, and freshness. The footer follows the conversation worker or the selected new-task computer. Offline/old observations are marked stale; missing usage is never shown as zero. Metadata refreshes asynchronously once per minute, keeping `/state` responsive.

Codex reads `account/read` and `account/rateLimits/read` through its installed app-server. Prefer the multi-bucket response; omit account identities, credentials and untyped credit balances. Claude reads `claude auth status`; this integration does not yet collect its session-dependent status-line usage, so signed-in Claude accounts explicitly show usage unavailable. A signed-out account gives the CLI sign-in command on the execution computer. Remote worker registration forwards only bounded, allowlisted display fields.

References: https://learn.chatgpt.com/docs/app-server and https://code.claude.com/docs/en/statusline .

Validation: real Codex Pro account returned a weekly window at 91% used; Claude reported signed out. Web disclosure, reset display, phone-width layout, and changing computer were visually checked. Provider parser/process tests cover missing data, multiple buckets, zero values, failed/timeout CLI processes, chunked responses, and credential stripping. Worker registration and native compatibility decoding are covered. Native builds pass; visual checking is pending because the host screen locked during this pass.

## Repository server integration — October 15, 2026

Added a supervised Git storage service and durable create/import/fetch/cancel/retry operations.
Repository creation now returns immediately, with visible setup state; active imports no longer
hold the coordinator event loop or command transaction. Imports stage storage before atomic
publication, preserve dirty source files, initialize empty repositories, and explicitly make the
hosted copy authoritative. Manual fetch updates upstream-tracking refs without changing task or
hosted branches. Unknown operations require an explicit retry, fenced against a live old Git process.

Added bounded commit-pinned tree/blob/history/diff reads, task creation from a selected Git revision,
setup diagnostics, and robust streamed smart HTTP with client-abort and startup-error handling.
The production supervisor starts the Git service; development/legacy setups have a separate command
and doctor. Source hooks/templates are disabled, embedded remote credentials rejected, and the
existing owner/worker Git authorization is preserved. The application UI is unchanged for the
user's next pass; its setup/progress/retry contract is documented in `repository-server.md`.

Acceptance uses a real repository-service process and HTTP Git clients in disposable storage.
Tests verify slow-import responsiveness, replay, owner isolation, dirty imports, clone/push, exact
source browsing/tasks, safe upstream fetch, empty sources, errors/cancellation/retry, process fences,
and recovery of atomically published storage. No live service restart, source remote change,
Groffee migration, or portable-site retirement was performed.

Task checkout preparation was subsequently moved to the durable service as well after acceptance
caught a SQLite read-to-write upgrade race during checkout. Command transactions now reserve their
short write window immediately, and copying files happens outside the coordinator. First messages
queue while preparation runs; both worker transports fence execution until ready. Preparation has
cancel/retry/error/restart states and preserves partial files. Remote project tasks avoid redundant
coordinator checkouts; task-specific Git refs retain the selected source for remote fetch. Added
acceptance verifies the first prompt waits for a delayed checkout and executes afterward exactly once.

Final verification: all 29 workspace tests pass, TypeScript checking and production build pass,
and the built repository worker/doctor pass a separate temporary-directory smoke test that creates
a repository and prepares a task checkout. The existing loopback QA preview and local coding worker
were restarted after confirming zero active runs; the preview now reports repository setup ready.
Production services remain untouched.

## Repository collaboration and mesh placement — 2026-10-15

Implemented owner-scoped project issues and pull requests with shared numbering, text/comments,
close/reopen, task/issue links, revision checks and operation replay. Task detail exposes reverse
links. Async PR comparison reads real Git branches; explicit fast-forward merges use the existing
repository queue. A single Git ref transaction verifies source/target and records a receipt.
Explicit recovery recognizes that receipt even if the target advanced after the original merge.
Git subprocess IO stays outside SQLite command transactions. No additional deployment file,
artifact-management system, recipe store, or live Groffee migration was introduced.

Extended existing agent jobs with optional OS/architecture/capability requirements. Unassigned
jobs wait with a reason and are atomically claimed by an eligible worker; the conversation's
primary worker stays unchanged. Already-running work is never reassigned after restart.
Windows remains a requested target in the protocol but its checkpoint-job capability is disabled
until the native runtime works; current command execution remains macOS/Linux.

Remaining: YAML schema/compiler extensions and job-only workflows without dummy applications,
worker toolchain discovery, pipeline dependencies/triggers/checks, existing deployment handoff,
client issue/PR views and scoped collaboration tools, broader PR reviews/merge strategies,
physical multi-platform validation, and the previously documented migration/retirement work.

Verification: 35 workspace tests passed (including five real-Git collaboration tests and mesh
placement regression coverage), TypeScript checking and the production build passed, and the
bundled independent repository service successfully completed a queued PR merge in disposable
storage. Scoped lint passed. The shared Apple package built and all six Swift tests passed,
including queued/unassigned job decoding. Existing web and Apple job cards now display the waiting
reason. No new issue/PR screens were visually tested, no live data was migrated, and production
services were not restarted. Evidence: `docs/evidence/workspace/project-collaboration.json`.

## October 15: repository collaboration and physical mesh release

This section supersedes earlier status statements for the features listed here. Windows execution
is deferred by the user and is not an acceptance gate. The complete original plan remains open.

Implemented:

- `deploy.yaml` pipelines with manual/push/pull-request triggers, branch selection, exact-commit
  execution, job dependencies, Linux/macOS capability placement, logs, cancellation, timeout and
  uncertain-outcome handling. Automatic PR jobs require containers; owner-started host checks are
  explicit. PR-associated runs never deploy. Latest successful checks must match the PR head.
- Durable publication through the existing CI release engine, preserving intent and predecessor
  across retries and recording the actual runtime receipt. This engine currently requires an
  existing healthy, non-privileged single built web component on the coordinator and unchanged
  application graph. Broader remote/external deployment targets remain unimplemented.
- Web/shared Apple repository, issue, PR and pipeline views; issue-to-task creation, comments,
  diffs, checks, merge, cancellation, and run logs. The scoped `deploy_project` tool uses the active
  task's project authority. Native builds pass; the latest native visual check is blocked by lock.
- Authenticated Git LFS batch/basic upload, verify and download; hash/size validation and project
  scoping; read-only LFS access for assigned workers; verified checkout and release-archive expansion.
  Actual Git LFS client push/clone passed. External import does not fetch external LFS automatically;
  use ordinary `git lfs push --all` to the hosted remote. Workers require git-lfs for these repositories.

Physical acceptance:

1. A disposable coordinator on SER dispatched a Linux container check, followed by a native Swift
   compile/run on this Mac, then activated a healthy Docker release on SER. All three steps used
   commit `39675288fb2822337f9d34355c0db236fc4a69b8`. The immutable receipt and job evidence are in
   [mesh-release-result.json](../evidence/workspace/mesh-release-result.json). The temporary worker,
   tunnel, and disposable application were stopped/cleaned after the test.
2. The browser created a PR, ran Linux and Mac checks, inspected the patch, and merged it. The target
   push triggered the configured pipeline. Screenshots: [issues](../evidence/workspace/project-issues-web.png),
   [pull request](../evidence/workspace/project-pull-request-web.png),
   [pipeline](../evidence/workspace/project-pipeline-web.png).
3. The latest shared Apple package tests and both native builds pass. No current physical-iPhone or
   final native visual acceptance is claimed. The Mac remained locked on the final inspection.

## October 15: Groffee migration rehearsal

Read-only live inventory found 13 repositories, 10 issues, 10 pull requests, one comment, and 27 LFS
objects totaling 1,035,036,560 bytes. No collaborator/organization access mappings or shared issue/PR
number collisions were present. Account credentials and SSH keys were not imported.

`scripts/workspace/groffee-snapshot.py` uses SQLite backup, independent Git mirrors with ref comparison
and fsck, verified LFS copies, and copies of historical files. `scripts/workspace/rehearse-groffee.ts`
imports only into a new empty destination, preserves repository/issue/PR IDs and numbering, binds LFS,
and retains old pipeline history as inert legacy records. A real rehearsal on SER verified all 13
projects, their Git heads, 10 issues, 10 PRs, one comment, and all 27 LFS objects.

The complete archival snapshot is **not finished**: seven root-owned historical artifact files are
unreadable to the account, and noninteractive sudo is unavailable. The rehearsal explicitly records
`cutoverReady: false` and `archiveSnapshotComplete: false`. It is not a production backup or live
migration. Historical merged PRs without original merge IDs return an explicit unavailable-diff
message. Live Groffee remains running and untouched.

## October 15: portable-site retirement boundary

Read-only SER inventory: one home site, 22 home application replica records, three nodes, nine
deployments; no portable sites, transfer rows, conflicts, sync cursors, data sync policies, pairing
codes, projected site users, authority transfers, component overrides or Suitcase capacity plans.

Removed from active product entry points:

- Suitcase pairing, transport, presence, credential rotation/readoption and cross-site fleet mutation
  HTTP routes; portable CLI commands and flags; Sites dashboard and command-palette navigation;
  access-proof polling; release-candidate controls and portable-site scale selection.
- Automatic cross-site reconciliation/authority-transfer startup sweeps and data-policy worker.
- Dedicated core/bootstrap/sync CLI entry files, Docker target packaging, image CI job and build
  outputs. Unused portable landing demo and retired entry-point tests were removed.
- Product documentation now describes one home coordinator plus execution nodes. The old Suitcase
  plan is explicitly historical. Read-only home topology remains for existing application UI.

An upgrade guard rejects portable coordinator mode, non-home site records and orphaned replicas
without changing their data. Home application identities, runtime records, routing, node enrollment,
volumes and ordinary recovery remain. Support diagnostics no longer import the fleet mutation handler.

This is **not complete module/schema retirement**. Shared application data contracts, identity/event
primitives, volume authority and recovery readers still refer to historical site fields. Legacy
modules and their unit tests remain until those dependencies can be removed without changing stored
revision digests or losing recovery compatibility. No production service was upgraded in this pass.

Validation: 35 focused home deployment/CLI/routing/backup/recovery tests passed; HTTP retirement
checks and home upgrade guards passed. The broad suite exposed five failures reproduced unchanged
from Git HEAD on this Mac: two CA/OpenSSL profile tests, Home Assistant capability readiness, SQLite
unique-value-swap reconciliation, and a Linux `/proc` assumption in legacy rollback testing. These
are baseline failures, not a clean full-suite result. TypeScript and production build results are
recorded in the final acceptance report.

## Remaining acceptance and implementation

- Complete shared legacy module/schema retirement and verify an actual single-home upgrade.
- Finish the readable archival snapshot, then plan live Groffee cutover separately; preserve credentials
  and historical records under an explicit migration decision.
- Broader remote/external release destinations, project-aware recovery/retention and restore drills.
- Claude reauthentication; provider permission/question/steering
  round trips beyond the currently supported CLI execution protocol.
- Worker-backed browser/computer automation, explicit targets, capture/control permissions, takeover,
  and cross-client observation. A manual browser preview is not that bridge.
- Physical iPhone, Linux desktop companion, generated shared
  bindings/replay fixtures, long-history performance, sleep/reboot/network-loss durability, and the
  week of actual daily-use evidence. These cannot be declared complete from build/test results.

## October 15: offline workspace recovery

Added `workspace:recovery snapshot|verify|restore`, also bundled as `dist/workspace-recovery.js`.
It streams filesystem content, snapshots SQLite, verifies against the source inventory, detects
concurrent changes, checks SQLite integrity, and flushes before publishing. Restore requires an
absent original path, preserves local worktree links and dirty/untracked files, and removes stale
worker identity/credentials so restored state cannot accept old remote workers automatically.

Two tests pass, including a real bare repository/worktree round trip, LFS bytes, conversation events,
checkpoint retention, dirty and untracked files, corruption rejection, pending-work rejection,
external-link rejection and non-overwrite checks. TypeScript passes. This is an unencrypted local
offline snapshot complementing home account/deployment backup; online backup, retention, relocation,
remote worker storage and a complete fleet disaster drill remain open. See repository-server.md for
commands and exact boundaries.

The offline recovery tool also passed against the real isolated Groffee import on SER: 13 repositories
passed Git fsck with identical refs, 10 issues and 10 PRs survived, and all 27 LFS objects totaling
1,035,036,560 bytes verified. Evidence: [recovery-result.json](../evidence/workspace/recovery-result.json).
The pre-restore rehearsal copy is retained. No live production state changed.

Checkpoint validation additionally rejects case/Unicode aliases and parent/file collisions before
materialization on Linux/macOS, including case aliases of private paths. Ten checkpoint, coordination,
and recovery tests passed together; this includes a real HTTP remote-worker round trip. Automatic
retention and cleanup are not implemented or enabled. No user checkpoint or workspace was pruned.

## October 15: Lemonade and native acceptance

The unlocked Mac enabled inspection of the latest macOS build and installed iOS Simulator build.
Both connected to the existing disposable mesh pilot on port 17849. Issues, merged pull request
details/check status, and Linux/macOS pipeline job logs displayed the same server records. Evidence:
`project-pull-request-macos.png`, `project-pull-request-ios.png`, `project-pipeline-macos.png`, and
`project-pipeline-ios.png` under `docs/evidence/workspace`. This is simulator coverage, not a physical
iPhone or distribution/signing acceptance result.

The user's existing Lemonade service on SER advertises downloaded `Qwen3-8B-GGUF` with tool-calling
capability at `http://ser.local:11434/api/v1/models`. The pilot coordinator and local coding worker
were restarted with its explicit base URL, model, and `local` billing mode. Production configuration
and model installation were unchanged. The adapter uses the documented
[Chat Completions tools protocol](https://lemonade-server.ai/docs/api/openai/).

An actual coding task began in the macOS composer, continued twice through iOS, and then continued
through the browser. All four runs used one retained session. The model wrote an ES module and
tests, exercised local shell checks, discovered computers, captured checkpoints, dispatched Linux
jobs, and collected their results. The final Mac and SER checks returned exit 0: three cases plus
the parent test passed. The first two turns exposed model mistakes (CommonJS in an ES module and
an invalid assertion API) and stopped after proposing fixes. Two explicit corrective prompts were
needed; this model is not accepted as an unattended replacement for the subscription agents.

Evidence and exact job results: [lemonade-acceptance.json](../evidence/workspace/lemonade-acceptance.json).
Screenshots: [macOS](../evidence/workspace/lemonade-macos.png),
[iOS Simulator](../evidence/workspace/lemonade-ios.png), [web](../evidence/workspace/lemonade-web.png).
The earlier failed check remains visible beside the successful check; its history was not rewritten.

Remaining refinements found during this acceptance: preserve literal code punctuation in iOS
typing (smart quotes/dashes changed entered prompts), stream compatible-provider responses, and
give local providers a clearer display name. Provider permission/questions, physical-device/LAN
acceptance, browser/computer control, and the other remaining plan items above are still open.

### Composer and dictation follow-up — 2026-10-15

Web and shared Apple UI now have a raised rounded composer with a single model/effort pill.
The model list groups Codex, Claude, and Local / API choices; choosing a model selects its
provider and clears incompatible effort. The popover offers discrete effort levels and reset.
Execution computer remains a separate context choice. The mic records a draft, transcribes on
stop, and inserts editable text without sending. Recording is capped at two minutes and cancelled
when leaving the conversation. Native recording uses PCM WAV; web recordings are decoded and
resampled locally to 16 kHz mono PCM WAV before upload.

The authenticated coordinator transcription endpoint forwards only to an explicitly configured
OpenAI-compatible endpoint, with a 12 MB input bound, per-user/global concurrency limits, a
90-second provider timeout, and no redirects. Audio is held in memory server-side; temporary
native audio files are removed after use. Worker credentials cannot access this operator endpoint.

The disposable pilot uses Lemonade on SER, Whisper-Base on CPU. SER's auto-selected ROCm Whisper
backend crashed. A per-model CPU override was saved for Whisper-Base; the temporary Large-v3-Turbo
override was removed. Large took about 17 seconds for the sample versus under one second for Base.
Lemonade rejected M4A/WebM, which motivated the client WAV normalization. Synthetic speech encoded
with the web helper was transcribed correctly through the authenticated coordinator in 861 ms.
See `docs/evidence/workspace/voice-acceptance.json`. Live microphone capture, permission prompts,
and physical iPhone behavior remain unverified; the native visual check uses Simulator.

### Actual microphone, response streaming, and SVG controls — 2026-10-15

Actual microphone capture passed in the macOS app and in-app web browser, using a short spoken test
sentence through the Mac audio output. Browser permission was approved by the user. Both stopped
recording, transcribed through SER, and placed the result in a draft without sending. Web preserved
existing draft content. Mac transcription included an extra `[Pause]` marker. Screenshots:
`microphone-macos.png`, `microphone-web.png`. Dictated text now resizes the web composer, and the
permission wait is distinguished from transcription. Physical iPhone capture is still unverified.

Compatible-provider inference now requests SSE streaming. The parser handles fragmented UTF-8,
CRLF framing, interleaved tool arguments, reasoning context, usage, and JSON-only responses. It
rejects incomplete/error streams before executing any tool calls. Partial assistant snapshots are
throttled to at most four per second. Local and HTTP worker paths upsert one run-scoped message
instead of duplicating replies; reconnect event replay preserves that identity. Web follows updates
only while the reader remains near the bottom. Fifteen focused tests passed, including worker
lifecycle/cancellation, remote replay, stream assembly and truncated-stream rejection.

A real Lemonade Qwen3-8B-GGUF run produced 16 observed partial updates, then one completed assistant
message. First text arrived after about 10.6 seconds (including model startup/prefill), and completion
after 18.6 seconds. Evidence: `streaming-acceptance.json`. The local pilot worker was restarted with
streaming enabled; the remote worker runtime still needs rollout of the updated source.

The web workspace now shares SVG icons for the model/effort control, usage disclosures, checks,
repository entries, and project status/branch controls. The model chevron is 14×14 and shares the
label's exact vertical center; no font-glyph caret remains in those controls. Native SF Symbols are
already vector icons and remain native. Browser/computer control is still the next implementation
area; this pass does not claim that bridge is connected.

### Control bridge and sidebar follow-up — 2026-10-15

The web workspace now has a raised navigation rail for Tasks, Applications, Computers, and
Settings. Provider usage appears only in the user-icon popover. The duplicate brand heading is
removed from the task sidebar; search is raised at its top, New task stays at its bottom, and the
project/task tree scrolls between them. Browser verification confirmed the pinned button opens
the composer. Screenshot: `../evidence/workspace/sidebar-search-pinned-task.png`.

An initial task-scoped browser/computer bridge is connected to local and HTTP workers, the shared
agent tool `deploy_control`, web Controls, and shared Apple Controls. The operator opens a target;
agent input requires an explicit release of control. Commands carry controller generations and
are claimed once. Takeover cancels queued input and waits for the worker to finish any input in
flight. Stop invalidates pending commands; ambiguous outcomes are never retried. Disconnect,
worker replacement, permission loss, or a 30-minute grant expiry suspends the session. A stopped
agent run cannot execute previously queued input. Local desktop ownership is exclusive across
accounts. Stop cannot undo an action already delivered to a target.

The opt-in browser runtime creates an isolated Chromium context per session. It captures a latest
JPEG, page accessibility text, and bounded console/network summaries. A real disposable browser
fixture passed navigation, keyboard focus, text entry, form submission, and Stop through the web
Controls UI. Page content showed `Saved: Shared browser bridge works`; Stop disabled input.
Screenshot: `../evidence/workspace/control-browser.png`. Command history and task events persist;
only the latest snapshot is retained, not a replay video.

The Mac helper compiles and checks Screen Recording, Accessibility, and unlocked-console status.
It implements main-display capture, pointer, text, keys, and scrolling. Mac and iOS Simulator
clients compile with the shared control panel. This is not yet desktop or cross-client acceptance:
actual helper capture/input, signed helper packaging, native takeover, Linux desktop control,
remote rollout, and a real model calling the control tool remain unverified. No production
configuration or permissions were changed. Windows execution remains deferred.

Validation for this follow-up: 26 focused control, coordination, and workspace tests passed,
including the real HTTP worker roundtrip. Type checking, production build, macOS build, and iOS
Simulator build passed. Browser UI acceptance above used the disposable pilot only.

## October 15: native takeover, desktop input, and Codex visual reference

Native takeover passed on the local pilot: the Mac claimed the task browser, the web client
reported another controller and disabled its inputs, and the Mac entered and submitted
“Native takeover works” in the disposable localhost fixture. Both clients observed its saved result.

With explicit user approval, the desktop helper captured the Mac display, then the test narrowed
to a disposable TextEdit window. Pointer targeting, text entry, Enter, a second text command with
the final geometry/focus guards, and Stop passed. TextEdit contained “Desktop bridge input verified”
and “Final window check” on separate lines. The web observed the same final window capture and
stopped state. All desktop sessions opened for this acceptance test were stopped.

The test exposed two real issues: input on the same machine could focus the controller rather than
the intended application, and a short changing window inventory could suspend a valid target.
The helper now identifies windows by window and process ID, focuses and raises the chosen window,
requires observed geometry before input, rejects moved/resized targets, and rejects display-wide
keyboard input. The stable window inventory supports up to 100 windows. Worker inventory is cached
for two seconds; the helper checks permissions again for every operation. Input uncertainty still
suspends the session without replay. UTF-16 chunking preserves surrogate pairs.

The user’s Codex screenshot supplied the visual direction. The Mac now uses a narrow utility rail,
a denser task sidebar, raised search, bottom-pinned task creation, account-only provider usage,
a darker conversation canvas, blue user messages, and a narrower floating inspector. Web uses the
same dark hierarchy when the system prefers dark mode while retaining its light palette. Both
control panels collapse target setup once a session exists. Mac account usage and final controls
were exercised in the running app. iOS shares the updated views and builds, but this pass did not
repeat iPhone visual acceptance. Native Applications navigation remains a parity item.

Validation: 27 focused control/coordination/workspace tests pass, including a 50-window reorder and
closed-target regression. TypeScript, scoped lint, production web build, macOS build, iOS simulator
build, helper compilation, and whitespace checks passed. This is local pilot acceptance; remote
control rollout, real-model control-tool acceptance, signed helper packaging, physical iPhone,
Linux companion, broader migration/recovery work and daily-use evidence remain open. Windows
execution remains deferred. The overall plan is not complete.

Evidence: [Mac layout](../evidence/workspace/mac-codex-layout.png),
[web layout](../evidence/workspace/web-codex-layout.png),
[account usage](../evidence/workspace/mac-account-layout.png),
[native browser takeover](../evidence/workspace/native-takeover.png),
[desktop input](../evidence/workspace/desktop-input-final.png),
[Mac stopped controls](../evidence/workspace/mac-control-final.png),
[web stopped controls](../evidence/workspace/web-control-final.png).

## October 15: floating computer-use companions (initial iteration, superseded below)

The computer viewer now lives independently of the task inspector. macOS opens a movable,
resizable nonactivating NSPanel with its own title bar; web opens a draggable overlay with
keyboard positioning. Both keep the conversation layout unchanged. Preview, target name,
computer, ownership, takeover and stop remain visible; target selection, keyboard shortcuts
and diagnostic content are disclosed only when needed. Hiding a viewer preserves its session
and client identity. Expansion on macOS is constrained to the visible display; Escape collapses
the expanded web viewer. iOS retains its shared viewer in a sheet.

Verified against the local pilot: the Mac floating viewer took over the task browser, clicked
its text field, typed and submitted “Floating viewer works”; the disposable page confirmed the
saved value. Closing and reopening the Mac companion retained ownership. The browser session
was stopped after verification. Web repositioning and expand/Escape were checked in the actual
browser, and the Mac expansion bounds fix was checked visually after rebuilding. Web build,
TypeScript, scoped lint, Mac and iOS builds passed; the 8 interactive control tests passed.

Background desktop input remains pending acceptance. `native/ControlHelper/main.swift` now
contains a compiled candidate that uses process-targeted events, removes activation/raise/global
cursor operations, and refuses keyboard input unless the application's focused window matches
the authorized target. This candidate has NOT replaced the pilot's running helper. A renewed
30-minute disposable TextEdit test was requested because the previous authorization expired;
no renewed desktop capture/input was performed. Verify actual delivery, frontmost-app stability,
pointer stability, wrong-window refusal and stop before installing the candidate or claiming
non-disruptive desktop execution. General compatibility across apps is not yet established.

Evidence: [Mac companion](../evidence/workspace/computer-use-mac-floating.png) and
[web companion](../evidence/workspace/computer-use-web-floating.png).

## October 15: contained computer-use surface and background-input test

The user clarified that “floating” means a movable panel **inside deploy.local**.
Removed the separate macOS NSPanel and its window-resizing code. The native viewer is now
an overlay within the conversation, constrained to its content bounds. Expansion stays in
that same content area; the header remains visible while preview/details scroll. Hiding keeps
the viewer mounted and preserves its client identity. The web viewer already uses an in-page overlay.

Verified in the rebuilt Mac app: drag/reposition, clamping before the sidebar, expand/collapse,
hide/reopen, and typing in the conversation composer while the panel remains visible (draft
cleared without submission). macOS and iOS simulator builds pass, as do all 8 interactive tests.
Evidence: [contained Mac panel](../evidence/workspace/computer-use-mac-contained.png).

The renewed authorized TextEdit test ran through the pilot coordinator. Process-targeted typing
and Enter arrived while TextEdit was in the background. Helper measurements showed
`targetWasBackground`, `foregroundUnchanged`, and `pointerUnchanged` all true. These booleans
compare state before/after dispatch; they do not establish compatibility with other apps or
rule out transient changes between samples. Session `385b6bc9-be93-4c75-a1c1-7c29559dbca7`
was stopped through the native UI and persisted as stopped.

Background mouse delivery FAILED: click probes did not relocate the caret, even though event
posting returned successfully. Strings such as “CLICK-VERIFIED” in the disposable document are
probe input, not evidence of successful clicks. The installed pilot helper now explicitly rejects
click/scroll requests instead of silently succeeding or falling back to foreground activation.
Keyboard input still requires the authorized window to match the app's focused window.
Wrong-window refusal has not received live acceptance. Background pointer/scroll delivery,
app compatibility, signed packaging and the broader plan remain unfinished.

## October 15: window-only presentation and background accessibility input

This supersedes the failed mouse-delivery experiment above. The helper now uses public macOS
accessibility actions within the uniquely matched authorized window for clicks and scrolling.
It presses accessible controls, places text carets using the position-to-range API, and changes
accessible scrollbars. Unsupported locations return an error; there is no activation, raise,
or global-pointer fallback. Text/key dispatch retains the focused-window identity guard.

Live disposable TextEdit acceptance through the native client and pilot worker passed:

- Clicking line 10 placed the caret at offset 324; subsequent background typing inserted
  `BACKGROUND CLICK OK ` at that location.
- Scrolling changed the accessible scrollbar from 0 to 0.7142857142857143; capture showed
  lines 39–65 of the 80-line fixture.
- Clicking Bold changed the actual toolbar checkbox to selected.
- After a second empty TextEdit window acquired that app's keyboard focus, typing through
  the original session was refused. The second document remained empty.
- Successful click, typing, and scroll dispatches reported `targetWasBackground`,
  `foregroundUnchanged`, and `pointerUnchanged` all true. These compare before/after samples,
  not continuous focus telemetry. General application/canvas compatibility is unproven.

Session `d93b530f-8e2f-4e59-aae8-18ec69e2b494` was stopped through the native UI.
The installed local pilot helper includes this tested implementation. It emits bounded structured
accessibility evidence from the selected window (180 nodes / 24,000 characters; protected text
values omitted), alongside the image. The text-only compatible adapter receives that evidence
without base64 pixels and is instructed to inspect it before acting.

A real Qwen3-8B-GGUF/Lemonade agent test listed sessions but repeatedly generated malformed
session identifiers/tool arguments and never completed the requested scroll. This is a failed
model-driven acceptance, not a successful desktop action. The run and session
`0ee2c089-2434-435a-aa27-9ee5a1027b63` were stopped before the approved test window ended.
The adapter now terminates after three consecutive tool errors, retaining each result in the
resumable transcript. Regression tests exercise malformed JSON, failed dispatches, and upgrading
the obsolete built-in capability sentence in resumed sessions. No model fallback was used.

macOS and web now display only the captured window in their contained draggable viewer.
Permanent target title, host label, timestamp, and surrounding toolbars are removed from the
normal preview. Hover/focus reveals move/expand/options controls; active native sessions retain
a compact ownership/stop control. Setup and diagnostics are available on demand. iOS retains
its sheet presentation. This removes application chrome, not the captured target's own controls.

Evidence: [window-only Mac view](../evidence/workspace/computer-use-mac-window-only.png),
[window-only web view](../evidence/workspace/computer-use-web-window-only.png),
[actual background scroll](../evidence/workspace/background-scroll-mac.png).

Remaining for computer-use acceptance: reliable real-agent action/observation, wider macOS app
coverage, direct wheel gestures, signed helper distribution, and Linux desktop execution.
Physical iPhone, provider permission/question round trips, resilience/performance, migration,
and daily-use gates remain incomplete; Windows execution remains deferred. This update does
not claim completion of the full workspace plan.

Validation for this update: Mac and iOS simulator builds, web production build, final worker
bundles, TypeScript and scoped lint passed. All 29 focused workspace/control/coordination/adapter
tests passed. A follow-up worker lifecycle regression confirms explicit Stop records an
interruption without the misleading `Agent exited null` error (older pilot history is preserved).

## October 15: Qwen control schema correction

Direct inference probes reproduced the malformed tool arguments with both streaming and ordinary
JSON responses; disabling parallel calls or enabling thinking alone did not fix them. Changing
conditional optional arguments to explicit required arguments produced valid calls on the same
Qwen3-8B-GGUF model and existing Lemonade/llama.cpp backend. This isolates schema shape as a
reproducible trigger; it does not prove the exact underlying backend defect. A related upstream
[parameter-order grammar issue](https://github.com/ggml-org/llama.cpp/pull/20385) informed the probe.
No server upgrade, new model download, or permissive argument repair was used.

The compatible adapter now exposes separate `deploy_control_list`, `deploy_control_read`, and
`deploy_control_input` functions. Required fields are explicit for each operation; the adapter
maps them to the existing coordinator protocol without inventing session IDs, generations, or
permissions. Requests disable parallel tool calls. Session listings omit unopened desktop target
inventory. Invalid session names and missing input fields return actionable errors before queuing.
The three-consecutive-error stop guard remains in place.

Two real Qwen fixture runs successfully listed, read, queued one scroll, read its completion, and
reported the observed result. The final fixture uses the coordinator's actual `succeeded` status.
Evidence: [Qwen schema/tool-loop probe](../evidence/workspace/qwen-control-schema.json). These are
real model calls against a synthetic control endpoint, **not live window acceptance**.

Live window acceptance is prepared in the native pilot task “Background window acceptance…”;
renewed 30-minute desktop capture/input confirmation is pending. Earlier grants expired and no
new desktop session was opened. The disposable coordinator was restarted with the corrected tools,
existing Qwen endpoint/local billing, and existing Whisper-Base transcription configuration.

Also fixed the native new-task screen displaying the preceding task's computer viewer: the
mounted panel becomes hidden and noninteractive while composing a new task. This was visually
verified after rebuilding and signing in. Mac and iOS simulator builds pass; 35 focused tests,
TypeScript and scoped lint pass. The broader plan and live agent-control gate remain unfinished.

## October 15: agent-selected windows and minimal contained viewers

The agent discovers targets and requests one exact window through tools. Native and web clients
no longer expose target/session dropdowns, URL fields, typing forms, keyboard menus, or diagnostic
panels in the viewer. A pending request automatically reveals a compact Allow / Not now card
naming the window and computer. Approval binds the request's task, target, and worker instance;
requests expire after 30 minutes. The tool cannot approve its own request. Existing operator APIs
remain for compatibility, but the application flow uses agent requests.

Compatible models use explicit required-argument tools for targets, request, list, read, input,
and stop. Codex/Claude use the corresponding canonical deploy_control actions. Stopping through
the tool is limited to an agent-owned session and fenced by generation. Duplicate operations are
idempotent. Desktop input before the first inspection now returns a recoverable error without
queuing input, rather than letting the helper reject it and suspend the session.

The captured window itself is draggable while the agent owns control. The native viewer remains
inside the conversation, with compact hover/focus controls and an ownership/stop pill. Web uses
the same compact presentation and supports keyboard repositioning. Takeover retains preview
click input; manual typing/scroll forms were removed in favor of agent tools. The web viewer's
initial position is above the composer. Closing the viewer hides it without revoking access;
Stop ends access. Ended native previews show Session ended. iOS shares the simplified viewer in
its existing sheet; physical-device visual acceptance remains pending.

Live Qwen3-8B-GGUF on the existing ser.local Lemonade endpoint completed real tool calls:

- Discovered and requested TextEdit — Scroll Test Log; the app showed that exact approval.
- Inspected session `91f8a94f-ca57-4063-9d68-98e1e6028284` after user approval.
- Scrolled upward 250 pixels: vertical scrollbar 0.7142857142857143 → 0.3571428571428572.
- Clicked the observed Bold checkbox: value 1 → 0. Qwen used a point inside the observed bounds,
  rather than the requested center; the accessibility action still pressed the intended control.
- Both input commands succeeded and returned targetWasBackground, foregroundUnchanged, and
  pointerUnchanged = true. These are before/after comparisons, not continuous telemetry.
- Stopped its session through deploy_control_stop at 17:51:10 UTC, within the approved test period.

This is **assisted live model-control acceptance**, not reliable unattended multi-step completion.
Qwen initially skipped inspection, then required a follow-up to actually execute its proposed
click. Approval was followed by a continuation message; automatic resume after a pending approval
and general provider permission/question round trips are still work. No fallback model was used.
No shell or user-input API performed the successful scroll/click on Qwen's behalf.

Actual native preview dragging passed after fixing local-coordinate drift with global gesture
coordinates. Two final drags moved the preview by exactly (-630, +80) and (+400, -60) screenshot
pixels, without adding a control command or moving the target window. Web keyboard movement changed x from 458 to 434 at constant
size; browser pointer dragging is implemented but was not exercised by the DOM-only test surface.
The session survived quitting/reopening the native client. Native/web views showed the same target.

Evidence: [live tool/command observations](../evidence/workspace/qwen-live-window.json),
[Mac viewer](../evidence/workspace/agent-window-mac.png),
[web viewer](../evidence/workspace/agent-window-web.png),
[agent-selected approval](../evidence/workspace/agent-window-approval-mac.png).

Validation: 39 focused adapter, streaming, control, coordination, and workspace tests passed;
TypeScript, scoped lint, production web/server build, macOS build, and iOS simulator build passed.
The full workspace plan remains open: unattended reliability, automatic approval continuation,
wider application coverage, physical iPhone/signed distribution, resilience/performance, migration,
and daily-use gates still need acceptance. Windows execution stays deferred.

## October 15: automatic approval continuation

Control access requests now stay inside the original tool call while the user decides. Read-only
polling returns the exact approved session after worker readiness; denial/expiry returns without
access. The agent does not need a fabricated user message or a second run. Stopped/completed runs
cannot receive a new grant, and their pending cards disappear. Worker restart still marks ambiguous
runs unknown; this change does not silently restart an interrupted agent.

Input calls also wait up to 30 seconds for command completion and return fresh evidence. Timeout
returns an explicitly unconfirmed command; no mutation is replayed. Cancellation, takeover, missing
sessions, unknown outcomes and authorization failures remain fail-closed. Compatible system/tool
instructions require continuing the original request after approval and distinguish actual tool
completion from promises.

The Codex deploy MCP timeout now accommodates the bounded 30-minute approval wait, using the
[documented per-server setting](https://learn.chatgpt.com/docs/config-file/config-reference).
Claude's deploy server gets the matching timeout and automatic MCP backgrounding is disabled for
this dedicated adapter process, per its [environment/configuration reference](https://code.claude.com/docs/en/env-vars).
These launch settings are implemented. Delayed-approval Codex acceptance subsequently passed
as recorded below; Claude subsequently passed the equivalent flow. The initial real-model trials below use Qwen.

A fresh Qwen3-8B-GGUF task on ser.local received exactly one user message and one window approval.
It discovered/requested TextEdit — Scroll Test Log, inspected it, scrolled up 100 pixels, clicked
Bold and stopped its own session, with zero follow-up prompts. Task
`539dee52-7e4d-4c19-8fc8-f4b791cdd6f1`, session `a40fd992-edbf-45ff-b43f-c87b7089d5a2`:

- Vertical scrollbar: 0.3571428571428572 → 0.2142857142857143.
- Bold checkbox: 0 → 1. Inspect, scroll, and click each returned succeeded.
- Scroll/click evidence reports targetWasBackground, foregroundUnchanged, pointerUnchanged true
  (before/after sampling only).
- Agent stop recorded at 19:13:56 UTC, run finished at 19:14:12 UTC. No active access remained.
- The final model prose incorrectly used the horizontal scrollbar for its initial scroll value,
  and omitted requested isolation details. The action acceptance passed; the summary was not fully
  accurate. Helper evidence now labels AX orientation and the axis of scroll effects explicitly.

Evidence: [complete tool/command trace](../evidence/workspace/qwen-automatic-continuation.json),
[native completed view](../evidence/workspace/automatic-continuation-mac.png).
The run took about 230 seconds including approval, so this establishes continuation/correct input,
not a fast interaction target or general Qwen reliability.

## October 15: long-history activity correction

Task snapshots previously returned the first 1,000 events while advertising the latest cursor;
newer activity disappeared from long task views. Snapshots now return the most recent 1,000 events
in order. Older events remain available through the existing paged replay endpoint. Added owner/cursor
and owner/task/cursor indexes. A regression exercises 2,500 task events interleaved with other tasks
and another owner, complete replay without duplicates, and updates after the snapshot watermark.

An isolated 100,000-event store benchmark (10,000 for the selected task) measured recent snapshot
plus replay queries at 0.63 ms p95 across 100 samples on this arm64 Mac. This is database-only evidence,
not API/network/rendering performance: [measurements](../evidence/workspace/history-store-benchmark.json).

Validation: 52 focused workspace/control/adapter/history checks pass. Updated helper compiles.
The full plan still requires provider-specific live acceptance, physical iPhone/signing/distribution,
broader desktop coverage, end-to-end resilience/performance, migration cutover and daily-use evidence.
Windows execution remains deferred.

A second fresh task (`bf3ea755-efc6-4b1c-b022-0d98bf1a8182`) performed the inputs but falsely
claimed cleanup without a stop call, despite clearer axis evidence. The operator stopped access
through the web UI; this run is **not** unattended cleanup acceptance. Evidence is preserved in
[qwen-cleanup-failure.json](../evidence/workspace/qwen-cleanup-failure.json).

The compatible harness now checks newly opened agent-owned sessions before accepting a final turn.
If one is still active, it supplies exact IDs/generations as system feedback and asks the model to
stop it through tools. At most two reminders are allowed; ignoring them fails the run rather than
reporting completion. No fake user message, direct input, or fabricated stop result is used. Sessions
taken over by the user are excluded. Tests exercise both automatic correction and bounded failure.
This is cleanup enforcement, not a general validator of arbitrary model prose or task completeness.

The subsequent live cleanup-guard run (`27378499-bfb8-4cf3-a1b2-80747652d17e`) completed its
initial inspect/scroll/click but then repeated a scroll instead of producing a final response.
The operator stopped its session and run. The guard handles premature final responses, not arbitrary
repeated successful actions; this run is not unattended acceptance. Evidence:
[qwen-repeated-action-failure.json](../evidence/workspace/qwen-repeated-action-failure.json).
The successful first run proves one-prompt continuation is possible; repeated trials do not establish
reliable unattended operation for Qwen3-8B. The user explicitly authorized the subsequent Codex-subscription comparison; it passed as recorded
below. No silent provider fallback occurred.

## October 15: physical iPhone build and installation

Xcode discovered the connected physical iPhone 16 Pro Max. A device build initially failed because
no development team/profile was configured. Using the existing Apple Development identity's team
as a build-only override and Xcode provisioning updates produced a successful signed Debug-iphoneos
build. `devicectl` confirmed installation of `local.deploy.workspace.ios` on that phone. The project
file was not bound to a personal team. This establishes device build/install, not device UI, LAN,
background/reconnect or acceptance flows. The disposable pilot remains bound to loopback and is not
exposed with its fixed QA credentials. A suitable authenticated LAN setup is still needed.

## October 15: Codex subscription automatic continuation accepted

Task `aec388ac-76a0-467a-92b1-77ba804af320` used the Codex subscription/default model.
One user prompt and one UI approval, no follow-up messages or operator input/cleanup:

- Access request waited from 19:28:52 UTC through approval at 19:30:57, then returned after readiness.
- Inspect succeeded. Exactly one upward 50-pixel scroll: vertical 0.3571428571428571 → 0.2857142857142857.
- Exactly one click at observed Bold center (203.5, 134): checkbox 0 → 1.
- Both input results reported targetWasBackground, foregroundUnchanged, pointerUnchanged true
  (before/after sampling, not continuous monitoring).
- Agent stopped session `bf79e247-9724-4e34-bdea-1e65968f1b37` at 19:31:24; run succeeded
  at 19:31:30, about 33 seconds after approval. Final prose matched actual command evidence.

Evidence: [tool trace](../evidence/workspace/codex-automatic-continuation.json),
[completed web view](../evidence/workspace/codex-automatic-continuation-web.png).
The focused regression coverage is 55 tests, including the approved-but-not-ready timeout boundary;
TypeScript and production build passed. This is bounded TextEdit acceptance, not arbitrary-app coverage.

## October 15: bundled signed macOS control helper

The generated Mac project now builds the control helper as a dependent command-line target and
embeds it at `Deploy.app/Contents/Helpers/deploy-control-helper`. It uses the chosen Xcode signing
identity and builds only for macOS. The independent worker still requires an explicit helper path;
installing/opening the UI does not enable control. Existing OS permission checks and per-window
grants remain required. The current pilot keeps its existing helper until an intentional switch.

A development-signed macOS build succeeded using the existing team as a command-line override.
Both app and embedded helper carry that team, and `codesign --verify --deep --strict` passed.
No personal team was added to the project. This closes bundling/development-signature verification;
notarization, distribution signing and privacy-grant retention across updates remain unverified.

## October 15: subscription default isolation

Live Claude acceptance exposed that both worker launchers inherited `DEPLOY_MODEL_NAME` from
compatible-endpoint configuration when a subscription task selected Default. Claude consequently
received Qwen3-8B instead of its own default and rejected the request before any window access.
Both launchers now share adapter-aware model/effort environment selection. Only the compatible
adapter inherits the worker endpoint model; subscription defaults stay unset, while explicit task
models/efforts are preserved. A spawned Claude fixture proves no `--model`/`--effort` leaks through;
55 focused regressions, TypeScript, scoped lint and production build pass. The fresh Claude run now
reaches the exact-target approval; no follow-up prompt was added to it.

Shared Apple model rows now include their provider in accessibility labels, matching the web picker.
This removes ambiguity between the three visually grouped Default choices without changing layout.

## October 15: Claude subscription automatic continuation accepted

After the user signed in to Claude Max and explicitly approved the provider change, task
`1ecc9d2f-af7e-4bd2-bcbd-8fec0c34eb26` completed with one user message and one window approval.
The original request stayed pending during the approval wait; no continuation message was sent.

- Approval opened session `d83f306f-03d3-477c-92e6-f248ef002e5a` at 19:40:21 UTC.
- Inspect, exactly one upward 50-pixel scroll, and exactly one Bold click all succeeded.
- Vertical scrollbar: 0.2857142857142857 → 0.2142857142857143; Bold: 1 → 0.
- Both input results recorded background target, unchanged foreground, and unchanged pointer.
  This is before/after evidence; the model's word “never” in its final prose exceeds that sampling.
- Agent stopped its own session at 19:40:46; run succeeded at 19:40:56, about 35 seconds after
  approval. No operator cleanup or lingering active session remained.
- Mac and web show the same completed conversation and ended session.

Evidence: [tool trace](../evidence/workspace/claude-automatic-continuation.json),
[Mac view](../evidence/workspace/claude-automatic-continuation-mac.png),
[web view](../evidence/workspace/claude-automatic-continuation-web.png).
This satisfies the bounded subscription-provider window test for both providers. Broader app
coverage, provider questions/steering, resilience, physical-device LAN flows, distribution,
migration and daily-use gates remain open. Windows stays deferred.

## October 15: incremental Claude replies

The Claude adapter now enables partial output and converts text deltas into stable conversation
items. Complete blocks replace their partial versions; tool/thinking deltas and nested-agent
messages do not become duplicate main replies. Updates coalesce within 50 milliseconds, and
interruption flushes buffered text without marking it completed. Complete-only output remains
supported. The event mapping follows the installed CLI flag and
[official streaming protocol](https://code.claude.com/docs/en/agent-sdk/streaming-output).

A real Claude subscription task (`a05d1146-db41-46c6-8a02-936ffdce1ac7`) emitted 203 partial
updates from 19:43:12 through 19:43:24 UTC, starting about four seconds after task creation.
Exactly one assistant message remained in storage after the final block. The browser displayed
the complete response. This measures coordinator event delivery; it does not establish per-frame
render latency. Evidence: [event trace](../evidence/workspace/claude-streaming.json),
[browser view](../evidence/workspace/claude-streaming-web.png).

Four regression cases cover partial/final identity, tool/thinking exclusion, multi-block responses,
interruption, fallback and duplicate delivery. TypeScript, scoped lint and production build pass.

## October 15: durable client retries and service startup

Native sends now persist the exact operation ID and payload before dispatch in a restricted-permission
journal, scoped by coordinator, account and task. Browser commands use origin-local persistent storage
and account scoping; message retries ignore a refreshed revision when identifying the pending send,
then resend the original revision and payload. Authentication/transport/rate-limit failures retain the
operation. Definitive validation/revision rejection releases it. Successful acknowledgment permits a
later intentional identical message. Neither journal stores authentication tokens or silently replaces
corrupt pending records. Tests inject a response loss after acceptance, revision/token changes,
account/task/provider changes, unavailable storage and definitive/transient response errors.

A live isolated-device startup exposed a repository service WAL read-to-write upgrade race. Repository,
pipeline and local worker registration now reserve an immediate write transaction before checking the
previous owner. Four simultaneous processes produce exactly one owner; the test also verifies takeover
after that owner exits. The old local-worker check/insert gap is closed by the same claim operation.

Focused Node regression run: 46 tests pass. Shared Apple package: nine tests pass. TypeScript, scoped
lint, production build, macOS/iOS simulator builds and updated physical iPhone build pass. The updated
signed physical app was installed on the user's iPhone 16 Pro Max. Tests establish the stated boundaries,
not the full physical-device acceptance matrix or a week of daily use.

## October 15: reconnect and physical device preparation

The independent Codex worker retained its process and provider session while the disposable coordinator
was stopped/restarted. The browser preserves the received conversation, displays an interruption notice,
and clears it automatically after reconnection without a page reload. The development API proxy returns
a JSON 503 rather than raising a Vite overlay. Native reopening recovered the selected conversation and
unsent draft. Authentication across the existing development Keychain/signing history still requires
reauthentication; seamless signed-update credential retention is not accepted yet.

The user installed/trusted the existing home CA on their iPhone and reported HTTPS without a warning.
The public CA fingerprint was matched to the SER copy over SSH. A separate disposable coordinator and
worker use a new random-password test account. A temporary HTTPS relay at `https://deploy.local:18459`
uses the existing certificate/key in place on SER and an SSH loopback tunnel to the Mac coordinator.
The user opened that port only to `10.0.0.0/24`; external unauthenticated state requests return 401.
Production deployment routes and data are unchanged. The physical app sign-in and cross-surface test
remain pending user interaction. Remove the temporary UFW rule and stop the relay/tunnel after acceptance.

Evidence: [device/resilience trace](../evidence/workspace/device-resilience.json),
[native draft recovery](../evidence/workspace/reconnected-mac-draft.png),
[browser outage](../evidence/workspace/coordinator-offline-web.png),
[browser recovery](../evidence/workspace/coordinator-reconnected-web.png).

The real Codex durability run `39537da6-7aab-494b-9b0f-ea5ad657c152` completed successfully.
Its Python process recorded 1,260.0193332 seconds between the single start and finish records.
One user message, one run, the same PID/provider session across coordinator restarts, no redispatch.
Native displayed the final result with its unsent draft still present. This closes this bounded
long-run/coordinator/client-reconnect check; it does not establish sleep/wake or worker-loss recovery.

Current physical-device finding: the user reported that app connection failed. The isolated endpoint
is reachable from the Mac over validated HTTPS, rejects anonymous access with 401, and accepts the
test login through Apple URLSession with HTTP 200. Awaiting the iPhone Safari result to distinguish
phone LAN/TLS reachability from app authentication. A browser-created Codex handoff task is ready in
the isolated account; no phone continuation or background/network-loss success is claimed yet.

A separate process-level worker-loss regression kills the worker while its synthetic agent remains
alive. The replacement marks the run unknown and task blocked, retains the provider session and
partial file, rejects another writer, and does not dispatch a second agent. Together with the prior
46-test run this brings focused Node coverage for this pass to 47 passing tests. This uses a synthetic
agent to isolate process safety; the 21-minute coordinator-restart run uses the real Codex subscription.

The iOS coordinator and username fields now disable automatic capitalization and autocorrection;
the coordinator uses the URL keyboard and credentials have their platform content types. This fixes
a plausible input problem but is not evidence of the cause of the user's reported connection failure.

The corrected iOS credential fields passed a physical-device rebuild and the nine shared Swift tests.
The updated app was installed again for direct testing. User requested that the agent handle sign-in;
iPhone Mirroring opened to first-time onboarding and requires the phone owner's on-device unlock/approval.
No mirrored phone access or successful phone login has been claimed before that setup completes.

## October 15: physical iPhone subscription handoff accepted

After the user installed the updated home CA, the physical iPhone connected to the isolated HTTPS
coordinator. A browser-created Codex task continued from the phone in the same provider session,
appending one line exactly once. Claude then read that workspace from the phone and resumed the
same Claude session from the browser. Four runs succeeded; the file remained exactly two lines.
The phone preserved its unsent draft across background/foreground, coordinator outage/recovery,
and a signed app replacement/relaunch. Authentication also survived that signed iPhone update.
This does not establish macOS credential retention, actual Wi-Fi loss, or session expiry.

Evidence: [run/session record](../evidence/workspace/physical-iphone-acceptance.json),
[physical iPhone](../evidence/workspace/physical-iphone-handoff.png),
[outage](../evidence/workspace/physical-iphone-coordinator-offline.png),
[recovery](../evidence/workspace/physical-iphone-reconnected.png),
[signed update](../evidence/workspace/physical-iphone-signed-update.png).
The isolated relay and LAN-only firewall rule remain available for follow-up device checks.

## October 15: waiting event feed and compact task activity

Web and Apple clients now wait for durable events instead of repeatedly fetching unchanged state
at one-second intervals. The server watches the shared worker database at 50ms intervals, bounds
waits to 10 seconds, and cancels disconnected readers. Old coordinators retain a paced polling
fallback. Idle responses refresh worker/provider freshness. Browser conversation rendering no
longer waits for the Git diff. Integration tests cover independent-process writes, owner/task
isolation, cursor replay, cancellation, invalid cursors, and worker-credential rejection. This is
not yet a measured end-to-end 250ms p95 render claim.

Conversation activity now folds tool start/update/result records into one action per provider item.
Pre-tool commentary is collapsed into per-run summaries; multipart replies after tool completion
remain visible. Commands retain output, exit status, failures and unresolved state. File/URL sources
and cross-computer processes are separate collapsed sections. High-volume message deltas no longer
crowd tools out of the activity query; raw events remain available in the web technical log.
This shared projection drives web, macOS and iOS; it reports recorded evidence rather than inferring
that a background process is still alive.

A real Claude command slept for 15 seconds, printed `Activity check passed`, and exited with status 0. Web and the physical iPhone showed its collapsed activity while running; command details and
output were expandable. The completed result and compact summaries were visually checked on web,
macOS and iPhone. Sources show recorded file references; the process section shows persisted
cross-computer jobs, not an inferred inventory of every shell process.

Evidence: [web](../evidence/workspace/compact-activity-web.png),
[macOS](../evidence/workspace/compact-activity-mac.png),
[physical iPhone](../evidence/workspace/compact-activity-iphone.png),
[working web](../evidence/workspace/compact-activity-working-web.png),
[working iPhone](../evidence/workspace/compact-activity-working-iphone.png).
The Mac visual check used the isolated coordinator's loopback address: its LAN HTTPS connection
failed in the app even though the physical iPhone and command-line HTTPS checks succeeded.
Mac credential retention after relaunch also remains unresolved. Neither is covered by the
successful physical iPhone results. Activity regression tests, waiting-event tests, shared Swift
tests, TypeScript checking, scoped lint, signed Apple builds and the production build passed.

## October 15: Mac login, LAN access and device session recovery

The signed Mac app now uses its private data-protection Keychain group. The prototype's legacy
Keychain entry is left untouched. After one sign-in, login, task selection and draft survived
quit/relaunch and replacement by a newly built app with the same development identity. The app is
installed at `~/Applications/Deploy.app`. LAN attempts had reported `Local network prohibited`
despite the enabled permission. Refreshing the existing permission and relaunching the stable
signed installation restored validated HTTPS to `https://deploy.local:18459`; the separate effects
of the permission refresh and installation path were not isolated. No TLS bypass was added.

The user disabled physical iPhone Wi-Fi, opened the app, restored Wi-Fi, and reported “Reconnected
with draft intact.” Subsequent Mirroring inspection showed the connected workspace and the exact
unsent draft. This is an idle/draft network-loss test, not an in-flight provider-turn Wi-Fi test.

Expiring only the isolated account's sessions produced a clear Sign in again banner in Mac,
iPhone and web. Each retained its conversation and draft and returned to the same task after
renewal. The browser's second expiry check retained the loaded transcript without a page reload.
The preview server now reserves its HTTP Basic challenge for Basic requests so JSON session expiry
does not get trapped behind a browser authentication dialog. Expired clients stop event polling;
native control input also requires a connected session. The original retry operation identity
survives token renewal. Server inspection still showed five successful runs, 13 messages, two jobs,
and the unchanged two-line `handoff.txt` after all reconnects and sign-ins.

Mac sleep notifications now save the draft and suspend polling; wake restarts it. Lifecycle
versions prevent a pre-suspension refresh from restarting polling after a newer transition.
Actual sleep/wake and reboot are still open. No forced host sleep was performed.

Ten shared Swift tests, eleven focused Node tests, TypeScript checking, scoped lint, signed macOS
and physical-iOS builds, and the browser production build pass. These are bounded pilot results.
A 50-sample warm loopback benchmark (five warmups) measured state p95 23.45ms, detail p95 3.48ms,
diff p95 56.35ms, and serial refresh p95 101.94ms. It excludes render, LAN and provider time and
therefore does not close the 250ms event-to-render target.

Evidence: [recovery record](../evidence/workspace/session-network-recovery.json),
[Mac retained login and draft](../evidence/workspace/mac-session-renewed.png),
[iPhone Wi-Fi recovery](../evidence/workspace/physical-iphone-wifi-recovered.png),
[iPhone session renewal](../evidence/workspace/physical-iphone-session-renewed.png),
[web expired session](../evidence/workspace/web-session-expired.png),
[web renewal](../evidence/workspace/web-session-renewed.png),
[warm API measurements](../evidence/workspace/warm-refresh-performance.json).
The isolated HTTPS relay, tunnel and LAN-only firewall rule remain available for pilot use.

## Shared question continuation (October 15, evening)

Added `deploy_ask_user` to the shared coordination tools. The original tool call waits for a durable,
owner-scoped answer. Web and shared macOS/iOS views provide choices, free text, Skip and Continue,
retain the unsent answer across reopening, and preserve the ordinary message draft. Answer history
is collapsed. Questions do not grant access or change the provider permission policy.

- Real Claude subscription run asked once; web answer draft “Purple” survived reload; Continue
  completed that same run with “Selected: Purple”, without a follow-up prompt.
- Real Codex subscription run asked once; the actual shared `WorkspaceClient`/`WorkspaceStore`
  signed in over `https://deploy.local:18459` and answered “Blue”; the browser observed the same run
  complete with “Selected: Blue”, without a follow-up prompt.
- Eight focused question tests and 19 coordination/control tests pass: request/answer deduplication,
  owner/task/run boundaries, worker denial, conflicting answers, skip/stop/expiry, lost-ack replay,
  temporary transport/503 retry, a bounded disconnected wait, and non-JSON authorization failures.
- Browser screenshots: `claude-question-pending-web.png`, `claude-question-completed-web.png`,
  `codex-question-completed-web.png` under `docs/evidence/workspace`.
- Shared native transport is verified independently of GUI interaction. The Mac was locked during
  this slice: native question layout and physical iPhone answering remain unverified, and the new
  builds have not replaced the installed pilot apps.

The current CLI execution adapters still report steering and provider-native permissions as
unsupported. Installed Codex app-server protocol inspection confirms that true active-turn steering
requires a persistent app-server session and the expected turn ID. It is not implemented by queuing a
second CLI invocation. Provider-native approval transport remains separate from deploy control grants.

## Long-history web check (October 15, evening)

A disposable task with 500 synthetic turns (1,000 messages including highlighted code blocks)
rendered its complete history. While viewing older messages, typing retained the exact scroll
position (185462 px) and the draft. These were seeded UI fixtures, not provider executions.

The web transcript now builds one memoized index per message/activity snapshot instead of running
nested full-history searches and filters for every rendered reply and composer keystroke. A focused
test preserves multipart replies, progress grouping, pending-turn activity and ordering. Markdown
rendering remains memoized. Evidence: `docs/evidence/workspace/long-history-web.png`.

This establishes functional long-history rendering/typing/scrolling on the local browser. It is
not an event-to-render p95 measurement, native long-history acceptance, or live-capture load test.

Final validation for the shared-question and transcript-index slice: 28 focused Node tests (including
one transcript-index test), 10 Swift tests, TypeScript, scoped lint, production web build, and signed
macOS/physical-iOS development builds pass. Structured live-run evidence is in
`docs/evidence/workspace/shared-questions.json`. Native visual acceptance and installation of these
new question-capable builds remain pending; existing installed pilot apps were left intact.

## Conversation visual refinement (October 15, evening)

Unified the web transcript/composer column, increased conversation text to 16px and navigation to
14px, tightened message/activity spacing, removed repetitive visible provider labels (retained in
accessibility labels), and reduced header controls to quiet toolbar buttons. Unassigned conversations
omit the redundant “No project” header. Computer identity remains immediately before status, with
its full name available on hover. Search retains subtle elevation; the composer has a smaller radius.

The shared Apple layer uses matching 14px navigation / 16px macOS body typography and the same
760px outer column for transcript and composer, with matching inner text insets. Apple builds pass;
these native changes have not been installed or visually accepted because the Mac is locked.

Browser acceptance used a real Codex discussion in the isolated “Interface review” project. Project
creation, sending, rendered response, model-menu opening, Escape dismissal and focus return passed.
Screenshot: `docs/evidence/workspace/conversation-polish-web.png`. TypeScript, scoped lint, web
production build, macOS and physical-iOS development builds pass. No production data was changed.

## Native visual and question acceptance (October 15, 20:25 EDT)

Installed the polished, consistently signed builds on the Mac and physical iPhone. Mac relaunch
retained its private-Keychain login and unsent draft. Captured the real Mac conversation and the
iOS 27 simulator conversation; physical Mirroring timed out, so this is not a new physical-iPhone
visual acceptance claim. Simulator sign-in used the isolated device pilot over loopback.

- Codex asked once; the Mac question card accepted “Mac” with Command-Return; the original run
  completed “Native answer received: Mac” without another prompt.
- Claude asked once; the iOS simulator card accepted “iPhone” with Continue; the original run
  completed “Native answer received: iPhone” without another prompt.
- The 1,000-message native history opened and scrolled on macOS and opened on iOS simulator. Mac
  typing stayed in the older-message region and its draft survived another signed app replacement.
- Visual testing exposed a blank iOS transcript after switching from a long task to a short one.
  Task-scoped transcript identity now resets the lazy scroll view. Repeating long-to-short navigation
  showed the complete short conversation. Closed Mac computer previews are also now excluded from
  the accessibility tree.
- macOS, physical iOS, and simulator builds pass; all 10 Swift tests pass. Final Mac signature
  verification passes. Final builds installed on Mac, physical iPhone and the designated simulator.

Evidence: `native-polish-acceptance.json`, `conversation-polish-macos.png`,
`conversation-polish-ios-simulator.png`, `question-native-macos.png`, `question-ios-simulator.png`,
and `long-history-macos.png` in `docs/evidence/workspace`.
The Mac sleep/wake test is intentionally deferred while the user's eight-hour keep-awake request
is active. Full performance latency, live-capture load and the other listed gates remain open.
