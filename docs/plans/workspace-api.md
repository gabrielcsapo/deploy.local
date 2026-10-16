# Workspace API v1

All endpoints use existing `x-deploy-username` and `x-deploy-token` headers or browser auth cookie. Native clients sign in with POST `/api/login` {username,password}, response {token}. No separate workspace identity.

GET `/api/workspace/state`: `{version:1,cursor,projects,tasks,runs,workers,adapters}`.
Project: `{id,name,owner,sourcePath:string|null,repositoryPath,createdAt}`.
Task: `{id,projectId:string|null,title,status,revision:number,workspacePath,baseRevision,createdAt,updatedAt}`.
Run: `{id,taskId,adapter:"codex",model:string|null,status,sessionId:string|null,createdAt,updatedAt,error:string|null}`.
Message: `{id,taskId,role:"user"|"assistant"|"system",content,createdAt}`.
Event: `{cursor:number,taskId,runId:string|null,type,payload:object,createdAt}`.
Worker: `{id,name,platform,architecture,status,capabilities:string[]}`.
Adapter: `{id,name,available,capabilities:{resume,cancellation,questions,steering,permissions,browser,computer},billingMode}`.
Dates are ISO 8601 strings. IDs are opaque strings. Run statuses: queued, starting, running, succeeded, failed, interrupted. Task statuses: ready, running, review.

GET `/api/workspace/tasks/:id`: `{task,messages,runs,events,cursor,questions}`.
GET `/api/workspace/events?after=0&taskId=optional`: `{events,cursor}` (bounded replay; poll 500ms–2s, refresh snapshot if needed).
POST `/api/workspace/projects`: `{operationId,name,sourcePath?}` -> Project. Without sourcePath creates initialized hosted repo; local path or external Git URL imports committed history without touching source working files.
POST `/api/workspace/tasks`: `{operationId,projectId?:string|null,title,prompt?}` -> Task (prompt optional creates initial run).
POST `/api/workspace/tasks/:id/messages`: `{operationId,revision,content,model?}` -> Run.
POST `/api/workspace/tasks/:id/stop`: `{operationId,revision}` -> Task.
GET `/api/workspace/tasks/:id/diff`: `{baseRevision,headRevision,patch,status,files:[{path,status}],checks:[]}`.
POST `/api/workspace/tasks/:id/check`: `{operationId,revision,command}` -> durable queued check result (execution belongs to the independent worker).

Every mutation requires a unique operationId. Retrying same operation returns the original result. Conflicting task revision or active writer returns 409 `{error}`. Errors use `{error:string}`. Stopping retains files. Follow-up resumes provider session where available. Unsupported steering/permissions/browser/computer integration is explicit. HTTP Git hosting lives at `/api/workspace/git/:projectId/*` using same auth headers or HTTP Basic username/token. Clone URL is coordinator origin + that path.

## Additive worker/model fields

Task/Run may include `workerId` (defaults `local`). Task may include `remoteWorkspacePath` qualified
by that worker. Create-task accepts optional `workerId`. Send-message accepts optional
`adapter:"codex"|"compatible"` (defaults Codex); compatible requires explicit endpoint/model/billing
configuration. Provider session references are adapter-specific. Switching adapters supplies bounded
shared transcript context and preserves each adapter's separate resume reference.

Operator-only POST `/workers/enroll` `{operationId,workerId}` returns `{workerId,workerToken}`.
Re-enrollment rotates the previous scoped token. Workers authenticate using `x-deploy-worker-id`
and `x-deploy-worker-token`, or Git Basic username `workspace-worker.<workerId>` and that token.
They cannot use ordinary client endpoints or push Git.

Worker POST `/workers/register` `{workerId,instanceId,name,platform,architecture,codex}`;
POST `/workers/:id/poll` `{instanceId}` -> `{run:null}` or `{run,task,project}`.
Claims carry `generation`, `assignedInstanceId`, `acknowledgedSequence`. Same assignment is replayed
until resolved; a different process cannot launch it as a new run.
POST `/workers/:id/events` `{instanceId,runId,generation,events:[{sequence,type,payload}]}` returns
`{acknowledgedSequence,stopRequested}`. Sequence starts at one; duplicates acknowledged, gaps and
stale generations rejected with 409. POST `/workers/:id/complete`
`{instanceId,runId,generation,status,error?,sessionId?,workspacePath?,diff?}` persists terminal state.
Unknown previous writer state blocks subsequent task runs. There is no automatic reassignment.

Diff responses include `truncated:boolean`, `excluded:string[]` when applicable. Untracked textual
files are included up to the review limits; private env/key, ignored, oversized and unsupported
files are excluded. Remote results include `workerId` and `receivedAt`; these are evidence of the
last uploaded diff, not a backup of remote files. Remote check recipes return unsupported.

Checks carry `{id,taskId,command,status,exitCode,output,error,timeoutMs,createdAt,updatedAt}`.
Check POST immediately returns the queued job; retries with the same operationId return that same
job's current state. `timeoutMs` is optional (100–60000 ms; default 60000). Queued/running/unknown
checks fence other writers on the task. Task status is `checking` during execution. Task stop also
cancels an active check, retaining output and ending its subprocess group. Events include
`check.queued`, `check.running`, `check.output`, and terminal check outcomes; diff.checks provides
the durable results for every client. An ambiguous worker restart blocks writer reuse.

## Independent conversations

POST `/tasks` accepts `projectId` omitted, `null`, or empty for a task outside any project.
Such tasks return `projectId:null` in state/detail/events. No project record or hosted repository is
created. Each task receives its own working directory with an empty Git baseline for file review;
ordinary message, event, check, stop, revision and idempotency rules remain unchanged.

Worker assignments for these tasks return `project:null`. The worker initializes the same deterministic
empty baseline locally instead of cloning a hosted repository, and verifies its SHA before execution.
Existing project tasks still use project worktrees and scoped Git transport. Clients group null-project
tasks in the top-level Tasks section and project tasks directly under their project.

## Agent coordination tools (implemented October 15, 2026)

One task retains its conversation and primary checkout. The agent can dispatch independent jobs
against immutable source checkpoints on enrolled computers. Clients observe the same jobs without
moving the primary agent or switching conversations. A job is a shell operation, not another chat.

| Tool                    | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `deploy_list_computers` | Discover online state, platform, architecture and capabilities              |
| `deploy_checkpoint`     | Capture the calling agent's current Git workspace, including dirty files    |
| `deploy_run_job`        | Queue an asynchronous command in a fresh checkpoint copy on a computer      |
| `deploy_get_job`        | Retrieve status, bounded combined output, exit code and source digest       |
| `deploy_list_jobs`      | Recover all jobs for this task, including previous turns                    |
| `deploy_cancel_job`     | Request cancellation; queued jobs cancel immediately                        |
| `deploy_ask_user`       | Ask one durable question and wait for the user answer in the same tool call |

Mutations require a unique `operationId`; identical retries return the original result and changed
arguments with the same ID conflict. A checkpoint retry after changing workspace files also conflicts;
use a new operation ID for the new source. Read current state with `deploy_get_job` after dispatch.

Codex and Claude Code receive the stdio MCP server automatically through their worker launch
configuration. Compatible model endpoints receive the same function schemas and task-scoped client.
The tools communicate with `POST /api/workspace/agent/tools` using `x-deploy-agent-token`. Tokens are
stored hashed, expire after 24 hours, and authorize only the issuing task while that run is active.
They cannot use client administration or worker endpoints. The local worker hosts this endpoint on
an ephemeral loopback listener; remote agents use their configured coordinator origin. Tokens are
not part of `/state`, task details, or the model's tool arguments.

The enrolled HTTP worker advertises `checkpoint-jobs` and runs a separate job loop alongside its
agent loop. `/workers/:id/jobs/poll`, `/update`, and `/complete` use the existing worker credential,
instance fencing, and a per-job generation. Completed reports can be retried. Worker restarts mark
previous in-flight jobs `unknown`; commands are never silently replayed. A fresh instance can run
new jobs in new directories while old executions remain explicitly unresolved. Commands have their
own wall-clock timeout even while disconnected. Cancellation of an offline worker remains pending.

`GET /tasks/:id` now includes `jobs`. Task events announce checkpoint creation, job state changes and
output progress. Web/macOS/iOS show job cards with expandable output. Authenticated clients can use
`POST /tasks/:taskId/jobs/:jobId/cancel` with `operationId`; task Stop also requests cancellation of
its active jobs. Cancelling a job independently does not stop the coordinating agent.

### Worker setup and operating limits

Use the existing worker enrollment flow and `pnpm workspace:remote` on each computer, setting
`DEPLOY_COORDINATOR_URL`, `DEPLOY_WORKER_ID`, `DEPLOY_WORKER_TOKEN`, and `DEPLOY_WORKER_ROOT`.
`DEPLOY_WORKER_NAME` optionally supplies a recognizable display name. Existing workers must restart
with the new code to advertise job capability. An execution-only worker needs Node, Git, a POSIX
shell and the project's build tools; Codex or Claude is needed only when hosting that agent itself.
Use the existing trusted HTTPS coordinator origin for LAN connections. The loopback acceptance
worker is deliberately labeled as another process on the same Mac.

- Checkpoints contain at most 8 MiB / 10,000 regular files. Git metadata, ignored files, symlinks,
  common environment/credential paths and private-key files are excluded. Review the returned
  exclusion list; this is not a general secret scanner. Capture while edits are paused: it is a
  per-file copy, not a filesystem-level atomic snapshot.
- Dependencies, Git history, submodules and build caches are not transferred. Supply dependency
  preparation in the command where needed. There is no automatic artifact upload, result patch
  merge, primary-agent migration, or transfer of provider session memory in this slice.
- Jobs execute as the enrolled worker's ordinary OS user. Fresh directories prevent accidental
  checkout collisions; they do not provide an OS security sandbox. Enroll only trusted computers.
  Known agent/provider/worker credential environment variables are removed from job shells.
- Default timeout is two minutes, configurable up to fifteen minutes. Retain the last 64,000
  output characters and mark truncation. Output and source data remain in the coordinator's local
  workspace database; job directories are retained on their workers. Automatic retention/cleanup
  and large-repository incremental transfer remain follow-up work.
- Codex launch config explicitly approves its enumerated deploy tools for unattended execution;
  other MCP server policies are unchanged. Claude uses its normal installed-account authentication
  with a scoped MCP config and explicit tool allow-list. Neither integration converts a subscription
  into a general-purpose provider API entitlement. Compatible endpoints still require explicit
  local/API billing configuration.

Codex MCP configuration follows the official
[MCP reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli); Claude follows the
[Claude Code MCP interface](https://code.claude.com/docs/en/mcp).

## Repository server contract (October 15, 2026)

Project creation now returns HTTP 202 immediately with `repositoryStatus:"preparing"` and a durable
`repositoryOperationId`. Poll `/projects/:id/repository` for setup completion. Retry with the same
operation ID returns the same project's current state. `/state` includes these additive project
fields. Task creation and Git transport return 409 until the repository is ready.

GET `/repositories/setup` reports Git/storage/service readiness. GET
`/projects/:id/repository/{tree,blob,history,diff}` provides bounded owner-scoped source reads; each
response identifies the resolved commit. Task creation accepts optional `ref` for an exact source
revision. POST `/projects/:id/repository/{fetch,retry,cancel}` uses the standard operation ID contract.
Fetch is manual and updates only upstream-tracking branches.

See [the repository server contract and setup guide](repository-server.md) for field definitions,
failure recovery, credential setup, transfer limits, and frontend integration notes.

Task creation also returns HTTP 202 while a local workspace is being prepared. Task fields include
`workspaceStatus`, `workspaceOperationId`, and optional `sourceRef`; detail includes `preparation`.
A first message may be queued immediately, but execution waits for readiness.
POST `/tasks/:id/workspace/{retry,cancel}` uses the standard operation ID contract.
Remote project tasks return ready without constructing an unused local checkout.

## Project issues and pull requests

These owner-scoped routes are under `/api/workspace/projects/:projectId`. They reuse the existing
login and idempotency contract. Worker credentials cannot access them. Issues and pull requests
share a monotonically increasing project number; URLs use their opaque IDs. No YAML is required.

- GET `/issues` or `/pulls`: `{items,nextBefore}`; optional `status=open|closed|merged|all`
  (`merged` only for pulls), `limit` (default 50, max 100), and exclusive `before` number.
- POST `/issues`: `{operationId,title,body?,taskIds?}`.
- POST `/pulls`: `{operationId,title,body?,sourceBranch,targetBranch?,taskIds?,issueIds?}`.
  Source and target must exist as hosted branches and differ. Target defaults to the repository's
  default branch. This creates metadata only; no agent, check, merge, or deployment starts.
- GET `/{issues|pulls}/:id`: `{record,comments,mergeOperation}`. Each record has `revision`.
- POST `/{issues|pulls}/:id/update`: `{operationId,revision,title?,body?,taskIds?,issueIds?}`;
  `issueIds` applies only to pulls. Links must belong to this project and owner.
- POST `/{issues|pulls}/:id/close` or `/reopen`: `{operationId,revision}`.
- POST `/{issues|pulls}/:id/comments`: `{operationId,body}`. Appending a comment does not require
  a record revision; retries deduplicate it. Comments remain plain Markdown data for clients.
- GET `/pulls/:id/diff`: `{baseCommit,headCommit,mergeBase,patch,fastForward}`. Open PRs compare
  current branches; merged PRs retain their original comparison. Git output is bounded to 1 MiB.
- POST `/pulls/:id/merge`: `{operationId,revision,baseCommit,headCommit}` returns HTTP 202 and the
  updated PR with `mergeOperationId`. Supply the full IDs from the diff. The repository service
  supports fast-forward merging, verifies both branch tips in one Git transaction, and atomically
  writes a merge receipt. A changed branch fails without moving the target; refresh and retry
  with a new operation ID. Divergence requires rebasing the source branch first.
- POST `/pulls/:id/retry-merge`: `{operationId,revision}` returns HTTP 202. Explicitly retries a
  failed/unknown operation using its original comparison. A recorded live Git PID fences retry.
  A durable receipt reconciles a merge completed before a service crash; it never rewinds a target
  that advanced subsequently. Unknown/active merges block editing or closing the PR.

Task detail additionally returns `issues` and `pullRequests` linked to that conversation. A task
can exist without an issue; linking does not duplicate conversations or start execution. Merging
neither closes linked issues nor deploys automatically. Reviews, CI gates, notifications, additional
merge strategies, cross-repository PRs, client views and agent collaboration tools remain pending.

## Job placement requirements

`deploy_run_job` accepts either `workerId` or `requirements:{os,architecture?,capabilities?}`.
OS is `linux|macos|windows`; worker platforms map to `linux|darwin|win32`. Architecture is the
worker's advertised value, such as `arm64` or `x64`. All requested capabilities must match.
Providing both pins the worker and validates its requirements; no incompatible fallback occurs.

With requirements only, the job is queued with `workerId:null` until an eligible online worker
claims it. Claims are serialized in an immediate database transaction, and the selected worker
stays assigned thereafter. Job reads include `waitingReason` while unassigned. Existing timeout,
cancellation, generation fencing and restart-unknown semantics still apply. This does not move
or resume the main agent conversation on a different computer.

Current checkpoint command runners support macOS/Linux POSIX shells. Windows registrations do
not advertise checkpoint jobs until a Windows execution/cancellation implementation is validated;
Windows requirements therefore remain visibly queued. This is scheduler groundwork, not YAML
CI/CD support: schema/compiler extensions, toolchain discovery, dependency graphs, trigger/check
integration and deployment handoff are still to be implemented.

## Project pipelines and agent collaboration (2026-10-15)

- `GET /projects/:id/pipelines`: recent runs and failed automatic triggers.
- `POST /projects/:id/pipelines`: `{operationId, ref?, pullId?, taskId?}` starts a manual run.
- `GET /projects/:id/pipelines/:runId`: pinned commit, specification, deployment receipt, jobs.
- `POST /projects/:id/pipelines/:runId/cancel`: `{operationId}` requests cooperative cancellation.
- `POST /projects/:id/issues/:issueId/task`: `{operationId, revision}` creates a linked task.
  It does not start inference. The issue title/body accompanies its first agent prompt.
- PR detail includes commit-specific pipeline checks. `/merge` checks them in the Git worker.

`deploy_project` exposes issue/PR/pipeline reads and authorized mutations to the active agent.
Its project is derived from the conversation; caller-supplied project IDs cannot widen access.
Created records link to that conversation. It uses the same revisions and operation replay
contract as clients and cannot be used from a projectless task. This brings the first-party
coordination surface to seven tools.

The project overview is available in the browser and shared Apple UI, including repository
status, issue/PR forms, comments, issue-to-task, branch comparison, manual checks, merge,
pipeline output and cancellation. Native visual acceptance remains pending while the Mac is locked.

## Shared agent questions (October 15, 2026)

`deploy_ask_user` accepts `{operationId,question,options?}`. The question has 1–2000 characters;
up to five distinct options may contain 1–200 characters each. One pending question is allowed per
run. Its 30-minute deadline is fixed at creation. The adapter waits in the original tool call and
polls only the existing question; transport failures do not recreate the request. Authentication
revocation ends the wait. This is a deploy tool, not provider-native permission or steering support.

Task detail includes `questions`, each with `{id,taskId,runId,question,options,status,answer,
createdAt,expiresAt}`. `expiresAt` is Unix milliseconds. Status is `pending`, `answered`, `dismissed`,
`expired`, or `cancelled`. Events use `question.requested` and `question.<terminal-status>`.

POST `/api/workspace/tasks/:taskId/questions/:questionId/answer` accepts
`{operationId,answer}` or `{operationId,dismiss:true}`. Answers contain 1–4000 nonblank characters.
Only authenticated owner clients can answer; worker and agent credentials cannot. Identical answer
retries are safe even with a new operation ID. Conflicting answers, expired questions, or stopped
runs return 409. Stop cancels pending questions. Skip and expiry return no answer and never imply
consent. Answering supplies task information; computer access still requires its separate approval.

Web and shared Apple clients show the same pending question above the composer, persist an unsent
answer locally, and retain the ordinary message draft. Resolved questions remain available in a
collapsed history. Command-Return submits on Apple clients; web also supports Control-Return.
