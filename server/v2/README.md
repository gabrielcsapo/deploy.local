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

- `GET /api/v2/inbox?state=waiting|answered` returns `{ items: InboxItem[] }`.
  The default is `waiting`; items are sorted newest first, then by ID.
- `POST /api/v2/inbox/:id/answer` takes `{ actionId, on, note? }` and returns `{ item }`.
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

`GET /api/v2/events?after=0&waitMs=10000` returns
`{ events: V2Event[], cursor: number, supportsWait: true }`. Both query values must be
non-negative safe integers; the wait is capped at 10 seconds. A disconnect cancels its timer.
The envelope contains `cursor`, `taskId`, `runId`, `at`, and either:

```ts
{ type: 'inbox', item: InboxItem }
{ type: 'conversation', event: ConversationEvent }
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

Merge, rollback, install decisions, project releases, app health, SSE, and rendered clients
are later slices. The public unions already include their agreed shapes. A work item without
a completed event remains live; run-level folding/failure presentation is not inferred here.

## Validation

`node --test server/v2/contracts.test.ts server/v2/api.test.ts` covers contract builds and Swift
JSON parity; actual API auth helpers without starting background services; owner isolation;
legacy and v2 answers; separate-process answer races; control validation; invalid bodies;
long-poll replay, expiry, independent processes, cancellation, and the ten-second cap.
All database fixtures use temporary directories; HTTP fixtures bind only ports 5180–5199.
