# Slice 14 — CLI evidence

Captured on 2026-10-27 from branch `codex/v2-cli`. Each `Cli*.txt` transcript is paired by name with `Cli*-board.png`, copied without changes from `design/v2/canvas/png/*-1440.png`. These are terminal transcripts, as requested for this slice, rather than web screenshots. Commands run against an HTTP stub on an available port in 5180–5199, with temporary credentials and project files. No request went to the live coordinator.

Reproduce the transcripts from the repository root:

```sh
DEPLOY_CLI_EVIDENCE="$PWD/docs/evidence/v2/14-cli" node --test server/cli-v2.test.ts
```

The test owns and closes its stub server. Byte counts and packing duration vary by machine.

## Deliberate differences from the boards

- **CliHelp:** the same six groups and common flags are present. Added `remove [app]`, which CliRules specifies, and the explicit `inbox <id> <action> --yes` scripting syntax. `tasks` lists the existing API's tasks rather than claiming a today-only query. Advanced help retains the original commands and flags, including CI, recovery, graph, enrollment and service commands. `-a`, `--application`, and `--app` remain accepted, hidden from ordinary help. An explicit command's app argument defaults to the folder name when `deploy.yaml` exists; automatic project creation is part of the deferred first-deploy flow.
- **CliRules:** output is plain text, including in a TTY; this slice does not add terminal colors or animated spinners. Checks, dots, failure marks and the decision-only attention mark retain their meaning. Legacy data commands that do not already return structured objects emit newline-delimited JSON `{ "message": "…" }` records. Structured data is kept as data, not encoded inside those messages. Runtime logs and shell output are newline-delimited `{ "output": "…" }` records. `open --json` returns the address without launching a browser. Dedicated advanced acknowledgements such as `--confirm-data-loss` remain distinct from `--yes`.
- **CliStatus:** the fixture keeps home-gym, SER, bazzite and Warden, with three apps and one decision rather than seven apps and three decisions. The current endpoints do not supply the board's job failure rate, request rate, CPU/memory percentages or task count, so these are omitted. A process reported as running reads “Running · Health checks unavailable”; it is never invented as Healthy. Computer assignment uses `activeNodeId`, then compatibility fields. Roles use Coordinator and Run apps. A missing inbox reads unavailable and does not make status fail. A present waiting item makes status exit 3. The inbox uses the server's action IDs and labels, numbered interactive choices and Skip/Quit. It does not invent rollback progress after answering a decision. Script answers include `on: 'cli'` and require an explicit action, even with `--yes`.
- **CliDeploy:** this slice adapts today's per-app upload and durable build receipt. It does not implement the later project release engine. Prepare and activate reflect the completed build/startup result; separate verify and extended watch are explicitly skipped because this API does not report them. No fabricated migration, commit ID, two-app atomic switch, “Nothing changed”, or ten-minute Warden guarantee appears. Only relevant failure lines are printed; full build output is available through `logs --build`. The address follows today's routing (`https://home-gym.local`), rather than the board's proposed `home-gym.deploy.local`. The tiny fixture has one Dockerfile rather than 214 source files. The CLI waits up to 600 seconds for its exact build receipt; `--wait-timeout <seconds>` overrides that. A timeout reports still running and exits 1, never Live. JSON gives `name`, `state`, `steps`, `buildLogId` when supplied, and `url`.
- **CliErrors:** the captured examples cover the misspelling and missing-project errors. Network and authentication errors use the known coordinator address and next command, without inventing a last-contact timestamp or an assurance that no bytes were uploaded. Usage errors exit 2, failures exit 1, and JSON errors go to stderr as `{ error: { message, next }, exitCode }`. Rollback previews the release/app/migration changes and requires confirmation. Irreversible migrations direct the user to the app to review the data restore; the CLI does not guess at possible data loss.
- **CliLogin:** password login and registration remain available. Browser login, discovery, certificate pairing, account creation through the browser, and automatic first-project generation are deferred, as directed by this task.

The boards are unchanged because this slice does not own `design/v2`.

## Integration notes for following slices

- Inbox: `GET /api/v2/inbox?state=waiting` accepts an array or `{ items }`. Answers use `POST /api/v2/inbox/:id/answer` with `{ actionId, on: 'cli' }`. A 404 is unsupported (exit 2 for inbox); authentication and other failures are not mistaken for feature absence. First-answer-wins remains the server's responsibility.
- Project releases: `GET /api/v2/projects/:project/releases` accepts an array or `{ releases }`. Rollback selects the Live release and a prior superseded release, or the explicit `--release` target. It posts `{ from, to }` to `/api/v2/projects/:project/rollback` and renders returned typed steps. The project name currently supplies the project path parameter. The release slice must settle name-to-ID resolution and enforce current-release concurrency on the server. These routes are absent on the base coordinator and return an actionable unsupported error; there is no fallback that rolls back just one app. Legacy and catalog rollback commands remain available in advanced help.
- Task aliases use the existing workspace API. `--on` resolves a computer name or ID from its workers. Scout uses the existing default task runner; other agent choices return an actionable unsupported error until the agents slice provides a contract.
- The helper `bin/cli-v2.mjs` is bundled by the existing esbuild entry point. A test builds and executes the same CommonJS bootstrap transformation used for the standalone CLI, without downloading runtimes or building/installing binaries.

## Validation

- `pnpm install --frozen-lockfile`: passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed, warnings only.
- `pnpm format:check`: passed.
- `node --test server/cli-v2.test.ts server/cli-bundle.test.ts server/ci-cli.test.ts`: 30 passed, 0 failed.
- Evidence capture (`node --test server/cli-v2.test.ts`): 11 passed, 0 failed.
- `pnpm test`: **579 passed, 4 failed, 13 skipped; 596 tests across 91 suites**. The four failures are in unchanged files:
  - `server/ca-profile.test.ts:94`: system OpenSSL rejects `verify -verify_hostname`.
  - `server/ca-profile.test.ts:144`: expected certificate verification exception was not thrown.
  - `server/catalog-api.test.ts:107`: Home Assistant preflight readiness was false instead of true.
  - `server/legacy-preserving-update.test.ts:393`: test reads Linux `/proc/self/fd`, which is absent on macOS; it then observes the recovery-lock error instead of its synthetic activation error.

The full suite used a temporary `DEPLOY_DATA_DIR` and a temporary Node preload (`/tmp/v2-cli-test-ports.mjs`) to allocate ephemeral test listeners only within 5180–5199 and reject out-of-range binds. No test failed because of a rejected port. Real-Docker tests remained skipped. The preload is an execution constraint, not a repository change. Test servers were closed by their fixtures; no live services or containers were stopped, restarted or reconfigured.
