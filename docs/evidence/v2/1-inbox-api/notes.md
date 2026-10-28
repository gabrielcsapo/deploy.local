# Slice 0 contracts / slice 1 inbox API evidence

Implemented on `codex/v2-inbox-api`, based on `1f1981f`.

## Scope and parity

- All requested TypeScript contracts are exported from `shared/v2/contracts.ts`. The only
  additions to the brief's definitions are the missing string aliases `AgentId` and `UserId`
  and export keywords; formatting follows the repository formatter.
- Public Swift Codable types match every contract, including flat conversation discriminators,
  numeric markup colors, and two-coordinate arrays. `shared/v2/api.ts` adds typed HTTP envelopes.
- Inbox reads combine questions and screen-control requests. Answers use the existing answer
  and operator functions, with one immediate transaction for the first answer and provenance.
- Long-poll events include inbox snapshots and mapped conversation events, up to a 10-second wait.
- `server/api.ts` has exactly one new import and one dispatch line. No existing workspace
  behavior or design source was edited.
- This task builds no screens. Consequently there are no implementation screenshots or
  side-by-side images. `Inbox-1440.png`, `Inbox-700.png`, `AnsweredPhone-390.png`, their markup,
  and the design rules were inspected for vocabulary and answered-state behavior.

Deliberate limitations/differences:

- Only questions and control decisions have producers in this task. Merge, rollback, install,
  project release/health feeds, SSE, and web/iPhone/CLI rendering belong to other slices.
- Legacy answers lack client provenance. Their optional `InboxItem.answer` is absent and a
  conflicting answer returns `answer: null`; original legacy answers remain untouched. New
  v2 answers always record authenticated `by`, client-supplied `on`, and server-supplied `at`.
- Existing questions have one prompt and no separate rationale; it fills title and text.
  Clients can avoid displaying the same string twice. Control text names the requested target.
- Legacy adapter IDs stand in for Agent IDs until the Agents slice supplies `run.agentId`.
- No background projection worker is added: inbox reads and long-polls reconcile persisted
  snapshots, including legacy updates and expiry. Events predating the first v2 read retain
  their decision cards, but the inbox snapshot reflects the current state.
- Work items lacking a completed event remain live. Unmapped types and their reasons are
  enumerated in `server/v2/README.md`; original workspace event history is retained.

## Example requests and responses

[examples.json](examples.json) contains actual HTTP responses from an isolated temporary
fixture with Scout, home-gym, and owner `gabriel`. Its auth callback supplies the fixture owner;
real cookie/header authentication is separately exercised by the tests. No request was sent
to the live coordinator. For a real client, send the existing session cookie or username/token
headers; these are omitted from the examples.

```http
GET /api/v2/inbox?state=waiting
```

```json
{
  "items": [
    {
      "id": "question:choose-color",
      "kind": "question",
      "title": "Which color?",
      "text": "Which color?",
      "from": "scout",
      "projectId": "home-gym",
      "taskId": "task-home-gym",
      "createdAt": "2026-10-28T00:51:38.934Z",
      "actions": [
        { "id": "option:0", "label": "Blue", "primary": true },
        { "id": "option:1", "label": "Green" },
        { "id": "answer", "label": "Answer" },
        { "id": "dismiss", "label": "Dismiss" }
      ],
      "state": "waiting"
    }
  ]
}
```

```http
POST /api/v2/inbox/question%3Achoose-color/answer
Content-Type: application/json

{"actionId":"option:0","on":"iphone"}
```

Returns 200 with `{ item }`, state `answered` and answer
`{ actionId: "option:0", by: "gabriel", on: "iphone", at: <server timestamp> }`.
Submitting `{"actionId":"option:1","on":"cli"}` afterward returns 409 with that exact
stored answer and the answered item. `GET /inbox?state=answered` returns the same item.
Free-text replies use `{"actionId":"answer","on":"web","note":"Purple"}`.

```http
GET /api/v2/events?after=0&waitMs=10000
```

Returns `{ events, cursor, supportsWait: true }`. The captured example contains a conversation
`decision`, a waiting inbox snapshot, then the answered inbox snapshot. Reconnect with the
response cursor and upsert by conversation event ID or inbox item ID.

## Validation results

- `pnpm install --frozen-lockfile`: passed. The tracked pnpm cache database was restored after
  installation; no dependency or lockfile changes are included.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with existing warnings; `pnpm exec oxlint server/v2 shared/v2` has no warnings.
- `pnpm format:check`: passed.
- `node --test server/v2/api.test.ts server/v2/contracts.test.ts`: **15 passed, 0 failed**.
  [Full focused output](focused-tests.log) includes independent-process answer races, existing
  auth helpers, owner isolation, failed control approval, replay, expiry, aborts, and wait cap.
- Node type-only import, Vite library build, and the esbuild configuration used by the CLI:
  passed in the contracts tests. Full cross-platform SEA binaries were not produced; no CLI
  source was changed and the check exercises shared module resolution in its bundler.
- `swift build --scratch-path /private/tmp/deploy-v2-swift-build --cache-path /private/tmp/deploy-v2-swift-cache --disable-sandbox`
  from `native/Apple/Packages/DeployKit`: passed, including DeployCore and DeployUI. Initial build
  had an existing Keychain deprecation warning; SwiftPM also reports inaccessible user caches.
  [Final incremental build output](swift-build.log). Codable round-trip tests cover every
  requested contract and all eight ConversationEvent variants.
- `pnpm test`: **600 tests, 572 passed, 4 failed, 11 cancelled, 13 skipped**, exit 1.
  [Full output](full-suite.log). The failures are outside this change:
  - `ca-profile.test.ts`: two failures (system OpenSSL lacks the requested hostname-verification
    option; the existing correction test expects an exception that is not thrown).
  - `catalog-api.test.ts`: Home Assistant readiness is false with Docker unavailable.
  - `legacy-preserving-update.test.ts`: its fsync test reads Linux `/proc/self/fd` on macOS.
  - `application-api.test.ts`: startup/HTTP socket failure cancels its eleven tests.
- Re-ran those four files from a disposable `git archive 1f1981f` with the same isolation:
  **20 passed, 4 failed, 11 cancelled**. The same failing tests reproduce; the application API
  suite instead reports port contention and its blocked 8443 fallback. This is an environmental
  cancellation, not a verified product regression. [Baseline output](baseline-tests.log)
  collapses consecutive identical startup messages and records their repetition count.

Whole-suite isolation used a temporary `DEPLOY_DATA_DIR`, an unavailable `DOCKER_HOST`, a
fixture-only `docker` executable that exits 1, and disabled Docker integration opt-ins.
[Test guard](test-guard.mjs) was preloaded through `NODE_OPTIONS`; it allocates ephemeral test
listeners only in 5180–5199, avoids occupied ports, blocks other TCP/UDP listening ports, and
bounds each test file at 90 seconds. The guard changes existing test infrastructure behavior,
so the full suite is **not green**. No watchdog timeout fired in the final run. The first run
used an insufficient port allocator and was interrupted after stalled test cleanup: 545 passed,
18 failed, 25 cancelled, 13 skipped. The corrected second run above completed normally.
All servers started for this task were stopped. Other worktrees' listeners were left alone.

## Next slice

Use the response envelopes and action IDs in `shared/v2/api.ts` and `server/v2/README.md`.
All new clients must answer through v2 to retain provenance; repeated answers intentionally
return 409, even if identical. Continue long-polling with the response cursor, including after
empty pages; upsert events with stable IDs. No schema migration or daemon is required.
