# Repository hosting and server setup

The repository service is part of deploy.local. It manages bare Git storage and background imports/fetches; the coding worker remains a separate ordinary-user process. It does not launch agents, run project setup scripts, or enable an interactive desktop.

## Repository and deployment scope

A repository needs no deploy.local configuration to be hosted or used for coding tasks. To deploy through deploy.local, `deploy.yaml` is the sole deployment configuration. Reuse the existing deployment engine and repository scripts; do not introduce project recipes, an artifact-management system, or a separate reviewed-source delivery workflow. Tracking the deployed revision remains ordinary deployment behavior.

## Start and diagnose

Production `pnpm build` bundles `dist/workspace-repository-worker.js` and `dist/workspace-repository-doctor.js`. `pnpm start` supervises the repository service alongside control and edge. All three use the same `DEPLOY_DATA_DIR`. The service restarts independently; already-running coding work does not depend on its process.

For a source-development server or legacy `start:single`, start the repository service separately:

```sh
DEPLOY_DATA_DIR=/absolute/server/data pnpm workspace:repositories
DEPLOY_DATA_DIR=/absolute/server/data pnpm workspace:doctor
```

The disposable `workspace:preview` starts its own repository and pipeline services automatically. Do not start a second one for the same data directory. The doctor reports Git availability, writable storage, available disk bytes, and repository-service heartbeat; its exit status is nonzero until all prerequisites are ready. Authenticated clients get the same report and their operation counts from `GET /api/repositories/setup`.

Private Git sources use the server service account's existing Git credential helper or SSH configuration/agent and known-hosts store. Configure these for that account before importing. Import is noninteractive; prompts produce a visible failed operation. Source URLs containing credentials or query parameters are rejected. SSH user names are allowed. A local import path means a path on the server, not on the phone or another computer.

## Create or import

`POST /api/repository-projects` accepts `{operationId,name,sourcePath?}`. Omit `sourcePath` for a hosted repository; provide an absolute server path or an HTTP(S)/SSH Git remote to import committed history. The response is the project, with HTTP 202 and `repositoryStatus:"preparing"`. Retrying the same command returns the same project and its current setup state.

Poll `GET /api/projects/:id/repository`. The response includes:

- `status`: `preparing`, `ready`, `failed`, or `unknown`.
- `source`: original location, kind (`hosted`, `local`, `remote`), `authority:"deploy.local"`, and `syncPolicy`.
- `operation`: durable ID, kind, status, timestamps, cancellation request, error, and active Git process ID where present.
- `serviceOnline`: whether the background service has a fresh heartbeat.
- When ready: `head`, `defaultBranch`, `refs`, and relative authenticated `clonePath`.

Empty sources get an initial commit and a usable `main` branch only in the hosted copy. Imports preserve source branches/tags and committed history, without changing the source checkout or including its dirty edits. The hosted copy has no implicit origin push destination. Staged storage is published by atomic rename only after validation. Git templates and source hooks are disabled.

An operation moves through `queued` → `running` → `succeeded`, `failed`, or `cancelled`. A service crash makes an in-flight operation `unknown`; it is not replayed automatically. `POST .../repository/retry` with a fresh operation ID retries a failed/cancelled/unknown operation. Retry is refused while its recorded Git process is still alive. If a crash happened after the final rename, retry verifies the repository's project marker and adopts the completed copy instead of replacing it. `POST .../repository/cancel` cancels queued work immediately or terminates the running Git process group.

Task creation and Git transport reject repositories that are not ready with HTTP 409. The application pass should show progress/error/retry states and disable new task creation until ready. Current clients still receive the familiar project shape plus additive fields.

## Source authority and fetch policy

The hosted copy becomes the project's source of truth. Import is not bidirectional synchronization. `POST .../repository/fetch` with a new operation ID fetches source branches atomically into `refs/remotes/upstream/*`; it does not change local branches, default HEAD, active task worktrees, source files, or the external remote. Tags are preserved by the initial import; subsequent fetches do not update tags or prune upstream refs. External publishing remains an explicit ordinary Git action.

Clone/fetch/push use the existing authenticated smart HTTP path `/api/git/:projectId`. Use a normal deploy.local account and its session token as the Git password, or the existing supported auth headers. Keep tokens in a credential manager, not a clone URL. Enrolled execution workers retain read-only access to their assigned project; they cannot browse unrelated projects or push.

Transfers have backpressure, a deadline, bounded CGI headers, cancellation on client disconnect, and failure responses when Git cannot start. Only smart Git discovery/RPC paths are served; repository internals and dumb HTTP files are not exposed.

## Commit-pinned source context

Authenticated, owner-scoped reads are available under `/api/projects/:id/repository`:

| Route      | Inputs                                          | Result                                                               |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| `/tree`    | `ref` (default HEAD), `path`                    | Resolved commit and tree entries with object IDs/modes               |
| `/blob`    | `ref`, required `path`                          | Resolved commit, byte size, exact UTF-8 content or explicit omission |
| `/history` | `ref`, optional `path`, `limit` (1–100)         | Commit IDs, parents, author, date, subject                           |
| `/diff`    | `ref`, `base` (default parent), optional `path` | Both resolved commits and textual patch                              |

Resolve a branch once and use the returned commit on subsequent requests to keep a consistent view while pushes arrive. `POST /tasks` accepts an optional `ref` and creates its isolated branch from that exact resolved commit. Binary blobs and files larger than 256 KiB return metadata instead of fabricated text; larger tree/history/diff responses fail with a size-limit error. No text-conversion filters or external diff tools execute.

## Task workspace preparation

`POST /tasks` now queues large local worktree preparation in the same durable service and returns HTTP 202 with `workspaceStatus:"preparing"`. The normal first message can be sent immediately: it is persisted once and remains queued until preparation succeeds. Local and HTTP execution workers refuse unprepared workspaces. Task detail includes a `preparation` operation with progress/state/error fields; the diff endpoint returns a preparation status until files are ready. Checks require a ready workspace.

`POST /tasks/:id/workspace/retry` or `/cancel` uses an operation ID. Retry is explicit after failure, cancellation or restart; a recorded live Git process fences retry. Successfully prepared workspaces have a completion marker for post-crash recovery. Partial files without that marker are preserved for manual inspection and are never erased by retry. A cancelled/failed preparation leaves any accepted message queued; retry can resume preparation, or the ordinary task stop command can cancel the message.

Selected project commits are retained under task-specific Git refs. A remote project task needs no redundant coordinator checkout: its assigned worker fetches the pinned revision, including upstream-only commits absent from a normal clone. Projectless tasks prepare a small deterministic baseline. Command deduplication uses short immediate database transactions to avoid read-to-write upgrade races with service heartbeats; copying repository files happens outside those transactions.

## Acceptance and remaining server work

Automated acceptance exercises a real independent repository-service process and HTTP API: delayed import with responsive state reads, operation replay, dirty-source preservation, owner isolation, clone/push, commit-pinned source/task creation, manual fetch without branch mutation, empty sources, cancellation, retry, process fencing, and post-rename recovery. Existing worker/coordination tests retain scoped Git authorization checks.

Issues/pull requests, mesh YAML pipelines, scoped agent tools and project views are implemented below. Remaining work includes broader deployment destinations, generated client contracts, recovery/retention, and migration/cutover. No additional repository configuration or release subsystem is required. The Groffee data/LFS/issues/PR inventory and rollback rehearsal precede live migration. The portable-site runtime is removed. The owner approved removing its data inventory on 2026-11-13, so no portable-site inventory is required; remaining shared schema and recovery dependencies are handled by the one-server plan. Physical LAN/Linux testing, signing, and client polish remain separate acceptance gates. No live Groffee or deployment data is moved by this implementation.

## Issues, pull requests, and mesh job placement

The server now provides project-scoped issue/PR creation, editing, comments, close/reopen and task
links through the [workspace API](workspace-api.md#project-issues-and-pull-requests). Pull requests
compare real hosted branches. Explicit fast-forward merges run through this repository service;
source and target are checked atomically with a durable merge receipt. Restart recovery requires
explicit retry and does not execute a completed merge twice. Linked issues do not auto-close, and
merging does not deploy. Existing Groffee data is not migrated by these endpoints.

Agent checkpoint jobs now accept OS/architecture/capability requirements and can wait unassigned
for an eligible computer. The same durable job remains in its conversation after assignment.
Current runners support macOS/Linux. Windows execution is explicitly deferred. YAML pipelines, push/PR triggers, commit check gates, scoped agent tools and web/Apple project views are implemented. Unassigned jobs display a waiting reason.

## Pipelines in deploy.yaml

The optional `pipeline` section uses the existing application compiler. A repository containing
only this section needs no dummy component. Top-level `jobs` retain their application lifecycle
meaning; `pipeline.jobs` are checks/builds executed by ordinary mesh workers.

```yaml
apiVersion: deploy.local/v1
kind: Application
pipeline:
  on: [manual, push]
  branches: [main]
  jobs:
    linux-check:
      runsOn:
        os: linux
        architecture: x64
      container: node:26.11.1-slim
      run: npm ci && npm test
      timeoutSeconds: 600
    mac-build:
      needs: [linux-check]
      runsOn:
        os: macos
        capabilities: [swift]
      run: swift build
```

The compiler rejects dependency cycles, missing jobs, unknown fields, incompatible container
placement and Windows execution. Container jobs require Linux and Docker. Host jobs run as the
worker's ordinary user. Workers discover Git/shell/Node and available Docker/Swift/Xcode/Python/
Git LFS capabilities. Missing capacity or tools leaves the job queued, without changing its OS.

Each run pins a Git commit under a retained ref. Every job fetches that commit into a separate
working directory; dependencies release only after successful completion. Failure/timeout skips
dependents. Cancellation stops assigned work; lost/unknown execution is not silently replayed.

Push notifications persist before the Git HTTP response completes, and ref scans deduplicate by
project/ref/commit. `pull_request` triggers follow the open PR's source commit and target branch.
Automatic PR checks require container jobs. Owner-triggered manual PR checks may use Mac host
commands. A PR-associated run never deploys. If the source YAML enables PR checks, merge requires
successful checks for that exact source commit. A changed commit cannot reuse earlier results.

Add `pipeline.deploy: {application: existing-app-name}` for an authorized branch pipeline to
publish after all checks succeed. The coordinator reconstructs source from the pinned commit and
uses the existing CI release API. Durable publication intent, predecessor, archive hashes and
runtime receipt survive lost responses. Credentials are short-lived, application-scoped, revoked
after each request cycle and never supplied to jobs. Checks and deployment status are separate.
Unknown/interrupted releases require the existing application recovery flow; no automatic rollback
or blind re-upload is inferred from a disconnected client.

Current release-engine limits remain: an existing healthy coordinator application, one built
non-privileged web component and unchanged application graph. Arbitrary external platforms and
remote application placement are not enabled by this bridge. Source archives are limited to
100 MiB expanded; submodules and LFS extensions are explicitly rejected. No new deployment file,
artifact product or separate recipe is needed.

`pnpm start` supervises the pipeline service. Legacy/source setups can run
`DEPLOY_DATA_DIR=/absolute/server/data pnpm workspace:pipelines` beside the coordinator.
Publication defaults to its loopback control port (`CONTROL_PORT`, default 7843). A legacy server
may set `DEPLOY_PIPELINE_ORIGIN` to the same coordinator's trusted HTTPS origin; use normal Node
CA trust configuration. The disposable workspace-only preview has no deployment engine.

## Git LFS

Hosted repositories support the Git LFS basic batch, upload, verify and download protocol under
`/api/git/:projectId/info/lfs`; the optional `.git` suffix is accepted. Objects are
streamed, SHA-256 verified and published atomically, with a 2 GiB per-object limit. Downloads are
owner/project scoped. Workers can only download assets for a currently assigned repository and
cannot upload. Objects live beside the bare repository in its standard `lfs/objects` layout.

Install Git LFS on execution computers that work on LFS repositories. Workspace preparation
hydrates verified assets locally or through the scoped worker transport; missing objects/tools
produce a preparation failure. Required clean filters retain pointers in subsequent Git commits.
Deployment archives expand and verify LFS content, subject to their ordinary source size limit.

Git repository import alone does not transfer external LFS storage. Populate it with ordinary
`git lfs push --all <hosted-remote>` before using an imported LFS project. Migration tooling must
copy and bind the existing LFS objects explicitly. Git LFS locks and storage retention/quotas
remain outside this initial transport implementation.

Protocol references: [Git LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
and [basic transfers](https://github.com/git-lfs/git-lfs/blob/main/docs/api/basic-transfers.md).

## Offline workspace recovery

`pnpm workspace:recovery` creates and verifies a local directory snapshot of the entire coordinator
workspace: its SQLite database, hosted Git repositories and refs, LFS, conversation history,
checkpoints, model-session records, and local worktree files (including dirty/untracked files).
Files are streamed for hashing and copying; LFS is not embedded in an in-memory JSON/base64 bundle.

Stop the coordinator, repository service, pipeline service, and coding workers first. Finish or
explicitly resolve pending/unknown runs, checks, jobs, repository operations and release intents.
The command rejects those pending states, live worker PIDs, source changes during copying,
external/absolute symlinks and special files. It verifies the copied files against the original
inventory and flushes files/directories before publishing the snapshot.

```sh
pnpm workspace:recovery snapshot /absolute/.deploy-data/workspace /absolute/backups/workspace-2026-10-15
pnpm workspace:recovery verify /absolute/backups/workspace-2026-10-15
# Only while stopped, with the original workspace path absent:
pnpm workspace:recovery restore /absolute/backups/workspace-2026-10-15 /absolute/.deploy-data/workspace
```

Production bundles also include `dist/workspace-recovery.js` with the same arguments. Restore never
replaces an existing destination and currently requires the original absolute path, preserving Git
worktree backlinks and persisted task paths. Restore clears worker liveness and credentials; remote
computers must enroll again. It does not restart work or applications.

This is an owner-only **unencrypted local snapshot**. Store it on a protected/encrypted backup
volume; it contains private source and conversation data. Its hashes detect corruption, not a malicious
replacement of the manifest. It complements the existing home-recovery bundle, which retains user
accounts, trust keys and deployment metadata. It does not include external provider authentication,
remote computer worktrees/spools, or files outside the workspace. Preserve those separately and restore
a matching home backup. Online coordinated backup, automatic retention, relocation and full-fleet
recovery remain outstanding; the offline command does not claim those guarantees.
