# deploy.local v2: implementation brief

Current client ownership: Electron in `desktop/` is the Mac, Windows and Linux app. The Swift Mac target has been retired under cleanup step 9; `native/Apple` remains the iPhone app. References to Swift Mac builds below record the earlier implementation.

Written: 2026-10-27

This brief turns the v2 design into work an agent can pick up one slice at a time. The design itself is drawn, not written here:

- **Canvas:** https://claude.ai/artifact/3mS7t8tGJgTKdo1bnAanTr. It has 131 boards on 11 pages. Each page is one flow and each row one step, with the web app, iPhone, desktop app and CLI side by side. The Coverage board on Overview lists every step × platform.
- **Design system:** https://claude.ai/artifact/5Sv6UWeiDvpgnenyfDurkZ. It has tokens, `components/bundle.css` (the `dl-*` classes the boards use), and a README with the build rules below.

The source for both lives in [`design/`](../../design/README.md); `node design/tools/render.mjs` renders any board. That README has the parity rules every slice follows.

Board names below (`Live`, `ShipDialog`, …) are the canvas files without `.dc.html`. When a slice says "match `X`", open that board on the canvas. Check it at 1440 px and 700 px for web boards, and at 390 px for iPhone boards.

## Decisions already made

These are settled. Do not reopen them while implementing.

**Places**

1. **Five places.** Home (ask), Projects, Live, Computers and Settings. Agents and Waiting on you sit in the sidebar, and iPhone has the same five tabs.
2. **One inbox.** Waiting on you is the only list of decisions, and answering anywhere answers everywhere. The `!` glyph appears only on those items; everything else shows state with a dot.
3. **Live is its own page.** It lists every running app, grouped by computer, with health in plain words.

**Projects, tasks and releases**

4. **Releases belong to the project.** A release moves every app in the project plus its migrations, and rollback moves the whole project back. Releases, logs, variables and secrets sit on the project. An app page has only Overview and Settings.
5. **A task and its pull request are one page,** with Chat, Changes and Checks.
6. **You start every release.** You press Ship… or merge a pull request; agents never ship. Warden rolls back by itself only when an Approvals rule allows it.
7. **Previews are screenshots you ask for,** taken where the app runs (web, iOS simulator, desktop). You can mark them up with Pen, Arrow and Text in three colors, then send.

**Agents and models**

8. **Agents start on "Ask me" for everything.** Approvals is one matrix of agents × actions. Below 900 px it stacks into one group per agent.
9. **Model defaults live only on Computers › Models.** The composer's model pill changes the current chat only.
10. **Role names are fixed:** Take tasks, Run apps, Serve models, Use the screen, plus Coordinator.

**Platforms**

11. **iPhone is the only native client.** It uses system pickers only and never reads the photo library.
12. **Mac, Windows and Linux get an Electron shell.** It loads the web app and adds a tray, notifications, the bundled worker and the screen-control helper. This replaces `native/Apple/Apps/DeployMac`.

**Public site**

13. **`/` on an install is Apps at home.** This is the household launcher, which honors each app's "Who can open it". A signed-in owner goes straight to Home. The product page (`Landing`) is the public site and also `/about`.

**Sign-in**

14. **The first account uses a password.** A passkey is offered after the browser trusts SER's certificate, never required. The password always works.

### Build rules (from the design-system README)

- **Clients render the same typed events.** Web, iPhone, desktop and CLI draw conversation and inbox items from one event union (below), never from free text.
- **A noun appears only once it exists.** No empty Releases tab on a project that has never shipped, and no Agents section before there is a second agent.
- **Teach a word in place, once.** First-time hints (`FirstTask`) disappear after use.
- **Agents speak rarely.** Work shows as a folded work log; a reply is for results and questions.
- **Shipping is yours to start.**
- **Previews are screenshots on request.**

## What exists today

All paths are relative to the repo root. These are the facts the slices build on.

**Server and API**

| Area              | Today                                                                                                                                                                             | Gap for v2                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Workspace API     | `server/workspace/api.ts`: `/state`, `/tasks/:id`, projects, PRs, issues, pipelines, repository                                                                                   | none structural                                                                                                        |
| Events to clients | Long-poll `/api/workspace/events?after=&waitMs=` (`event-feed.ts`, max 10 s) and WebSocket `/ws` (`server/ws.ts`) for deployments, logs, metrics                                  | Two channels with ad-hoc `type` strings. Need one typed event stream.                                                  |
| Records           | Generic `records(kind, …)` and `events` tables (`server/workspace/store.ts:24`), no TS union                                                                                      | Add the typed unions below, keeping the storage                                                                        |
| Decisions         | Agent questions via `deploy_ask_user` (`questions.ts`), desktop-control approve/deny (`interactive.ts:184`)                                                                       | No inbox query. Pending questions are found per task in the UI.                                                        |
| Releases          | Per application. `CiRelease` is keyed by app (`server/ci-releases.ts:23`); deploys go through `/api/upload` (`server/api.ts:1609`); health check and revert at `api.ts:3164–3210` | **No project release, no project rollback route.** Migration undo exists only in component-profile `logical-rollback`. |
| Worker health     | Node heartbeat (`server/store.ts:488`), restart counts (`crash-tracker.ts`), crashloop event                                                                                      | **No job failure rate, no queue depth.**                                                                               |
| Logs              | `/api/deployments/:name/logs` streams `docker logs` per app                                                                                                                       | Need project-level, filtered by app                                                                                    |
| Backups           | `application-backups.ts` (create/restore per app), recovery bundles (`recovery-bundle*.ts`), `/api/operations/*`                                                                  | Need the pre-release backup and a restore-to-new-copy UI                                                               |
| Secrets and vars  | `/api/deployments/:name/configuration` per app (`application-configuration.ts`, `secrets.ts`)                                                                                     | Move to the project, with an app override                                                                              |
| Auth              | Username and password; `username:token` cookie or headers (`server/api.ts:495–530`); CLI saves the token to `~/.deployrc`; Apple apps keep it in the Keychain                     | **No passkeys, no setup code, no QR pairing.**                                                                         |
| Self-update       | CLI only (`deploy upgrade`, `/cli/version`)                                                                                                                                       | **No coordinator self-release**                                                                                        |
| Push              | none (iPhone long-polls `WorkspaceStore.swift:276`)                                                                                                                               | APNs for Waiting on you and Live failures                                                                              |

**Clients**

| Area    | Today                                                                                                                                        | Gap for v2                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Web     | `app/routes/dashboard/*`: projects, apps, activity, logs, discover, catalog, nodes, settings, `:name/{releases,logs,traffic,settings,build}` | Route map below                                            |
| iPhone  | `native/Apple/Apps/DeployIOS` and `DeployKit/DeployUI`: workspace screens only (transcript, project hub, changes, computers)                 | No Live, apps, releases, inbox or settings screens         |
| Desktop | `native/Apple/Apps/DeployMac` (SwiftUI)                                                                                                      | Replaced by the Electron shell. Not found in the repo yet. |
| Tokens  | `app/design-tokens.json` → `app/design-tokens.css` (`--ds-*`), mirrored in `WorkspaceStyle.swift`                                            | Map the canvas tokens onto these (below)                   |

## Route map (web)

The app stays under `/dashboard`. Every old URL redirects (HTTP 308 for server routes, a client redirect for in-app routes) so bookmarks and links in old conversations keep working.

**New routes and their boards**

| New route                                          | Board(s)                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `/dashboard` (Home: ask)                           | `Home`, `FirstTask`                                                        |
| `/dashboard/inbox` (Waiting on you, plus Answered) | `Inbox`, `AnsweredPhone`                                                   |
| `/dashboard/live`                                  | `Live`, `LiveDark`                                                         |
| `/dashboard/live/:app` (health)                    | `Worker`                                                                   |
| `/dashboard/tasks/:id`, `/changes`, `/checks`      | `Task`, `TaskChanges`, `TaskChecks`, `NewProduct`, `Review`                |
| `/dashboard/projects`                              | `Projects`                                                                 |
| `/dashboard/projects/:p`                           | `Project`, `OneAppProject`                                                 |
| `/dashboard/projects/:p/code`                      | `Code`                                                                     |
| `/dashboard/projects/:p/pulls`                     | `PullRequests` (a PR opens its task page)                                  |
| `/dashboard/projects/:p/issues`                    | `Issues`                                                                   |
| `/dashboard/projects/:p/apps/:app`, `/settings`    | `App`, `AppSettings`, `ImmichApp`                                          |
| `/dashboard/projects/:p/releases`, `/:id`          | `Deployments`, `ReleaseLive`, `ReleaseFailed`, `AutoRollback`              |
| `/dashboard/projects/:p/logs` (`?app=`)            | `Logs`                                                                     |
| `/dashboard/projects/:p/settings`                  | `ProjectSettings`, `SecretEdit`                                            |
| `/dashboard/computers`, `/:id`                     | `Compute`, `Computer`, `SelfUpdate`, `RemoveComputer`                      |
| `/dashboard/computers/models`                      | `Models`                                                                   |
| `/dashboard/computers/add`                         | `AddComputer`                                                              |
| `/dashboard/agents/:agent`, `/tune`                | `Main`, `LongChat`, `Configure`, `TuneWarden`, `KeeperPage`                |
| `/dashboard/agents/new`                            | `NewAgent`, `NewAgentDraft`                                                |
| `/dashboard/settings`                              | `Settings`                                                                 |
| `/dashboard/settings/approvals`                    | `SettingsAgents`, `RuleEdit`, `SettingsAgentsNew`                          |
| `/dashboard/settings/backups`                      | `Backups`, `RestoreData`                                                   |
| `/dashboard/discover`, `/:blueprint`               | `Discover`, `InstallApp`, `UpdateApp`                                      |
| `/` (signed out on an install)                     | `AppsHome`                                                                 |
| `/about`                                           | `Landing`                                                                  |
| `/docs/*`                                          | `DocsHome`, `DocsArticle`                                                  |
| `/changelog`                                       | `Changelog`                                                                |
| `/signin`                                          | `WebSignIn` (and `SessionExpired` as a dialog anywhere)                    |
| `/setup`, `/recover`                               | `FirstAccount`, `RecoverWeb`                                               |
| any `*.deploy.local` host with no app              | `AppNotFound` (served by the edge)                                         |
| an app host while rolling back or stopped          | `AppUnavailable` (served by the edge)                                      |
| coordinator restarting                             | `Restarting` (a static page the edge serves while the coordinator is down) |

**Redirects**

| Old                                                     | New                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `/dashboard/projects`, `/dashboard/repositories`        | `/dashboard/projects`                                                  |
| `/dashboard/apps`                                       | `/dashboard/live`                                                      |
| `/dashboard/activity`                                   | `/dashboard/inbox?tab=answered`                                        |
| `/dashboard/logs`                                       | `/dashboard/live`                                                      |
| `/dashboard/nodes`                                      | `/dashboard/computers`                                                 |
| `/dashboard/catalog`, `/catalog/:id`, `/catalog/import` | `/dashboard/discover`, `/discover/:id`, `/discover/import`             |
| `/dashboard/:name`                                      | `/dashboard/projects/<project of :name>/apps/:name`                    |
| `/dashboard/:name/releases`                             | `/dashboard/projects/<project>/releases`                               |
| `/dashboard/:name/logs`, `/build`                       | `/dashboard/projects/<project>/logs?app=:name`                         |
| `/dashboard/:name/traffic`                              | `/dashboard/projects/<project>/apps/:name` (traffic folds into health) |
| `/dashboard/:name/settings`                             | `/dashboard/projects/<project>/apps/:name/settings`                    |
| `/discover` (public)                                    | `/`                                                                    |
| `/docs/nodes`                                           | `/docs/computers`                                                      |
| `/docs/managing`                                        | `/docs/live`                                                           |
| `/docs/roadmap`                                         | `/docs/ask`                                                            |
| `/docs/deploying`                                       | `/docs/ship`                                                           |
| `/docs/configuration`                                   | `/docs/deploy-yaml`                                                    |

`/dashboard/design-system` stays as an internal page and is rebuilt from the v2 components.

## Contracts

These live in a new `shared/v2/` module, imported by the server, the web app and the CLI. Swift gets matching `Codable` types in `DeployCore`. Storage can stay on the generic records table. These types are the API boundary.

```ts
// One union for everything a conversation shows. Clients render these; agents never send free-form UI.
type ConversationEvent =
  | { kind: 'you'; id: string; at: string; text: string; attachments: Attachment[]; model?: string }
  | { kind: 'reply'; id: string; at: string; agent: AgentId; paragraphs: string[] }
  | { kind: 'worklog'; id: string; at: string; summary: string; steps: WorkStep[]; live: boolean }
  | { kind: 'decision'; id: string; at: string; inboxItemId: string } // renders the InboxItem in place
  | { kind: 'task'; id: string; at: string; taskId: string } // "started a task" link card
  | { kind: 'release'; id: string; at: string; releaseId: string }
  | { kind: 'screenshot'; id: string; at: string; screenshotId: string }
  | {
      kind: 'report';
      id: string;
      at: string;
      title: string;
      sections: { title: string; body: string }[];
    };

type WorkStep = {
  icon: 'file' | 'edit' | 'terminal' | 'pulse' | 'logs' | 'search';
  text: string;
  added?: number;
  removed?: number;
};

// Waiting on you. The only thing that shows "!".
type InboxItem = {
  id: string;
  kind: 'question' | 'merge' | 'rollback' | 'control' | 'install' | 'other';
  title: string; // "Roll back home-gym?"
  text: string; // one or two sentences of why
  from: AgentId;
  projectId?: string;
  taskId?: string;
  createdAt: string;
  actions: { id: string; label: string; primary?: boolean; confirm?: string }[];
  state: 'waiting' | 'answered' | 'expired' | 'withdrawn';
  answer?: {
    actionId: string;
    by: UserId;
    on: 'web' | 'iphone' | 'desktop' | 'cli';
    at: string;
    note?: string;
  };
};

// A release is the whole project.
type Release = {
  id: string; // short commit, e.g. "9c3e1fa"
  projectId: string;
  source: { kind: 'pr' | 'ship' | 'cli' | 'pipeline'; ref: string }; // "PR #43"
  startedBy: UserId; // always a person; agents can't start releases
  apps: { appId: string; from?: string; to: string }[];
  migrations: { id: string; title: string; reversible: boolean }[];
  backupId?: string; // taken before activate when a migration is irreversible
  steps: {
    name: 'prepare' | 'verify' | 'activate' | 'watch';
    state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
    startedAt?: string;
    endedAt?: string;
    detail?: string;
  }[];
  state: 'running' | 'live' | 'failed' | 'rolled-back' | 'superseded';
};
type Rollback = {
  id: string;
  projectId: string;
  from: string;
  to: string;
  reason: string;
  approvedBy: UserId | 'rule';
  ruleId?: string;
  steps: Release['steps'];
};

// Health in plain words. A worker has no address, so health is jobs, queue, process and heartbeat.
type AppHealth = {
  appId: string;
  kind: 'web' | 'worker';
  state: 'healthy' | 'warning' | 'failing' | 'stopped';
  summary: string; // "38% of jobs error since 1:58 PM"
  http?: { path: string; status: number; p95ms: number; reqPerMin: number };
  jobs?: { perMin: number; failRate: number; baselineFailRate: number };
  queue?: { depth: number; oldestSec: number };
  restarts?: { count: number; windowSec: number };
  heartbeatAt?: string;
};

type Role = 'coordinator' | 'take-tasks' | 'run-apps' | 'serve-models' | 'use-screen';
// Matches SettingsAgents (1c6e675): only these five actions are delegable.
// Screen use asks per task; deleting data/removing apps always asks; secrets are never
// available to agents; starting releases is person-only. Legacy action types remain
// readable for compatibility but cannot authorize unattended work.
type ApprovalAction = 'start-task' | 'open-pull-request' | 'merge' | 'rollback' | 'restart';
type ApprovalRule = {
  id: string;
  agent: AgentId;
  action: ApprovalAction;
  projectId?: string;
  mode: 'ask' | 'allow' | 'never';
  limit?: string;
};
type Agent = { id: AgentId; name: string; job: string; computers: string[]; createdBy: UserId };

type Screenshot = {
  id: string;
  taskId: string;
  target: { kind: 'web' | 'ios-simulator' | 'desktop'; url?: string; device?: string };
  takenAt: string;
  image: string;
  markup?: Markup;
};
type Markup = {
  strokes: { tool: 'pen' | 'arrow'; color: 0 | 1 | 2; points: [number, number][] }[];
  texts: { x: number; y: number; text: string; color: 0 | 1 | 2 }[];
};
type Attachment = {
  kind: 'photo' | 'file' | 'screenshot' | 'project-file';
  name: string;
  bytes: number;
  ref: string;
};
```

**Endpoints to add.** All are under `/api/v2`. Old endpoints stay until their screens are gone.

- `GET /inbox?state=` and `POST /inbox/:id/answer`. These wrap `questions.ts`, `interactive.ts` and the new merge, rollback and install decisions.
- `GET /events?after=`. This is one typed stream: `ConversationEvent`, `InboxItem` changes, `Release` and `Rollback` steps, and `AppHealth` changes. Keep long-poll so the iPhone code still works, and add SSE for web and Electron.
- `GET /live`. Returns `AppHealth[]` grouped by computer.
- `GET /projects/:p/releases`, `POST /projects/:p/releases` (Ship) and `POST /projects/:p/rollback`.
- `POST /tasks/:id/screenshots` (take one) and `PATCH /screenshots/:id` (markup).
- `GET` and `PUT /approvals` (the matrix); `GET`, `POST` and `PATCH /agents`.
- `GET /projects/:p/settings`, with variables and secrets and per-app overrides.
- `POST /auth/passkey/{register,login}/{options,verify}`, `POST /setup` (setup code), `POST /devices/pair` (QR).

## Slices, in build order

Each slice is one PR. It merges when its "Done when" items pass and screenshots at 1440, 700 and 390 sit in `docs/evidence/v2/<slice>/` next to the matching boards. Do not start a slice before the ones it depends on.

### 0. Foundations

Tokens, components, contracts and routes.

- Map the canvas tokens onto `app/design-tokens.json`, keeping `--ds-*`:

  | Canvas      | `--ds-*`   |
  | ----------- | ---------- |
  | paper       | canvas     |
  | sidebar     | sidebar    |
  | surface     | surface    |
  | ink         | text       |
  | ink-soft    | secondary  |
  | muted       | tertiary   |
  | line        | line       |
  | line-strong | edge       |
  | selection   | selected   |
  | action      | action     |
  | on-action   | onAction   |
  | accent      | accent     |
  | accent-soft | accentSoft |
  | success     | success    |
  | warning     | warning    |
  | danger      | danger     |

  The two tokens the repo lacks, `focus` and `active`, get added. Regenerate the CSS and `WorkspaceStyle.swift`.

- Port `bundle.css` into React components in `app/components/ui/`, one per `dl-*` family: Sidebar and Nav, Head, Group and Item, Setting, Approval, WorkLog, Composer, Status, Tabs and Seg, Dialog, Banner, Empty and Skeleton, Matrix, Steps, Term and Diff. Each component has default, hover, focus-visible, disabled and loading states (see the `States` board).
- Add `shared/v2` contracts and `/api/v2/events`.
- Add the route skeleton and every redirect in the table above, with a test that each old path lands on its new one.
- **Done when:** the design-system route renders every component in light and dark, and the redirect tests pass.

### 1. One inbox

- Server: an inbox query over questions, control requests and the new decision kinds; answers are idempotent, so the first answer wins and later ones see `answered`.
- Web: the sidebar's Waiting on you section and the `/inbox` page. A decision card renders in place in its conversation, and an answered card collapses (`Inbox`, `.dl-approval.answered`).
- CLI: `deploy inbox` and `deploy status`, with exit code 3 while anything is waiting (`CliStatus`).
- **Done when:** answering on the web, CLI or iPhone updates the other two within 2 s, and an answered item shows who answered, where and when.

### 2. Live and health

- Server: `AppHealth` for web apps (existing checks) and workers. Workers need new signals: job counts and failures, queue depth and oldest job, and restarts in a window. Add a small reporting hook to the worker runtime; `crash-tracker.ts` covers restarts.
- Web: `Live` and `Worker`. The sidebar shows "7 running" or "1 failing".
- **Done when:** a worker that throws on 40% of jobs shows Failing with "40% of jobs error since …" within one minute, and Warden raises a rollback decision.

### 3. Task and pull request as one page, and Ship

- Merge the PR view into the task page's Changes and Checks; the PR list links to the task.
- Add `ShipDialog`: where it runs, its address, who can open it, data. Ship is in the task header and its info panel ("This task", `NewProduct`) and never in chat.
- **Done when:** a new product goes from first message to running at `*.deploy.local` with exactly one Ship press, and no agent action can trigger a release.

### 4. Project releases and rollback

This is the largest backend change.

- Add a `Release` record per project. Prepare builds all apps; verify starts them on a copy and checks them; activate switches all apps and then runs migrations; watch lasts 10 minutes.
- Rollback moves all apps to the target release and reverses reversible migrations. When a migration is irreversible, rollback restores the pre-release backup after showing what would be lost.
- Rebase today's per-app paths (`/api/upload`, `ci-releases.ts`, the `api.ts:3164–3210` revert) onto this. Single-app projects are a project with one app.
- Web: `Deployments`, `ReleaseLive`, `ReleaseFailed`, `Rollback`, `RollingBack`, `WardenReport`, `AutoRollback`. CLI: `deploy releases` and `deploy rollback` (`CliDeploy`).
- **Done when:**
  - A failing verify leaves the project untouched.
  - A rollback of home-gym moves both apps and undoes migration 0042.
  - An auto-rollback happens only when an `ApprovalRule` with `mode: 'allow'` exists.

### 5. Projects, apps and settings

- Project tabs: Overview, Code, Pull requests, Issues, Apps, Releases, Logs, Settings. A tab appears only once it has content ("a noun appears only once it exists").
- The app page has only Overview and Settings. Variables and secrets move to project Settings, with per-app overrides; migrate existing per-app configuration. Logs go to the project.
- Boards: `Projects`, `Project`, `OneAppProject`, `App`, `AppSettings`, `ProjectSettings`, `SecretEdit`, `Logs`.

### 6. Composer, screenshots and markup

- The composer gets + (photos, camera, files, a screenshot of the app, a project file) and the model pill (this chat only).
- Screenshots are taken where the app runs: headless browser for web, `simctl io` for iOS, the desktop control helper for desktop.
- Markup: Pen, Arrow, Text, Undo and three colors. A marked-up screenshot is sent as an attachment with its strokes.
- Boards: `Home`, `PreviewPhone`, `MarkupDesktop`, `MarkupPhone`, `MarkupTextPhone`, `MarkupSentPhone`, `AttachPhone`, `AttachedPhone`, `ModelPhone`.

### 7. Agents and Approvals

- The sidebar + opens New agent: describe the job, then Scout drafts it. A new agent appears in the Approvals matrix with every action set to Ask.
- Add the agent info sheet and the ⋯ menu. Tune links to Approvals and Models instead of duplicating them.
- Boards: `NewAgent`, `NewAgentDraft`, `KeeperPage`, `Configure`, `TuneWarden`, `SettingsAgents`, `RuleEdit`, `SettingsAgentsNew`, `AgentInfoPhone`, `AgentMenuPhone`.
- **Done when:** the matrix stacks below 900 px, and no action runs without an answered decision or an `allow` rule.

### 8. Computers

- Use the fixed role names, one Add a computer path (`AddComputer`, the desktop `Setup`), Remove a computer, and Models with weekly limits.
- Coordinator self-release: deploy.local releases itself like any project, and other computers follow when idle (`SelfUpdate`). Edge serves `Restarting` while the coordinator is down.

### 9. Getting started and sign-in

- The installer asks one question (fresh or recover), prints a setup code, and makes the certificate authority (`InstallSer`).
- The browser finishes setup at `/setup` with a username and password (`FirstAccount`), and recover runs at `/recover` (`RecoverWeb`). The first account never needs a passkey: at setup the browser does not trust SER's certificate yet, and browsers refuse WebAuthn on a site with a certificate error.
- Once the browser trusts SER's certificate, offer to add a passkey, once, as a banner on Home (`PasskeyOffer`) and in Settings › Account. Detect trust by loading a small resource from SER's HTTPS origin, and use WebAuthn only when `window.isSecureContext` is true and that request succeeds.
- Sign-in offers a passkey first when the account has one, and a password otherwise; the password always works (`WebSignIn`). `SessionExpired` returns you to the same page.
- iPhone pairs by QR from Settings › Account › Add iPhone (`SignInPhone`). `deploy login` opens the browser (`CliLogin`).
- Then `Welcome`, `NewProject`, `FirstTask`, and installing from Discover (`InstallApp`).

### 10. Backups and restore

- Nightly backups, plus the pre-release backup from slice 4. Restore goes to a copy first, then you switch (`Backups`, `RestoreData`, `RestorePhone`).

### 11. Public site and docs

- `/` serves `AppsHome`; `/about` serves `Landing`; `Changelog` is plain-language and grouped by release.
- The edge serves `AppNotFound` (closest match by edit distance) and `AppUnavailable`.
- Rewrite the docs to the v2 vocabulary and navigation shown on `DocsHome`:
  - **Start:** Get started, Install on a computer, Add a computer, Your devices.
  - **Build:** Ask and build, Review and ship, Screenshots and markup.
  - **Run:** Live and incidents, Releases and rollback, Projects and apps, Backups and restore, Updates.
  - **Agents:** Agents, Approvals, Models.
  - **Reference:** CLI, deploy.yaml, How it works, Troubleshooting.

  "Nodes" becomes "computers" everywhere. Every CLI example must match `CliHelp`.

- **Done when:**
  - The narrow boards (`LandingPhone`, `AppsHomePhone`, `DocsPhone`) match at 390 px.
  - No page in `/docs` uses "node", "deployment" (as a noun for a release), or "workspace".

### 12. iPhone

This comes before the desktop shell. It extends the iPhone app that already exists, and push notifications are the most useful thing missing on the go. `DeployMac` keeps working until slice 13 replaces it.

- Five tabs: Work, Projects, Live, Computers, Settings.
- Add Live, Waiting on you with Answered, releases, rollback progress, restore, Settings, the offline state, and a failed release.
- APNs pushes for new Waiting on you items and Live failures (`LockScreen`).
- Covered by the Coverage board's iPhone column. The "Later" steps stay out of scope.

### 13. Desktop shell (Electron)

- The window loads the web app.
- The tray shows the Live summary and the inbox (`Tray`). Native notifications carry inbox actions (`Notification`).
- Installing the app makes the computer a worker (`Setup`, `SetupLinux`, `Permissions`).
- A screen-control helper handles Use the screen (`ScreenAsk`, `ScreenWatch`). Show an offline state (`Offline`).
- Preload API: `deployDesktop.{notify, setBadge, worker.status(), worker.setRoles(), control.request(), openExternal()}`. Nothing else is exposed to the page.
- Ship for macOS (signed and notarized), Windows and Linux. Retire `DeployMac` once this reaches parity. This slice comes last among the clients because the Mac already has a working app; Windows and Linux have none until this ships.

### 14. CLI

- Regroup help into Ship, Watch, Decide, Agents, Apps and computers, and Account. Move internals to `deploy help advanced` (`CliHelp`).
- Release output follows prepare, verify, activate, watch (`CliDeploy`). Errors suggest the next command (`CliErrors`).
- `--json` on every command. Positional `[app]` replaces `-a`, with `-a` kept as a hidden alias (`CliRules`).

## Out of scope for v2

These are the "Later" cells on the Coverage board, plus remote access:

- Access away from home. `OfflinePhone` says "Only on your home network"; keep that wording and drop its "Set up remote access" row until this is planned.
- iPhone screens for Search, Warden reports, auto-rollback detail, project internals, logs, Models, Tune, New agent and Approvals.
- Phone-width versions of the changelog and error pages beyond what the responsive web already gives.

The "By design" cells stay on a computer on purpose: installing, joining a computer, screen use, secrets, and adding or removing computers.
