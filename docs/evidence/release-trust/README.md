# Release trust verification

All work was local. No production connection, push, merge or UI change was made.

## 1. Release-blocking tests

Loaded repeats use Node 26 on Linux ARM64 in an isolated Debian container. Four test
files run concurrently alongside four continuous PBKDF2 CPU processes; each complete
file runs 20 times. Before and after use separate source copies. Logs are local in
`output/release-trust/`. The initial Debian SQLite prebuild could not load against
its older glibc; it was rebuilt locally before collecting the baseline below.
Mac worker runs were stopped because the sandbox denies `ps`; these are not counted.

| Complete test file                        | Before | After | Finding                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/workspace/workspace.test.ts`      | 20/20  | 20/20 | Partial output lasted only 350 ms. The fake agent now waits for an acknowledgment after the test sees the durable partial message. Separate-process state waits have a 60-second ceiling, capture output and fail immediately on worker exit. Cleanup handles an already-exited worker. |
| `server/api.test.ts`                      | 20/20  | 20/20 | Port reservation was released before boot; HTTPS startup was treated as HTTP readiness; cleanup deleted data before exit. Use port 0, HTTP listening IPC, explicit loopback mDNS and awaited exit.                                                                                      |
| `app/routes/docs/docs.test.mjs`           | 20/20  | 20/20 | Deterministic help comparison; already fixed by `4ae31bc1`. Unchanged.                                                                                                                                                                                                                  |
| `server/workspace/agent-packages.test.ts` | 20/20  | 20/20 | Inherited registry config was already isolated by `c086eb71`. Completion follows install cleanup. No additional race found; unchanged.                                                                                                                                                  |
| `server/workspace/worker-process.test.ts` | 20/20  | 20/20 | Linux tests really ran. Exit-time process inspection was already fixed by `9c313075`; no additional race found. Unchanged.                                                                                                                                                              |
| `server/v2/design-chat-native.test.ts`    | 20/20  | 20/20 | Deterministic source assertion; previous failure and fix are recorded in `docs/evidence/design-chat-build/README.md`. Unchanged.                                                                                                                                                        |
| `server/v2/design-chat-fixture.test.ts`   | 20/20  | 20/20 | Pure fixture assertion; previous failure and fix are recorded in the same evidence. Unchanged.                                                                                                                                                                                          |

A separate scheduler-delay experiment waits for the agent's context marker, delays
observation by one second, then uses the original test assertions: original fails
with `worker timeout`, revised fixture passes. This reproduces the lost partial
message without modifying production code. A second experiment delays HTTP binding
by one second: the original upload suite fails with ECONNREFUSED; the revised suite passes both tests.

Required checks after item 1: typecheck, lint and format check passed.

Git cannot create the worktree metadata index.lock (Operation not permitted), so item commits could not be created. Individual patches are retained in output/release-trust.

## 2. Every-push checks

`deploy.yaml` runs typecheck, lint/format, tests and build on main pushes and PRs.
The router command and its two globs remain, now at job scope: the previous global
filter would suppress all unrelated checks. All jobs use Linux Node containers
because automatic PRs reject host commands. `scripts/ci-setup.sh` supplies pnpm and
the systemd parser and rsync used by the release/backup tests. `scripts/ci-test.sh` runs tests as an ordinary user in a disposable copy, preserving mounted checkout ownership. Node's trixie image supplies modern
glibc for the SQLite ARM64 prebuild, plus Git and compilation tools.

The compiler/schema and scheduler now support job paths using the same push range,
new-ref tree and PR merge-base calculation as pipeline paths. A filtered job is
neutral; a failed executed job fails the run. Publication only advances after the
whole run succeeds. PR publication is check-only. No `pipeline.deploy` is declared;
self-update/prepare/activate remains separate, so these jobs neither activate nor
reserve/block a production coordinator release by themselves. PR merge policy can
still require successful checks.

Removed the unused GitHub workflow, root release script and package script entry.
Reference search found only design examples/historical plans and a separate router
package changelog script with the same basename; those remain unchanged.

Verification: 32 Linux tests passed across pipeline compiler, real Git path triggers,
job reconciliation and package publication (including failed-job publication fencing).
Typecheck passed. Actual scheduled pushes/PRs were not submitted. The first complete container run exposed the missing rsync dependency and root-only execution; both were corrected in the CI setup.

## 3. Activation readiness

`server/readiness.ts` checks all journal timestamps and SQL hashes against the applied
migration records, both small databases' quick_check results (cached 60 seconds),
the two service worker heartbeats (<30 seconds), and the control process's captured
release/environment identity. `server/api.ts` exposes only ok/version/static check
reasons at unauthenticated GET /api/health/ready, with no-store and 200/503. It does
not inspect requests.db.

Activation checks the selected systemd process/directory and readiness JSON for the
expected release revision, then repeats after 60 seconds. Either failure enters
existing rollback; rollback uses the old root HTTPS check without a minute wait.
Known older activation targets also use that legacy probe. New prepare records the
readiness protocol, while presence of the verified source module detects a new
release prepared by an old updater. The updater already executing from the replaced
release does not gain the new activation logic until its next release.

Tests boot a real control server with an isolated database and loopback mDNS, then
exercise anonymous success, missing/stale workers, missing migrations and identity
changes. Worker rows are manipulated directly; this is not a four-process deployment.
Real SQLite constraint corruption verifies both quick_check failures and the cache
boundary without waiting a minute. Updater tests exercise JSON/version rejection,
the 60-second second probe, rollback and both old/new protocol orders. Their clock
and systemctl/curl adapters are controlled; no production activation was attempted.

## Additional isolation failure found by the full Linux suite

`server/workspace/coordination.test.ts` assumed no online Linux ARM64 worker existed,
but earlier tests left both a local heartbeat and a remote worker in the same data
directory. Whether they expired before the placement assertion depended on suite
speed; on this Linux ARM64 machine the original file failed 20/20 loaded repeats.
The placement test now temporarily marks only the prior fixtures offline and restores
them afterward. It keeps its real registration, scheduling and claim assertions.
The corrected file passed 20/20 loaded repeats. No runtime code changed for this placement fix.

The full suite also exposed SQLITE_BUSY during WAL promotion in `server/store/connection.ts`, before the migration lock was acquired. WAL setup and auto-vacuum initialization now run inside that lock. The unmodified migration file passed 20/20 ordinary loaded repeats, but an IPC barrier synchronizing all five opens made the old implementation pass only 18/20; with the fix the strengthened `server/store/migration-lock.test.ts` passed 20/20. The full-suite failure stack pointed directly to journal_mode, independently confirming the race.

## 4. Supervised process measurements

`server/process-metrics.ts` samples a real monitorEventLoopDelay histogram (p50, p99,
max in milliseconds), RSS, heap used/total and sample window. The existing heartbeat
sends one sample per minute, resetting the histogram; standalone processes create no
sampler. Disconnect disables the monitor and timer. `server/supervisor.ts` retains
the latest sample in each child's additive metrics status field, resets it on restart,
and logs one compact line per sample above p99 >200 ms or max >1000 ms. Duplicate
samples and malformed optional metrics cannot interfere with heartbeat liveness.
No supervisor database writes, page request logging or dashboard changes were added.

Six focused tests passed: real event-loop stall/reset/memory, threshold validation,
actual heartbeat IPC/disconnect, status-socket samples, duplicate-log handling and
watchdog compatibility. The copied-supervisor fixture includes the new import.
The minute cadence is shortened in the IPC test; no production observation is claimed.

## Final verification and limits

- Linux `pnpm run build`: passed using `node:26-trixie` and the CI bootstrap.
- Linux full `pnpm test`, through the ordinary-user CI wrapper: passed. Router: 282 tests in 34 files; worker pool: 9 tests; web: 195 tests; server/scripts/CLI/desktop/shared: 1,752 passed, 25 existing conditional skips, no failures or cancellations. Swift was not run on Linux. Docker-daemon, unavailable optional tool and browser cases use their existing conditional skips; no test was newly skipped or removed.
- The first full run exposed root-account and missing-rsync setup errors plus the placement fixture; the next exposed the WAL initialization race. The final full run passed after those fixes.
- Required host `pnpm run typecheck`, `pnpm run lint` and `pnpm run format:check`: passed. `git diff --check` also passed. Lint retains pre-existing warnings.
- No live push/PR pipeline, production updater activation, real LAN request, Mac/iPhone build or production minute-long observation was performed. No production server was contacted; no push, merge or other worktree was touched.
- Git staging/commits are blocked: Git cannot create `/Users/gabrielcsapo/Documents/coding/deploy.local/.git/worktrees/deploy.local2/index.lock` (`Operation not permitted`). Four per-item patches and all run logs are retained in `output/release-trust/`; changes remain in this worktree.
