# deploy.local project workspace plan

Current client ownership: Electron in `desktop/` is the Mac, Windows and Linux app. The Swift Mac target has been retired under cleanup step 9; `native/Apple` remains the iPhone app. References to Swift Mac builds below record the earlier implementation.

Status: Implementation pilot underway; full milestone acceptance remains incomplete. See
[implementation evidence and remaining work](workspace-implementation.md).

Date: 2026-10-14

deploy.local will provide one application for working on projects across the computers at home.
It will connect project context, interchangeable coding agents, working copies, build outputs,
and optional deployments. The purpose is to reduce time spent switching tools and reconstructing
context, while making it practical to try models outside the existing Claude, Cursor, and Codex
subscriptions.

## Agreed product decisions

- Use a single deploy.local application and home control plane.
- Include desktop, iOS, and browser clients for the same agent harness and persistent sessions.
  All three support the core coding workflow through shared project, execution, and fleet APIs.
- Start with two native Swift apps, macOS and iOS, using a shared Swift layer. Keep the browser
  as a full harness client. Fedora/Ubuntu desktop clients are deferred to a later phase; this
  does not defer ordinary Linux worker support. Windows desktop support remains outside scope.
- The desktop UI includes browser and computer use connected to the agent harness, with visible
  execution targets and user controls for observing, stopping, and taking over interaction.
- Retire Groffee as a separate product and put repository hosting, issues, and pull requests directly in deploy.local.
- Extend `deploy.yaml` for CI/CD on enrolled Linux and macOS workers (Windows execution deferred by the user on 2026-10-15). Execution
  requirements and deployment destinations are separate; no additional pipeline config file.
- Retire portable sites, called Suitcases in the existing code and documentation. Use one home
  coordinator and connected computers; do not retain an offline site/replica product.
- Organize work around projects. Games, native apps, libraries, and CLIs are first-class projects.
- A project requires neither Docker nor a deploy.local deployment or manifest.
- Connect the home computers, which share a network, so different projects and tasks can run on
  appropriate machines while remaining visible together.
- Connect coding tasks to running applications when that context exists: deployed source,
  configuration structure, logs, health, previews, and release outcomes.
- Prioritize Codex and Claude subscription workflows for release acceptance (confirmed 2026-10-15).
  Retain the compatible endpoint for larger models without making Qwen3-8B reliability a release gate.
  Never silently change providers or incur API billing.
- Support interchangeable agents and models. Unifying the UI alone does not resolve model lock-in.
- Contain scope. Each milestone must improve an actual development workflow before adding more
  platform features.
- Make chat and interaction quality first-class: fast input, streaming, navigation, and review.
  Codex is the user's preferred experience reference, specifically its native feel, keyboard
  controls, and responsiveness. This does not assume or prescribe Codex's internal technology stack.

The architecture, milestone order, and performance targets below are proposals. Device coverage,
the first pilot projects, and the first additional model remain to be selected.

## Repository hosting inside deploy.local

deploy.local owns repository hosting and the project workspace directly. Groffee will be retired
as a separate product after the required capabilities and existing data have moved successfully.
There is no separate Groffee service, login, project board, or integration layer in the target
architecture. This plan does not itself delete Groffee or move its live data.

The primary flow is create or import a repository in deploy.local, then work on its project.
Repository hosting is a built-in capability; deployment remains optional. Projects can also connect
an existing local checkout or external Git remote without requiring a hosting transfer. Deliver the
local repository path first and add external-source convenience without delaying the first pilot.
Each repository has an explicit source of truth and fetch/push policy. A worker's task worktree
is a working copy, separate from the hosted bare repository. Never work directly in hosted storage.

Groffee already implements Git HTTP/SSH/LFS hosting, source browsing, issues/PRs, task boards,
shared briefs, atomic claims, questions, and commit-pinned review evidence. Its project APIs do not
start workers or run models. Port useful implementations into deploy.local instead of retaining
Groffee as an architectural dependency or rebuilding working capabilities unnecessarily.
Sources: `../groffee/README.md`,
`../groffee/docs/project-workspace.md`, `../groffee/docs/project-workspace-plan.md`,
`../groffee/packages/web/app/api/routes/projects.ts`, and `../groffee/packages/git/src/index.ts`
(paths relative to the deploy.local repository root).

Groffee currently defines a project as a hosted repository and a task as an existing issue. In
deploy.local, an issue tracks requested work and a task holds an agent conversation/execution. Link
them explicitly within the same project; an issue can have multiple task attempts and a task can
exist without an issue. Preserve this distinction when mapping the existing Groffee records. Keep source-location details separate so external repositories can also
participate. Do not create two writable task boards or mirror task state between two databases.
Existing revision checks and review evidence are valuable contracts; extra approval stages should
be evaluated against the desired personal workflow rather than inherited automatically.

Port cohesive Git and workspace modules behind deploy.local's UI and identity model. Map module
dependencies, authentication, storage, and runtime compatibility before porting. Native Git and
ordinary bare repositories remain the storage/protocol foundation; worker execution is added
separately. Keep the first slice focused on create/import, clone/fetch/push, source/diff browsing,
and task context. Include LFS in the first game pilot if its assets require it. Existing issue/PR
and pipeline data must be retained during migration, but duplicating every forge feature is not
a prerequisite for proving the new coding workflow.

Before retiring the existing Groffee installation, inventory repositories, LFS objects, issues, PRs, review
evidence, users, credentials, pipelines, and clone URLs. Preserve durable IDs and links or provide
explicit redirects/mappings, verified backups, and a rehearsed rollback before cutover. Do not
replace Git remotes or move live data during the integration spike. Keep existing Groffee pipelines
working; do not build another CI product as a prerequisite for coding tasks.

## Repository collaboration and mesh CI/CD — accepted 2026-10-15

Issues and pull requests are first-class project records. Reuse Groffee's useful contracts (shared
project numbering, comments, state transitions, revision checks, source/target comparison) within
deploy.local's owner-scoped storage and APIs. Do not bring over a second identity or task board.
Issues support create/edit, close/reopen, comments, and links to existing coding tasks. Pull requests
support source/target branches, description, comments, linked tasks/issues, commit-specific diffs,
and explicit merge. A pull request does not automatically start an agent or deploy anything.
The first backend merge slice supports fast-forward only, detects changed branches, and records a
durable merge receipt atomically with the Git ref update. Diverged branches require an explicit
rebase/update before merge; broader merge strategies and reviews/check gates follow.

CI/CD stays in `deploy.yaml`. Its `pipeline` section defines mesh jobs; existing top-level `jobs`
remain container lifecycle jobs. Both are validated by the existing application compiler. No project
recipes or additional workflow file are introduced. A job declares Linux/macOS, optional
architecture/toolchain capabilities, host or container execution, dependencies, and command. These
are implemented schema additions. Existing container lifecycle jobs retain their meaning.
Job-only workflows must not require a dummy application or container component.
Native Mac builds run on eligible hosts; a Linux container cannot substitute for Xcode.
Windows execution is deferred at the user's request (2026-10-15); it is not a current acceptance gate.
Workers must be enrolled and reachable, advertise supported capabilities, and have capacity.
No matching worker means queued with an explicit reason, never fallback to an incompatible OS.

Execution placement is separate from deployment destination. A build/check may run on one computer
and deploy via an existing authorized container-platform integration elsewhere. Mesh membership
alone does not confer external platform credentials or add an unsupported platform adapter.
Reuse existing deployment health checks, revision tracking, logs, and rollback. Repositories used
only for coding/native builds still need no deploy configuration. Any needed file transfer uses
existing job/deployment storage; no separate artifact-management product is required.

Implementation sequence:

1. Backend slice implemented and tested on 2026-10-15: owner-scoped issues and pull requests,
   linked tasks, live source comparison, and durable guarded merging; verify real Git behavior, retries, restart recovery, and access isolation.
2. Implemented: YAML compilation, dependency validation, toolchain discovery, host/container jobs,
   commit pinning, requirement placement, explicit waiting, cancellation and unknown-outcome fencing.
3. Implemented: manual/push/PR triggers, durable push notifications, commit-specific checks and PR
   merge gates. Automatic PR jobs require containers; manual owner checks support Mac host builds.
   PR-associated runs never deploy. Successful branch pipelines can hand off to the existing CI
   release engine with a durable intent, predecessor check and runtime receipt. Current CI engine
   restrictions still apply: one existing healthy non-privileged web component on the coordinator,
   unchanged application graph. Arbitrary external/remote deployment targets remain unimplemented.
4. Implemented: project overview with repositories/issues/PRs/pipelines in web and shared Apple UI,
   issue-to-task creation, comments, branch diff, checks, merge, logs and cancellation; scoped
   `deploy_project` agent tool. Native visual acceptance is pending unlock; builds pass.
5. Physical mesh acceptance passed: a Linux container check on SER followed by a native Swift build
   on this Mac, both from the same pinned commit. Browser PR checks passed on both computers too.
   A complete pinned pipeline also passed Linux container → Mac Swift → healthy release on SER;
   the deployment receipt is saved in `docs/evidence/workspace/mesh-release-result.json`. Broader
   external/remote application destinations remain unimplemented. Windows execution is deliberately deferred.

Do not migrate live Groffee data or enable automatic deployment triggers during the backend pilot.

## Daily experience

Open or resume a task conversation directly, with projects and recent tasks close at hand. Within
a project, see active tasks, work needing attention, recent outputs, and linked applications.
Avoid requiring a trip through a dashboard or board to send the next message. Start or continue
work without remembering which computer or vendor application holds its state. Machine and agent
selection are visible, with remembered defaults.

A task follows work → run → verify → deliver. Delivery can mean a deploy.local release, a build
artifact, a package, or a change handed back to the existing Git workflow. Native apps and games
can launch on an eligible worker's desktop; the browser displays status, logs, and artifacts.
Task-scoped browser and computer interaction is included. General remote-desktop administration
and high-frame-rate game/simulator streaming remain outside the initial scope.

Proposed navigation:

- Projects: overview, tasks, outputs, optional applications, and project settings.
- Computers: connectivity, capabilities, active work, and available capacity.
- Applications: retain direct access to existing deployments, including applications with no repo.
- Settings: accounts, agent connections, defaults, and administration.

The default project view prioritizes continue, review, and resolve actions. Computer administration
remains accessible without occupying the everyday coding workflow. There is no Sites or Suitcase
navigation in the target product.

## Shared agent harness across desktop iOS and browser

The desktop app, iOS app, and browser are equal clients of the same deploy.local agent harness. Agent orchestration,
provider adapters, tool execution, session state, and history live behind shared APIs on the
coordinator and workers. No client runs a separate agent loop or owns an independent conversation.
Opening a task in any client attaches to its existing session; it does not start another agent.
This client support is distinct from building native iOS project repositories on an eligible Mac worker.

Core capabilities available in all three clients:

- Connect and sign in to the home coordinator over the local network, with a clear connection and
  certificate-trust setup flow.
- Browse projects, active tasks, application health, and computers.
- Start or continue tasks; select an available agent/model and eligible execution machine.
- Read streamed progress, answer agent questions, handle supported permission requests, and stop runs.
- Send follow-up instructions and steer active runs where the selected adapter supports steering;
  expose the same adapter capabilities and limitations in every client.
- Review diffs, checks, and compatible previews/artifacts. Open supported application URLs.
- Trigger an authorized deployment of the exact reviewed revision and observe its outcome.

Coding, Git worktrees, native builds, and hosted applications execute on home computers. Disconnecting
the client, closing a desktop window, or backgrounding the phone does not terminate them.
Reopening a client replays events from the last
durable cursor and refreshes actual run state. If the coordinator is unreachable, show disconnection
and do not silently queue commands that could execute unexpectedly later.

Use the same command, permission, and event contracts for desktop, web, and iOS from the start. Commands carry
unique operation IDs and state revisions; the coordinator serializes conflicting session changes.
An answered question or permission request is resolved once and updated in every connected client.
Reconnect replays events without resending a prompt or starting a second run. Device switching
does not require a handoff summary, copied chat, or a new model context.

Start production desktop and iOS clients after those contracts pass the first remote-task pilot;
prototype their chat interfaces earlier. Include all three clients in the first complete product
release. Match core harness capabilities while adapting navigation and layout to
each screen. Keep task control and review central; a full mobile editor, general remote desktop,
native-game streaming, and duplicating every administration screen are outside the initial scope.
Push notifications and access from outside the home network need separate design decisions; neither
is assumed by the initial LAN client. The initial iPhone/iPad layout scope remains to be confirmed.

### Desktop companion

The desktop app provides a dedicated chat/workspace experience with keyboard-driven task navigation,
predictable focus, platform menus, and adjacent changes/checks/previews. Persist drafts and layout
preferences locally while using the same authoritative task sessions as iOS and web. Support links
that open the correct project/task. Keep files and workspace paths qualified by their execution
machine; a file on a remote worker is not implicitly available to a local desktop editor.

The desktop UI and machine worker have independent lifetimes. Installing/opening the app does not
automatically enroll the computer for execution. When explicitly enabled, a local worker uses the
same execution contract as other home computers and continues independently of app windows.
Closing a client does not stop the home coordinator. The first desktop app is a native macOS Swift
application sharing a Swift core and reusable SwiftUI views with the iOS app. Agree supported OS
versions and CPU architectures during the machine inventory. Linux computers can participate as
workers and access the browser client before a dedicated Linux desktop app is built.

Evaluate desktop packaging, installation/update behavior, credential storage, file dialogs,
clipboard, keyboard shortcuts, accessibility, and desktop integration on macOS, plus corresponding
mobile behavior on iOS. Measure typing, streaming, long-history scrolling, focus, and task switching
on real target systems. Fedora/Ubuntu client packaging is a later milestone.

### Browser and computer use

Expose Browser and Computer panels beside chat, changes, and checks in the desktop app. The agent
can inspect and interact with a task's browser or selected desktop session, and the user can view
the target, stop agent interaction, and take over. Record tool activity and selected evidence in
the same task history. An embedded page preview alone is not browser automation.

Keep browser automation and computer control as distinct worker capabilities. Browser tools should
support navigation, page inspection, interaction, screenshots, and useful console/network evidence.
Computer tools should support screen inspection and keyboard/pointer interaction with applications,
using structured accessibility information where available. Prototype both against real web and
native-app workflows. A terminal-only or headless worker must not advertise an interactive desktop.

Each session identifies its task, worker, browser profile/tab or desktop target, and current control
owner. The viewing computer and controlled computer may differ. Enrolling a node for builds does
not automatically grant access to its desktop or personal browser. Default to a task-managed browser
profile; connecting an existing signed-in profile is an explicit choice. Show missing OS permissions
and available capabilities before starting interaction. A local desktop session is supplied by a
local worker/helper, not by assuming the UI process owns agent execution.

Allow one active input controller per target. Taking over pauses agent input; returning control is
explicit. Stop must prevent further queued input. On disconnect, lock, permission revocation, or
target replacement, suspend computer input until the same authorized target is revalidated. Other
authorized shell/build work can continue under its existing lifecycle. Reconcile an ambiguous click
or submission from observed state instead of automatically replaying it. Browser/page content and
screen text remain task evidence, never authority to change user instructions or permissions.

Expose these tools through the shared harness protocol so compatible adapters can use them and all
clients can see their activity. The desktop UI is the first full viewing/takeover surface. Browser
and iOS clients can direct the same worker-backed tasks without requiring privileged control of
their own viewing device. Detailed live-view/input layouts for those clients remain to be designed.
Report unsupported adapter tool integrations instead of silently substituting a different agent.

Validate screen capture and input mechanisms on macOS for the initial desktop release. Linux
desktop-control support is a separately validated worker capability; when added, assess the installed portal/backend support;
the RemoteDesktop portal defines session-based remote input and can integrate screen capture:
[XDG RemoteDesktop interface](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html).
Desktop-environment backends vary:
[XDG Desktop Portal backends](https://flatpak.github.io/xdg-desktop-portal/docs/).
Treat permission setup, capture, input, coordinate mapping, and user takeover as separate acceptance
checks. UI framework selection alone does not establish computer-use support.

## Interface technology and chat performance

### Shared infrastructure and client code

Share one server-side harness, provider adapters, worker protocol, project/repository storage,
authorization model, tool registry, session/event history, and deployment integration across every
client. Publish a versioned contract with generated Swift and TypeScript models/API bindings plus
shared replay fixtures. Reconnect, duplicate-command handling, and capability behavior must pass
the same contract tests; generating types alone does not make behavioral implementations identical.

Keep OS-specific integration behind narrow interfaces for secure credential storage, windows,
shortcuts, file pickers, capture, accessibility/input, and notifications. Computer-use helpers run
on the target desktop OS; iOS connects to their sessions rather than hosting desktop-control code.
Keep untrusted browser content separate from the application's privileged native bridge.

Use two separate app targets, macOS and iOS, in one Apple client workspace. Both depend on shared
Swift packages inside the deploy.local repository. Keep the existing React/TypeScript browser
client and the server-side harness. The coordinator does not need a language rewrite.

Proposed shared packages:

- DeployCore: generated protocol models, API/session client, event reduction, reconnect/replay,
  capability state, draft/cache interfaces, and common task/chat presentation state.
- DeployUI: reusable SwiftUI message/tool rows, task summaries, status, and review components.

The macOS app owns windows, menus, keyboard commands, desktop panel layout, and platform bridges.
The iOS app owns touch navigation, mobile layout, keyboard/safe-area behavior, and app lifecycle.
Platform implementations supply secure credential storage and other OS services to the shared
core. Keep the core independent of AppKit/UIKit, and desktop capture/control in the macOS worker
helper rather than the common UI package. Share views when their behavior fits both platforms;
do not force desktop and mobile navigation into identical layouts. Apple documents shared code
and platform-specific app adaptation:
[Apple multiplatform apps](https://developer.apple.com/documentation/xcode/configuring-a-multiplatform-app-target).

Use the chat prototype to refine package boundaries and choose targeted native view components,
not to reopen the selected native Swift direction. The future Fedora/Ubuntu desktop rendering
strategy remains undecided and must preserve the same harness protocol.

### Rendering and interaction

Selected native stack: Swift/SwiftUI for macOS and iOS, with focused AppKit or UIKit components
where measurement or interaction requirements justify them; retain the existing
React/TypeScript stack for the browser. Share the harness protocol, event schema, capability model,
and behavioral fixtures. Maintain separate native and web presentation code, with explicit parity
checks; do not make shared rendering code a prerequisite for a shared agent experience.

SwiftUI should handle navigation, project/task lists, settings, and ordinary controls. Prototype
the transcript and composer before choosing their final implementation. UIKit interoperability
provides an option for precise text input/selection or transcript behavior:
[Apple UIViewRepresentable documentation](https://developer.apple.com/documentation/swiftui/uiviewrepresentable).
Profile updates and scroll hitches rather than assuming the framework guarantees speed:
[Apple SwiftUI performance guidance](https://developer.apple.com/videos/play/wwdc2025/306/).

Use a conversation-centered layout: project/task navigation, the transcript and composer, and
contextual changes/checks/previews. On narrow screens, present the same context through focused
panels. Tool activity is inspectable without overwhelming the conversation. Preserve selection,
drafts, and scroll position when switching tasks; incoming output must not pull a reader away from
older messages. Support accessibility, large text, keyboard input, and code copying from the outset.
Define keyboard commands for task search/switching, composer focus, sending messages, and opening
changes. Preserve predictable focus, platform-standard text editing, and discoverable shortcuts.
Browser shortcuts must coexist with browser/OS shortcuts; test hardware-keyboard behavior on iOS.
Initial native support is macOS and iOS. Validate native platform behavior, keyboard controls,
responsiveness, and useful Swift code sharing. Preserve full core harness access in the browser.

Keep a local cache of recent messages and drafts, tagged with server sequence and connection state;
the coordinator remains authoritative. Show submitted messages immediately with explicit pending,
acknowledged, or failed delivery state. Update only the changing message/tool item, coalesce token
bursts, paginate or virtualize long histories, and cache completed Markdown/code rendering.
Keep parsing and syntax work out of the input/render critical path. Scope subscriptions so a busy
background task cannot repeatedly redraw the foreground conversation.

Before broad UI implementation, replay the same representative event traces in iOS, desktop,
and browser prototypes: a long conversation, streaming code blocks, many tool events, large diffs, and
multiple active tasks. Include typing during streaming, scrolling upward, task switching, and
reconnection. Start with a proposed local interaction target under 100 ms at the 95th percentile
for send feedback and cached task switching, and smooth scrolling at the device's supported refresh
rate on selected test hardware. Measure model latency separately. Record device, dataset, frame
hitches, memory, and input latency; use a targeted AppKit/UIKit transcript or composer if SwiftUI
cannot meet the required behavior after bounded tuning.

## Scope boundaries

Repository hosting and coding tasks require no deploy.local configuration file. For deployment,
`deploy.yaml` is the sole deployment configuration. Use existing repository scripts and the existing
deployment engine. Do not add a project-recipe system, artifact-management product, or separate
reviewed-source delivery workflow. Existing deployment revision tracking and rollback remain in place.

| Area              | Include in the first useful release                                                                           | Defer                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Clients           | The same harness, sessions, and core coding controls in desktop, browser, and iOS; LAN access                 | Full mobile IDE, general remote desktop, and outside-home access infrastructure                                               |
| Interaction tools | Desktop browser/computer panels, worker-backed agent tools, explicit targets, and user takeover               | General remote-administration suite, high-frame-rate game streaming, and automatic access to personal browser profiles        |
| Projects          | Built-in repository hosting; port selected Groffee workspace capabilities; optional deployment links          | Forge feature expansion, bidirectional external-host synchronization, multi-repository orchestration, and disk-wide discovery |
| Tasks             | Durable instructions, conversation events, workspace, checks, changes, and outputs                            | Full IDE replacement and importing all vendor conversation history                                                            |
| Machines          | Explicit placement, remembered defaults, capability checks, configurable concurrency                          | Automatic load balancing and live process migration                                                                           |
| Agents            | One supported existing-agent integration plus an independent model path first; then the other existing agents | Automatic model routing and invisible provider fallback                                                                       |
| Context           | Shared instructions, selected evidence, worktree state, and explicit handoffs                                 | Lossless conversion of private agent state                                                                                    |
| Delivery          | Connect repositories to the existing `deploy.yaml` deployment flow                                            | App-store automation and a universal publishing framework                                                                     |
| Availability      | Browser reconnect, control-plane reconnect, durable worker evidence                                           | High-availability coordination and disconnected edits to shared project metadata                                              |

Suitcase and cross-site data reconciliation are retired scope, not a future milestone. Do not expand
Catalog or the application graph as part of this initiative. Preserve ordinary deployment behavior
and reliability work. Further feature removals require their own explicit scope decision.

## Retire Suitcase and portable sites

Use one authoritative home coordinator. Computers enroll as execution nodes; they do not become
independent coordinators when disconnected. Keep machine enrollment, health, job dispatch, local
workspaces, application placement, routing, logs, and ordinary backup/restore.

The portable-site runtime is removed. The owner approved removing its data inventory on 2026-11-13;
no portable-site inventory, export, or migration is required. Remaining schema and recovery cleanup
follows [the one-server plan](one-server.md). Dated acceptance evidence remains history.

The retired portable-site product included Suitcase target packaging/bootstrap, site pairing, docked/away/
rejoining modes, offline administration, ready-offline gates, application replica selection,
cross-site release exchange, semantic database/file reconciliation, and cross-site authority
transfer. Its runtime entry points and packaging have been removed. Retain shared primitives only where a remaining
workflow uses them; do not delete code solely because its name contains fleet, site, or recovery.

Temporary network loss still matters. Already-running applications continue on their computers,
and coding workers can buffer events and continue previously authorized work under the task
recovery contract. Offline workers cannot create a competing central project history, receive new
coordinator assignments, or independently promote releases. Local Git commits and later pushes
remain ordinary Git behavior, without database synchronization between control planes.

Retirement sequence:

1. Trace dependencies from startup, routes, schemas, CLI, schedulers, storage, and tests. Identify
   shared deployment and recovery code that needs decoupling before removal.
2. Apply the owner’s 2026-11-13 retirement decision: no portable-site data inventory, export, or
   migration is required. Preserve ordinary application storage and Home recovery.
3. Keep the topology at one coordinator plus ordinary nodes. Portable-site runtime entry points,
   background exchange, and packaging are removed.
4. Remove dedicated runtime modules, packaging, and tests; migrate active schema references to the
   simpler model. Keep any legacy migration reader isolated from normal runtime, with an explicit
   removal condition. Historical migration files are not active product features.
5. Verify enrollment, remote execution, routing, deployments, volumes, backup/restore, and worker
   reconnect behavior. Update architecture documentation and mark the old Suitcase plan historical.

Exit: a fresh install exposes no Suitcase/site feature, an existing single-home install upgrades
without disturbing its applications, and no portable-site background loop runs. No portable-site
data inventory is an acceptance gate. Current progress is recorded in `workspace-implementation.md`:
active entry points and packaging have been removed, while shared legacy schema/module cleanup remains.

## Current implementation and reuse

| Existing code                                                              | Reuse or constraint                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/schema.ts` nodes and enrollment records; `bin/deploy.js` agent     | Reuse enrollment, identity, outward connections, service installation, and health patterns. Add coding capabilities independently of Docker health.     |
| `server/store.ts` agent job queue                                          | Current jobs require a deployment name and requeue running jobs after 20 minutes. Do not use this lifecycle unchanged for long-running coding sessions. |
| `server/agent-exec.ts` and `server/ws.ts`                                  | Existing terminals are Docker-oriented and coordinator session state is in memory. Reuse transport/authentication patterns, not this session lifetime.  |
| `server/application-execution.ts` and application revision/runtime modules | Keep deployment execution intact. Add an explicit link from reviewed source/output to release.                                                          |
| `server/edge/`, content store, logs, and recovery modules                  | Reuse routing and storage where their contracts fit. Cover recovery of existing task history and checkpoints; no new artifact store.                    |
| `app/routes.ts` and dashboard routes                                       | Add project routes alongside existing application routes, then simplify navigation incrementally.                                                       |
| Suitcase, cross-site sync/reconciliation, and site-authority modules       | Retire dedicated paths; first separate any code still required by ordinary nodes, deployments, or recovery.                                             |

These are source-level observations, not evidence that the home fleet has been tested for coding
workloads. Existing macOS/Linux agent installation does not establish Windows host-worker support.

## Proposed architecture

Keep one product and deploy.local codebase, with explicit modules for Git hosting, repository sources,
project work, workers, agent adapters, and deployment integration. Port selected Groffee code into
these modules, integrating with deploy.local authentication and storage ownership.
Avoid a platform rewrite or a new service per concept.

The coordinator owns project/task metadata, authorization, run assignments, canonical event history,
and artifact references. Each worker owns its local workspaces, processes, execution environment,
provider sessions, and a durable spool of events awaiting acknowledgment. The browser is a client;
closing it does not own or terminate a task's execution.

Coding runs execute through a worker process boundary that can restart independently of the
deployment agent. Reuse enrollment identity with explicit coding-operation authorization. Run
coding processes as a configured ordinary user; do not inherit the Linux deployment service's
root privileges. Host execution is necessary for native toolchains; container execution can be an
optional workspace mode later.

### Core records

| Record            | Responsibility                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Repository source | Local checkout, external remote, or locally hosted repository; source authority and credential policy                   |
| Project           | Name, owner, repository reference, and optional application links                                                       |
| Workspace         | Project, machine, local path, base revision, branch, environment, and exclusive writer ownership                        |
| Task              | User intent, durable conversation, acceptance criteria, status, and current workspace                                   |
| Run               | One adapter session/attempt, agent and model identifiers, assigned worker, execution state, usage evidence, and outcome |
| Event             | Ordered output, messages, tool activity, questions, decisions, checks, and lifecycle changes                            |
| Output            | Diff/checkpoint, logs, build artifacts, previews, or release links with source identity                                 |

One project has many tasks and optional applications. A task has successive runs. An application
may exist without a project. Begin with one repository per project and one active writing run per
workspace; separate concurrent tasks use separate worktrees.

### Working copies and handoffs

Use a worker-local repository cache and a dedicated worktree per task. Registering an existing
checkout must not reset, clean, commit, or move the user's changes. For the first release, create
tasks from a selected committed revision; show clearly when dirty local edits are not included.
An explicit snapshot/import flow can follow if the pilot requires it.

The task workspace is authoritative for its in-progress files. Central metadata is not a backup
of those files. Store explicit checkpoints and their included file lists; preserve selected untracked
files, honor exclusions, and show when the last checkpoint was uploaded. Large game assets and
Git LFS require an explicit retrieval/storage policy rather than copying dependency/build caches.

Switch agents only after the current run has stopped writing. Start a new run with the task intent,
shared instructions, current revision/diff, relevant decisions, check results, and remaining work.
Retain each adapter's original session reference for its own resume path. Do not represent this as
continuing an identical internal conversation in another harness.

Initial placement is explicit and sticky. A machine going away does not cause a second worker to
start editing automatically. Moving work to another machine is a later checkpoint/transfer action.

### Execution and recovery

Give every run an idempotency key and worker assignment generation. Persist dispatch before
acknowledging it; workers persist acceptance before launching. Duplicate delivery must not start
another process. Events carry run identity and a monotonic sequence; acknowledge and replay from
the last durable sequence, with bounded local spooling and a visible storage-exhaustion outcome.

Distinguish queued, starting, running, waiting for input, succeeded, failed, interrupted, and unknown
run states. Task completion is a separate user/workflow decision. A provider turn completing does
not prove that a build passed or the requested change is finished.

On browser or coordinator disconnection, an existing worker may continue already-authorized work
and buffer events; requests requiring a new user answer wait. On worker restart, reconcile durable
records with actual processes and provider resume support. Report interruption or unknown state
when evidence is insufficient. Never claim seamless process survival after a machine reboot.

Stopping a run must handle its subprocess tree and retain partial changes. Publishing and other
external side effects require their own durable operation record; do not blindly replay them after
an ambiguous failure. New writer ownership cannot transfer while an old writer remains unresolved.

### Agent and model interfaces

Separate two interfaces: an agent adapter drives an existing harness; a model adapter supplies
inference to a common tool loop. Describe supported features explicitly: resume, steering,
cancellation, permission prompts, attachments, model discovery, tool events, and usage reporting.
Unsupported features remain visible instead of being simulated silently.

The common loop initially needs repository reads/search, file edits, command execution, tool-result
handling, bounded context, cancellation, and persisted events. Prefer an existing embeddable,
provider-independent runtime if a short evaluation demonstrates the required behavior and license
fit. Do not build a large new agent framework before that evaluation.

The initial integration candidates have documented entry points:

- Codex app-server supports programmatic sessions and documented authorized ChatGPT plan usage
  for eligible local/open-source integrations: [OpenAI documentation](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
- Cursor exposes sessions, streaming, login, and permissions through ACP:
  [Cursor documentation](https://prod.cursor.com/docs/cli/acp).
- Claude Code exposes programmatic structured output:
  [Claude Code documentation](https://code.claude.com/docs/en/headless).
  Third-party Agent SDK subscription access has a separate restriction:
  [SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview).

Verify installed versions and the user's actual account access during integration. Documented
support is not a successful account test. Provider credentials stay with the authorized worker or
an explicit supported credential mechanism; they are not general-purpose shared API keys.
Show whether a run uses subscription access, API billing, or local inference. Unknown cost/remaining
quota stays unknown. A model listing alone does not prove entitlement. No silent paid fallback.

### Repository commands and application context

Agents use the repository's existing instructions and setup, test, and build scripts through normal
command tools. Do not store a separate set of project recipes. Local paths are qualified by machine;
validate required OS, toolchain, disk, and agent availability before starting.

Link projects to applications deployed using their `deploy.yaml`. Give agents scoped read tools for
deployed revision, health, selected logs, and configuration names; do not preload all logs or resolved
secrets into every prompt. Deployment permissions remain separate from ordinary project edits.
Treat logs and application content as data, not instructions.

Deploy through the existing engine using `deploy.yaml`, preserving revision tracking, health checks,
and rollback. No additional review record, artifact manifest, or delivery configuration is required.
Native and game projects can use their own build and publishing commands without a deploy.local
application. Generated files can be inspected as ordinary task outputs; a new artifact-management
system is outside this scope.

## Milestones and acceptance gates

### 0 Validate the smallest end-to-end slice

First validate the conversation and composer experience with shared replay traces in small desktop,
iOS, and browser prototypes. Validate the shared Swift layer and platform interaction targets before
building broad management screens. This is a prototype, not a second harness implementation.
Include a browser action and a native application action on each desktop target. Verify capture,
input permissions, user takeover, and adapter tool access on macOS before broad desktop implementation.

First map Groffee's existing workspace, Git, identity, and review modules to deploy.local. Define
the porting sequence and schema/identity mapping. Prove create/import, clone, and push against a
disposable repository hosted by deploy.local using its own authentication. Record storage and LFS
requirements and the eventual migration path for existing Groffee data.
The portable-site runtime is removed. Track remaining shared schema and recovery dependencies
under the one-server plan; no portable-site data inventory is required. Do not make unrelated
cleanup a prerequisite for the first pilot.
Inventory the actual computers and installed tools; choose one everyday project and one game or
native project. Test login and a small read-only run through the candidate agent interfaces. Evaluate
an embeddable common runtime and one additional model endpoint. Record real startup latency,
capabilities, billing mode, and any integration blockers. No fleet-wide installation is implied.

Exit: choose the Groffee module porting and data migration boundaries, first existing-agent adapter, independent
model path, two pilot machines, and representative projects based on actual evidence. Resolve how
existing dirty changes are handled. Any live migration remains a separately planned operation.

### 0a Simplify the home topology

Finish the remaining portable schema and recovery cleanup under the one-server plan. No
portable-site inventory or migration is required under the owner’s 2026-11-13 decision.
Decouple shared node/deployment behavior before removing dedicated portable-site paths. Preserve
existing application operation and ordinary recovery throughout the cutover.

Exit: one home authority and enrolled computers remain; portable-site runtime and surfaces are
removed, and the retirement acceptance checks pass. Shared schema and recovery cleanup remains
separate from the completed runtime removal.

### 1 One project and a durable task on a second computer

Port/adapt the selected repository/project/task implementation into deploy.local; add worker capabilities, task worktrees,
durable run/events, one agent adapter,
and a minimal task UI with streamed progress, user questions, stop, diff, and check results. Use
the same worker contract on the coordinator machine when local execution is selected.

Exit: start real work on another computer, close the browser, reconnect elsewhere, inspect changes,
and finish the task. Coordinator restart and reconnect do not duplicate execution. A project with
no Docker setup or deployment can complete this flow.

### 2 Prove model freedom

Add the common runtime/model path and a second existing-agent adapter. Implement explicit handoff
with retained source, instructions, decisions, and verification evidence. Prioritize Codex and Claude after each passes the same capability checks; keep Cursor as a later
integration and expose concrete gaps
rather than declaring blanket parity.

Exit: use an additional model outside the existing harness catalogs on a real task and hand work
between two agents without manually reconstructing project context. Identify which behavior differs
because of the model and which differs because of the harness. Codex and Claude are individually verified for the current release; do not claim Cursor support
until its separate integration passes the same checks.

### 2a Shared harness access across desktop iOS and browser

Build desktop and iOS clients against the harness API and event contracts validated in milestone 1. This can
proceed alongside additional adapters without adding a second task model. Cover coordinator setup,
sign-in, projects, task creation/continuation, streamed progress, questions, stop, and diff/check review.
Verify the same model/agent selection, supported steering, tool activity, and permission controls
in all clients. UI layout can differ; core session behavior cannot depend on the viewing device.
Add application context and exact-revision deployment controls with milestone 3.

Exit: start a task from iOS on a home worker, background the app, continue or answer a question from
the desktop app and browser, then return to iOS and see the same task and changes. Reconnect does not duplicate a command,
and an unreachable coordinator is clearly distinguished from a stopped worker or completed task.
Keep all three clients open simultaneously: updates appear in each, a permission request resolves once,
and conflicting state changes receive an explicit conflict rather than creating competing runs.

### 2b Browser and computer interaction

The agent discovers and requests targets through tools. Show approval for the chosen target when
needed; do not make the user choose a window from a dropdown. Present the captured window as a
draggable surface inside deploy.local with compact takeover/stop controls.

Implement task-scoped browser and computer sessions, adapter tool exposure, desktop viewing panels,
target identity, stop, and user takeover using the mechanisms validated in milestone 0. Keep capture
and control in worker/helpers so the UI can view local or remote eligible machines through the
same session contract. Limit frames/logs and isolate their rendering so they cannot stall chat input.

Exit: an agent exercises a web preview and interacts with a native application on the supported
desktop targets. The user can observe, take over, and return control. Permission denial/revocation,
screen lock, disconnection, and target changes do not produce input to an unintended application.
Verify viewing from another computer, visible tool events in other clients, and explicit reporting
when an adapter or target lacks a capability.

### 3 Connect running applications and non-web outputs

Add optional application links and scoped runtime context. Connect repository projects to the
existing `deploy.yaml` deployment flow. Use repository scripts for native/game builds and existing
external publishing commands or handoff; no separate recipe or artifact-management system.

Exit: fix a web application using selected runtime evidence, verify a preview, and deploy through
its `deploy.yaml`, with the deployed revision visible. Also complete a game or native build, inspect its output, and keep its task visible
without creating a deploy.local application.

### 4 Simplify and use it daily

Make Projects the default work entry point after pilots succeed. Keep application management and
existing URLs working. Inventory actual usage of broader platform features before moving advanced
surfaces or proposing additional removal beyond the agreed Suitcase retirement. Add retention/recovery coverage for Git repositories, LFS, project
metadata, task history, and checkpoints. Rehearse the Groffee data migration, verify references and
permissions, then schedule its cutover and retirement once the required existing workflows pass.

Exit: use the product for a week of ordinary work across the pilot projects, measure friction, and
decide whether it replaces enough tool switching to justify the next milestone. Subscription
cancellation is a separate user decision based on observed usefulness.

## Validation and performance targets

Initial targets, to be confirmed against pilot hardware: a warm project/task view within one second,
warm dispatch to worker acknowledgment within two seconds, locally received events visible within
250 ms at the 95th percentile, and reconnect to recent task state within two seconds under ordinary
history sizes. Measure provider time-to-first-token, checkout/setup time, and build duration separately
so model or cold-toolchain latency is not hidden inside control-plane metrics.

Keep workers warm, reuse repository and dependency caches, paginate history, and stream events.
Do not rebuild containers or synchronize entire repositories to switch the viewing computer.

Required acceptance checks cover duplicate dispatch, event replay, long runs beyond 20 minutes,
browser disconnect, coordinator restart, worker loss, cancellation, approval round trips, incompatible
machines, competing writers, permission boundaries, and publishing the reviewed revision. Include
at least one game/native project in the pilot; web-only validation cannot establish general support.
Validate iOS on a physical device, including LAN setup, background/foreground transitions, network
loss, session expiry, simultaneous browser use, and continuation of the same agent session between
web and phone. Verify core harness capability parity and exactly-once application of deduplicated
user commands across reconnects.
Validate desktop keyboard navigation, focus, window closure/reopening, sleep/wake, and session
continuity with both browser and iOS. Closing the desktop UI must not kill an independent worker.
Run initial native-client acceptance checks on macOS and iOS; record OS versions and device/CPU
coverage. Validate Linux workers separately. A later Fedora/Ubuntu desktop release requires its
own client checks and display/session coverage; worker success does not establish client support.
For browser/computer use, test target selection, browser-profile separation, capture/input permissions,
multi-monitor scaling, takeover contention, stop latency, lost connections, and locked sessions.
Measure chat input/scrolling while live screen output is arriving. Include a native app or game
editor interaction as well as browser testing; successful screen capture alone does not prove control.

Track time to start useful work, manual context reconstruction, task handoff success, time to a
reviewed result, failed/abandoned runs, and visible usage/cost evidence. Compare against the user's
existing workflow on similar tasks. More connected machines is not itself a success metric.

## Open decisions

- Actual OS/toolchain inventory and which machine is the always-on coordinator.
- Supported macOS/iOS versions and device/CPU coverage, installation/update approach, and pilot
  distribution. Fedora/Ubuntu desktop client timing and implementation are later decisions.
- iOS client: iPhone/iPad layout scope, distribution for the pilot, and whether later versions need
  push notifications or access outside the home network.
- Whether the SwiftUI transcript/composer prototype meets the native-feel, keyboard, and
  responsiveness requirements or needs targeted AppKit/UIKit components.
- Which Groffee modules to port first and which existing issue/PR/pipeline workflows must be
  preserved before its live installation can be retired.
- First everyday and game/native pilot projects, plus the additional model to try.
- Whether the first workflows need uncommitted-input snapshots or non-Git project support.
- Browser/computer implementation: embedded versus external browser surfaces, target-session
  permissions, supported desktop environments, and live-view layouts in web and iOS.
- First runtime and adapter choices after the integration spike.
- Retention of existing checkpoints and which worker-local files require backup beyond Git.

Current acceptance work: automatic control-approval continuation passed one-prompt window tasks
with both Codex and Claude subscriptions, including verified input and agent cleanup. Claude text
now streams incrementally as well. Physical iPhone Wi-Fi recovery, Mac retained login and LAN HTTPS,
and expired-session renewal across web/Mac/iPhone now pass. Continue with the remaining client parity,
resilience/performance, physical-device/distribution, and migration gates recorded in
[implementation evidence](workspace-implementation.md). Keep Windows execution deferred. The
week of daily use and live migration remain separate acceptance gates; builds alone do not close them.
