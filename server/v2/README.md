# V2 inbox and events

The router is mounted in `server/api.ts` with its existing `requireAuth` helper. Cookies
(`deploy-sh-auth`) and `X-Deploy-Username` / `X-Deploy-Token` headers work as before.
Every read, cursor and mutation is scoped to the authenticated username. Agent and worker
credentials cannot answer decisions or read this feed. No background service is added.

## Client contract

Import types by relative path from `shared/v2/contracts.ts` and `shared/v2/api.ts`.
The existing TypeScript include covers `shared/`; the `@/` alias remains app-only.
Node's type stripping, Vite, and the existing CLI esbuild pipeline resolve these modules
without configuration changes. `bin/*.js` may use JSDoc `import('../shared/v2/contracts.ts')`
for types; TypeScript clients use `import type`. The contract module has no runtime dependencies.
Swift equivalents are public Codable types in DeployCore's `V2Contracts.swift`, including
flat `kind`-tagged conversation objects and two-element arrays for markup points.

- `GET /api/inbox?state=waiting|answered` returns `{ items: InboxItem[] }`.
  The default is `waiting`; items are sorted newest first, then by ID.
- `POST /api/inbox/:id/answer` takes `{ actionId, on, note? }` and returns `{ item }`.
  `on` must be `web`, `iphone`, `desktop`, or `cli`. The server supplies `by` and `at`.
  Use the exact action ID from the item, and URL-encode the item ID in paths.
- Question IDs are `question:<legacy-id>`. Options have action IDs `option:0`, `option:1`,
  etc. `answer` sends free text in `note` (1–4000 characters after trimming); `dismiss`
  uses the existing dismissal path. An option may also include a note for the answer record.
- Control IDs are `control:<legacy-id>`, with `approve` and `deny` actions. Approval invokes
  the existing operator path, retaining its run, worker-instance, target, lease, and session
  exclusivity checks. Clients do not supply worker IDs or operation IDs.
- The first accepted answer and its provenance commit in one SQLite immediate transaction
  with the legacy mutation. Every later answer, even an identical retry, returns HTTP 409
  with `{ error, answer, item }`. A failed approval saves no answer. Expired or withdrawn
  items also return 409 with `answer: null`.
- Legacy answers remain final. Older routes do not store client provenance, so those answered
  items omit the optional `answer` field; conflicts return `answer: null`. The original
  question text answer is retained in the legacy record. Clients should show unavailable
  provenance rather than inventing who/where/when. Route all new clients through v2 answers.

## Feed and storage

`GET /api/activity-events?after=0&waitMs=10000` returns
`{ events: V2Event[], cursor: number, supportsWait: true }`. Both query values must be
non-negative safe integers; the wait is capped at 10 seconds. A disconnect cancels its timer.
The envelope contains `cursor`, `taskId`, `runId`, `at`, and either:

```ts
{ type: 'inbox', item: InboxItem }
{ type: 'conversation', event: ConversationEvent }
{ type: 'health', app: AppHealth }
{ type: 'release', release: Release }
{ type: 'rollback', rollback: Rollback }
```

Poll again with the **response cursor**, even when `events` is empty. The cursor advances
past ignored workspace events. Clients upsert conversation events by `event.id` and inbox
items by `item.id`; assistant text and work items reuse IDs as they grow. The initial feed
starts at zero; there is no SSE in this server slice. Keep long-polling immediately after
each response to observe other clients within two seconds.

`v2-inbox-answer` records hold provenance. `v2-inbox` records hold materialized inbox items.
Reads and waits reconcile these from existing questions and control requests using their
exported read functions. Changed snapshots append `v2.inbox` events in the same transaction.
This observes legacy writes and time-based expiry without changing workspace behavior.
The wait polls SQLite every 50 ms, so it also sees independent worker processes. Multiple
readers do not append duplicate snapshots. History already emitted is immutable; changes
that happened entirely before a first v2 read project their current state, not invented
intermediate states. The legacy events table remains the shared cursor authority.

Legacy runs do not have v2 Agent records. `from`/`agent` use `run.agentId` if supplied,
otherwise the existing adapter ID (`codex`, `claude`, `compatible`), and finally `scout`
for missing run context. Agent configuration is a later slice. User messages currently have
no attachments in workspace storage, so they map to `attachments: []`.

## Workspace event mapping

| Existing event                                                                                                                                      | V2 result                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `message`, role `user`                                                                                                                              | `you`, retaining ID, content, time; run model when present                         |
| `message`, role `assistant`                                                                                                                         | `reply`, paragraphs split on blank lines; stable provider item ID when supplied    |
| `question.requested`                                                                                                                                | `decision` referencing `question:<id>`                                             |
| `control.requested`                                                                                                                                 | `decision` referencing `control:<requestId>`                                       |
| `item.started`, `item.updated`, `item.completed` with `command_execution`, `file_change`, `web_search`, `tool_call`, `tool_result`, `mcp_tool_call` | `worklog` keyed by run and item, one typed step; completed items set `live: false` |
| Any question/control change observed by reconciliation                                                                                              | Persisted `{ type: 'inbox', item }` snapshot                                       |

Unmapped event types and reasons (including dynamic event families):

| Existing event or family                                                                                                                                                    | Reason                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `question.answered`, `question.dismissed`, `question.expired`, `question.cancelled`                                                                                         | Reflected in inbox snapshots, not another conversation card                                    |
| `control.denied`, `control.opening`                                                                                                                                         | Approval/denial reflected in inbox snapshots; opening also occurs without an agent request     |
| `control.active`, `control.transferring`, `control.suspended`, `control.stopped`, `control.queued`, `control.completed`, `control.unknown`                                  | Screen session/command lifecycle has no conversation contract yet; not a new decision          |
| `item.*` with `agent_message`                                                                                                                                               | Worker paths emit normalized `message` events as well; avoid duplicate replies                 |
| Other `item.*` types (including reasoning, todo lists, provider errors), or missing IDs                                                                                     | No clear WorkStep representation; preserve original workspace feed                             |
| `message.delta`, message roles other than user/assistant, messages without string content                                                                                   | No guaranteed complete text/identity for this contract                                         |
| `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `usage`                                                                                                  | Provider protocol/session/billing data, not user conversation content                          |
| `provider.event`, `provider.output`, other provider passthrough event names                                                                                                 | Unstructured provider payloads are not free-form UI                                            |
| `run.queued`, `run.assigned`, `run.running`, `run.stopRequested`, `run.succeeded`, `run.failed`, `run.interrupted`, `run.unknown`                                           | Run lifecycle is not a project release; no dedicated ConversationEvent variant                 |
| `task.created`, `task.prepared`                                                                                                                                             | Task lifecycle metadata; not evidence that an agent started a linked task in this conversation |
| `checkpoint.created`                                                                                                                                                        | Checkpoint metadata has no ConversationEvent variant                                           |
| `job.queued`, `job.running`, `job.progress`, `job.cancel_requested`, `job.succeeded`, `job.failed`, `job.cancelled`, `job.unknown`, any other `job.<status>`                | Coordination jobs are not project releases or app health                                       |
| `check.queued`, `check.running`, `check.output`, `check.stopRequested`, `check.succeeded`, `check.failed`, `check.interrupted`, `check.unknown`, any other `check.<status>` | Checks have no conversation variant in this slice                                              |
| Future/unrecognized types                                                                                                                                                   | Ignored while advancing the cursor; retained in the existing workspace feed                    |

Merge and install producers, and SSE, remain later slices. The public unions already include their agreed shapes. A work item without
a completed event remains live; run-level folding/failure presentation is not inferred here.

## Validation

`node --test server/v2/contracts.test.ts server/v2/api.test.ts` covers contract builds and Swift
JSON parity; actual API auth helpers without starting background services; owner isolation;
legacy and v2 answers; separate-process answer races; control validation; invalid bodies;
long-poll replay, expiry, independent processes, cancellation, and the ten-second cap.
All database fixtures use temporary directories; HTTP fixtures bind only ports 5180–5199.

## Live and worker health (slice 2)

`GET /api/live` returns `{ summary: { running, failing, warning, checkedAt }, computers }`.
Computers have `id`, `name`, fixed `roles`, `online`, optional CPU/memory/disk percentages,
and `apps`. Apps are `AppHealth` plus `name` and optional `project` (project ID), `address`,
`release`, `releasedAt`. Stopped apps remain in the response but do not count as running.
`GET /api/live/:app` returns `{ app, history: [{ at, failRate?, p95ms? }] }`.
Unknown measurements are omitted. Ratios (`failRate`, `baselineFailRate`) are 0–1.
The owner is always taken from authentication, never from a report body.

Changes appear in the existing long-poll feed as `{ type: 'health', app: AppHealth }`, with
its existing cursor envelope. Reports publish immediately; client reads refresh other health
signals at most every 15 seconds. The UI long-polls and also refreshes every 15 seconds.
No separate background service is required. Job history retains one hour (at most 360 samples)
in existing workspace records. HTTP history uses the existing request-series p95 buckets and omits empty buckets; no
chart is manufactured. Computer metrics appear only when the heartbeat reports percentages.

Web checks use the active single-component application's configured HTTP health path and its
registered runtime port on its assigned computer. They never follow redirects; only 2xx responses establish a passing check. The optional HTTP metric object appears only when requests supply an actual p95; a
check duration is never substituted for that percentile. Legacy TCP
startup success is not sufficient to claim Healthy. Without a configured HTTP check, show
“Health checks unavailable”; current request errors, high memory, offline computers and
observed restart counts can still establish warning/failure. Request/error/p95 measurements
come from `getCurrentHealth`, and memory from the existing metrics collector's stored samples.
The existing crash tracker exposes only observed deltas in its five-minute window. Multi-component
health admission and individual component URLs are not guessed from an application's first port.

### Report from an app

`POST /api/health/report` accepts:

```json
{
  "appId": "home-gym-sync",
  "jobs": 100,
  "failures": 1,
  "intervalSec": 60,
  "queueDepth": 0,
  "oldestJobAgeSec": 0
}
```

`jobs` includes failed jobs. Counts are **deltas for disjoint intervals**, not lifetime counters.
Report every 10–60 seconds, including idle windows. All numbers must be non-negative safe
integers; failures cannot exceed jobs. Overlapping reports are rejected (one second clock/jitter
allowance). Timestamps come from the server. The body is capped at 8 KiB.

Use `Authorization: Bearer <app CI token>` (the existing app-scoped credential). An existing
computer agent can instead send `X-Deploy-Node-Id` and `X-Deploy-Node-Secret`; it may report only
apps currently assigned to that computer. An authenticated owner session may report its own apps.
Expired/revoked tokens and cross-app/cross-owner reports fail. Do not give a worker an owner's
session token when an app-scoped token is available.

The dependency-free helper can be imported by Node/TypeScript apps:

```ts
import { reportHealth } from './server/features/observability/health-report.ts';
await reportHealth(process.env.DEPLOY_COORDINATOR!, process.env.DEPLOY_APP_TOKEN!, {
  appId: 'home-gym-sync',
  jobs: 100,
  failures: 1,
  intervalSec: 60,
  queueDepth: 0,
  oldestJobAgeSec: 0,
});
```

Call it after collecting a reporting window in your job runner. Reset counters only after a
successful report; on uncertain delivery start a new window rather than retrying overlapping
deltas. The helper deliberately does not start timers or replace the app's job execution.

### Exact failing rule

1. Each interval's rate is `failures / jobs`. A zero-job interval has no failure evidence.
2. Learn a baseline from non-breaching observed intervals, requiring at least 120 reported
   seconds and at least one completed/failed job. Baseline is total failures / total jobs;
   bootstrap learns only intervals at or below 10%. There is no invented 1% default. While
   learning, the app is Warning, including if it starts with 40% failures. The optional jobs
   object is omitted until the baseline exists; an unknown baseline is never reported as zero.
3. A breach requires **both** `rate > 0.10` **and** `rate > 5 * baseline` (strict inequalities).
   With a measured zero baseline, any rate over 10% breaches. Freeze the baseline during breaches.
4. Failing begins when report receipt timestamps span **at least 120,000 ms** of uninterrupted
   breaches. At least three 60-second reports are required. A non-breach, idle interval, or gap
   over 90 seconds resets the breach. A stale report becomes Warning after 90 seconds and can
   never remain Healthy. Queue age over one minute also produces Warning.
5. Baseline accumulates normal intervals; after 24 hours of reported normal time, halve its
   totals to bound its weight. Incident windows cannot train their own failures away.

The task's explicit two-minute rule takes precedence over the brief's one-minute acceptance
sentence. After baseline learning, 40% failures become Failing on the report at two minutes
from the first breach, not within one minute.

### Releases and Warden integration

Live reads the current release and activation time from the release service's
`v2-project-current` pointers. Rollback updates that pointer too; pointer changes invalidate
Live's cache. Older receipts fall back to their Activate step timestamps. There is no separate
health-release store. Only apps in the current release receive that project's metadata.

A failing worker in a release aged `0 <= age < 1 hour`, with a complete prior release,
asks `requestWorkerRollback` in `features/releases/project-release-service.ts`. It uses the persisted project snapshot
(or resolves older projects asynchronously before creating a decision), then calls
`projectReleaseService.requestAutoRollback`. A changed pointer invalidates stale evidence.
Warden's approval rules apply: never does nothing, unrestricted allow starts the project
rollback, and ask creates one decision with ID `rollback:<projectId>:<releaseId>`. An allow
rule cannot silently restore an irreversible migration's backup; that still requires review.
Release/rollback reservations prevent duplicate concurrent work.

Live's Roll back controls POST the decision's `rollback` action to the inbox, as do other
clients. The release service registers the handler at startup. It synchronously reserves
and records a rollback of every app using the private project and current-release context;
execution follows after the answer transaction. Errors leave the decision waiting. Live
links to the project release review if a rollback needs additional backup consent.

### Unified inbox producer API

`createInboxItem(owner, item, context)` stores one `{ id, item, context }` record in
`v2-inbox-native`. IDs must be stable: repeating creation returns the existing item,
including its answered or withdrawn state. Only `item` reaches inbox reads or events.
Do not put source paths, runtime receipts or execution credentials in the public item.

`registerInboxAction(kind, handler)` registers a synchronous
`handler(owner, item, body, context)` and returns an unregister function. Unregistering an
older handler cannot remove a newer registration. Resolve asynchronous project lookups
before producing the decision. Handlers must persist/enqueue work within the answer
transaction and throw when admission fails; never launch unawaited network mutations.

A producer that shares a public kind with another (design reviews use `other`, which native
clients already decode) puts `source` in its context and registers
`registerInboxSource(source, handler)`; that handler wins over the kind's.

The advertised `keep`, `dismiss` and `not-now` actions need no handler. Every other native
action requires a registered handler; absence returns HTTP 501 without saving an answer.
Handlers must reject action IDs they do not support. Answers remain first-answer-wins:
accepted answers and durable work commit together, and all retries return 409 with the
original answer. `withdrawInboxItems(owner, projectId, kind)` withdraws waiting decisions
when replacement releases or rollbacks make them obsolete.
