# Slice 4 part 2: project release execution

No live services, workers, containers, installed apps, or other worktrees were changed. This slice adds the runtime implementation and tests, but **does not complete end-to-end remote worker or rollback CLI integration**: both require small edits to `bin/deploy.js`, which is outside the supplied edit boundary. Scope expansion was requested and not received. The exact unapplied integration is in `worker-cli.patch`.

## Work by requested item

1. **Remote computers:** added durable `project-release` agent jobs and a node implementation for prepare, verify, quiesce, activate, migrate, watch, abort, recovery, backup, restore, and reverse. Source artifacts are validated and unpacked; images are pinned; Verify uses copied volumes and an isolated network. Every app verifies before the coordinator permits activation. Route publication is one coordinator transaction after every computer acknowledges its switch. Rollback uses the same barrier. Two in-process fake computers run the actual worker adapter and exercise successful release/rollback, a failed second switch, partial-switch recovery, and cold backup restoration. The installed worker's job dispatch is still missing the branch in the unapplied patch; remote deployment must not be represented as operational until that is integrated.
2. **Crash recovery:** startup scans durable project reservations. Encrypted runtime journals retain prior processes, activation state, and migration receipts; a coordinator SQL publication marker distinguishes published activation from a partial switch. Recovery finishes published activation/watch or aborts the partial switch and restores prior processes. Steps record the recovery outcome. SIGKILL tests cover release prepare, partial activation, published activation, Watch, and rollback partial/published activation and Watch. A crash during an arbitrary non-idempotent migration or restore remains deliberately fenced: its outcome cannot safely be inferred. The whole project stays stopped and locked when that outcome is uncertain; automated recovery for that case and an operator recovery API remain unfinished.
3. **Mutation fencing:** project reservations reject legacy deploy/restart/scale/config mutations with HTTP 409. Durable mutation leases also prevent a release from overtaking an already-admitted app change. API admission and store mutation paths share the guard; the release operation carries its own reservation context. Tests cover all four mutation classes, admission in both directions, and release-owned operations.
4. **Reversible migrations:** optional `release-migrations.json` alongside the app source declares reverse commands by lifecycle job name. Metadata is validated and frozen with source receipts. Rollback follows actual activation ancestry in reverse order; it uses the original migration's image/environment/volume receipt. Jobs without a reverse remain irreversible and require the existing exact-backup confirmation. Remote nodes preserve cold backups and execute reverse jobs from their original receipts. Migration success is only recorded after execution, not at route publication. Rollback Verify still checks the target graph on a copied current/backup dataset; it does not simulate the complete chain of reverse commands on that copy. That additional preflight remains open.
5. **Release plan and Ship dialog:** `POST /api/v2/projects/:p/releases/plan` supplies online computers with Run apps, per-app address, app visibility, and data defaults. `POST .../releases` accepts validated choices. ShipDialog fetches and edits those choices and sends the selected source ref. Activation stores visibility through the existing app `discoverable` field for Apps at home. Existing live data cannot be discarded through New data, and an existing app cannot move computers through this release API; both return clear 409s rather than imply data transfer/reset support.
6. **CLI:** receipt helpers follow the upload-to-release mapping and real Prepare/Verify/Activate/Watch steps, preserve timeout state, and unwrap/poll an exact rollback receipt. Tests cover these helpers and output. The ordinary accepted-upload path already invokes `followDeploy`. The direct-release result and `deploy rollback` call sites need `worker-cli.patch`; rollback is not fully wired in this branch.
7. **Validation:** see the results below and checked-in logs. Real Docker integration tests remain opt-in; fake transports do not establish real bazzite compatibility.

## Migration metadata

```json
{
  "reverse": {
    "migrate": ["migrate", "down"]
  }
}
```

Here `migrate` must be an existing lifecycle job with a nonempty command. This is an additive metadata file, not a change to the settled deploy.yaml schema. The new database migration is `0038_project_release_activation.sql`; its publication marker participates in the same transaction as route publication.

## ShipDialog parity and deliberate differences

The ShipDialog board sources and 1440/700 renders were inspected. The dialog retains the shared v2 Dialog, Group, Setting, Seg, Steps, and Action primitives and the existing 560px width. `design/v2` was not edited.

- Runs on and Data now use shared styled native selects, and Address uses the shared field styling, to make the previously static choices editable.
- The board's unverified memory amount, certificate issuer, Postgres provisioning, and nightly backup promises are replaced with Run apps, A local address, and Verify on a copy before switching. The API does not supply those promises.
- The board's fixed source/commit count becomes the actual source ref; the dialog does not invent three commits. Watch is described as watching the release, without claiming a separate Warden runtime performs it.
- Multiple apps receive separate setting groups. Loading, no eligible computer, missing source ref, pending, and request-error states are explicit.
- The existing task fixture supplies the background conversation and shell. Their pre-existing differences from the board are outside this dialog change.
- Chromium was denied by the sandbox. No visual parity pass or interaction verification is claimed. See `captures.md` and `capture.log` for the exact capture failure and reproduction commands.

## Validation results

- `pnpm install --frozen-lockfile`: passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: passed. Lint warnings remain, with no errors.
- `pnpm build`: passed.
- Targeted release tests: **38 passed, 0 failed** (`targeted-tests.log`).
- Store and agent graph protocol tests: **51 passed, 0 failed** (`protocol-tests.log`).
- CLI receipt, CLI, bundling, and CI CLI tests: **34 passed, 0 failed** (`cli-tests.log`).
- Full `pnpm test`: **761 tests; 744 passed, 4 failed, 13 skipped, 0 cancelled** across 92 suites. Exit status is 1 because of the four known environmental failures; see `full-suite.log`. They are the two unchanged LibreSSL certificate assertions in `server/ca-profile.test.ts`, Home Assistant readiness in `server/catalog-api.test.ts`, and the Linux `/proc/self/fd` assertion in `server/legacy-preserving-update.test.ts`. No new failures remain.

The full suite runs with a temporary data directory, Docker disabled, serial test files, and a temporary Node preload restricting listeners to assigned ports 5188 and 5189. Port 5189's IPv4 address was already occupied by another worktree; the harness uses IPv6 loopback for that port and HTTPS, preserving certificate verification against the original hostname. Multicast advertising is suppressed. Initial harness runs had port collisions and TLS routing errors; those were corrected and are not application regressions. The final harness is included as `test-harness.mjs` for reproducibility. It is test-only and is not imported by application code.

Reproduce the full run with the assigned ports available (the harness adds serial execution and Node's test-process exit flag):

```sh
DEPLOY_DATA_DIR=$(mktemp -d /tmp/v2-releases-suite.XXXXXX) DOCKER_HOST=unix:///tmp/v2-release-no-docker.sock NODE_OPTIONS="--import=$PWD/docs/evidence/v2/4-releases-2/test-harness.mjs" pnpm test
```

The recorded run additionally put a temporary `docker` executable returning status 1 first on PATH, so neither the CLI nor Docker API could contact a live daemon. Opt-in real-Docker variables were unset. All fixture/test servers started here have been stopped; the other worktree's listener was left untouched.

Execution deviation: an additional CLI-only regression command was inadvertently invoked once without the preload. Those existing tests select ports from 5180–5199, so that invocation did not enforce this slice's narrower assignment. It completed before interruption. The checked-in CLI log is from its subsequent serial rerun with the 5188/5189 restriction; no persistent listener from the earlier invocation remains.

## Next integration steps

Review and apply `worker-cli.patch` with the owner of `bin/deploy.js`, then test the installed worker packaging and CLI entry points in an isolated environment. No worker upgrade or live deployment was performed. Keep server/api.ts changes narrow when merging with its owner's work. Run the ShipDialog capture instructions and review both pairs. Resolve uncertain data-command recovery and reversal-on-copy preflight before claiming that every crash can recover automatically. Existing slice-4 limits around host-bound graphs, authoring multiple repository app links, retained source/image cleanup, and adoption paths remain unless explicitly addressed above.

## Integration and visual review (added by the orchestrating session)

- Applied `worker-cli.patch` (`bin/deploy.js`): remote nodes dispatch `project-release` jobs through `server/v2/releases-worker.ts`, and `deploy rollback` follows the v2 rollback receipt. The CLI runs. Typecheck passes, and the CLI and release tests pass 69/69.
- ShipDialog was captured with the fixture on 5188 and paired at 1440 and 700 against the board (board left). The choices are now editable: a computer select, the address, the Just me / Everyone at home segment, and the data select. Layout and wording match.
- The dev server logged an SSR parse failure for `app/routes/dashboard/v2/start/account.client.tsx` (from the sign-in slice). The page fell back to client rendering. Check it on the integrated branch.
