# Cleanup: easier to maintain, safer to update, faster to use

Status: approved by the owner on 2026-11-06. In progress.

Starts when Packages is verified, meaning a SER release installs through the registry with no fallback. That isn't true yet: the 3a47324f release failed on `@pnpm/exe` and retried without the registry. Waiting also keeps this work from colliding with the Packages changes.

Measured on 2026-11-05 against main and SER at 3a47324f. "Audit" marks something read from the code but not yet measured or independently rechecked.

## What we found

| Area             | Today                                                                                                                       | Why it matters                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Web code         | 165 of 387 source files, 31,295 of 67,504 lines, can't be reached from any route                                            | Every search, typecheck and agent reads old screens that never run               |
| Stylesheets      | Every page loads the same 44 stylesheets: 745 KB, 135 KB compressed                                                         | Slower first load; audit finds 888 of 1,608 classes unused by live screens       |
| Live data        | 4 separate event loops on the web and a fifth on desktop, plus at least 8 timers (audit)                                    | Each loop is a server connection polling SQLite every 50 ms                      |
| Server idle load | 24% of a core with 27 connections; stalls over 200 ms 3–5 times a minute, worst 318 ms                                      | Rechecked only at bbd13760                                                       |
| Projects list    | 350–540 ms for 19 projects, the slowest common read                                                                         | Reads every repository and runs a write on each GET (`server/v2/projects.ts:34`) |
| Database         | `request_logs` and its indexes take 2.3 GB of `deploy.db`'s 2.6 GB                                                          | One index (265 MB) duplicates another; every backup carries all of it            |
| Disk             | Backups take 46 GB of SER's 68 GB; 12 older `deploy-*.db` copies plus their workspace copies, about 35 GB, are never pruned | Only `self-update-*` backups are pruned                                          |
| Server structure | `server/api.ts` is one handler of about 5,400 lines and 100 routes; `store.ts` has 119 exports                              | Any change means reading a huge file; there is also one 13-file import cycle     |
| Copied helpers   | `send` in 11+ files, `readBody`/`readJson` in 3–4, local `git()` in 7+ (audit)                                              | A fix lands in one copy and not the others                                       |
| Client contracts | Swift models are written by hand; their one test skips itself without `swiftc`; the CLI is untyped                          | A changed field breaks those clients at runtime, not at build time               |

Releases aren't a problem. The median is 2.8 minutes, of which prepare takes about 2.5 and the backup 7 seconds, so backup size costs disk rather than release time.

## Order of work

Deleting comes first because it makes everything after it smaller. Each step is one releasable change, and nothing below changes what people see. If a step turns out to need a visible change, it stops and goes through the design process in `AGENTS.md`.

### 1. Keep the measurements

Commit the timing scripts used for this plan to `scripts/perf/`, so each later step can compare before and after. Size: small.

### 2. Remove what can't run

- Delete the 165 unreachable web files and the tests that only cover them. Move anything still useful first. Size: large but mechanical.
- Delete the styles left unused, including the `@xyflow` import used only by dead code. Compare live screens with `audit:visual` at 1440, 700 and 390 px before and after. Size: medium.
- Prune server routes and actions used only by those screens, and the HTTP routes the audit found no caller for. Size: small to medium.
- Keep the redirects from old URLs, since bookmarks may still use them.

### 3. Quick performance wins

- Projects list: seed links once instead of on every read. Confirm first that the repository reads are the cost. Size: small.
- Drop the redundant `idx_request_logs_deployment` index, saving 265 MB. Size: small.
- New clients start at the latest event rather than replaying history, which is 431 KB today. Size: small.
- Load the shell's account, QR code and passkey code on demand (audit). Size: small.

### 4. One live feed

- Web: one shared subscription per tab replaces the separate loops and refreshes data by event type. All requests use the same session-expired handling, which three files skip today.
- Server: one poller per owner wakes all waiting clients, replacing a 50 ms poll per connection.
- Size: medium. Risk: medium, because reconnects and timing change. Test by dropping the connection, sleeping a laptop, and releasing with clients attached.

### 5. Load only each page's styles

`react-flight-router` now lives in this repository, so we can fix this at the source: a page should link the styles it uses, not all 44. Size: medium. Risk: medium, because cascade order can shift. Compare screens as in step 2.

### 6. Request logs get their own home

Move request logs to their own database file, leaving `deploy.db` at about 0.3 GB, so backups shrink by about 90%. Use the existing `request_logs_1m` rollups for older history. Size: medium to large.

### 7. Server structure

- Break the import cycle by moving `fail` out of `server/v2/inbox.ts`. Size: tiny.
- One `send`, `readBody` and async `git` helper, replacing the copies. Size: small to medium.
- Split `server/api.ts` section by section into `xRoutes(ctx)` functions, as `server/v2/api.ts` already does, keeping dispatch order and starting with the smallest sections. `server/api.test.ts` is the safety net. Size: medium.
- Split `server/store.ts` by table, keeping a re-export so imports don't move. Size: medium.
- Find synchronous git and process calls on request paths and make them async. This is the likely source of the remaining stalls, but it isn't confirmed. Size: medium.

### 8. Safer updates across clients

- The Swift round-trip test must fail rather than skip wherever a client is built, and it should cover `Models.swift` too.
- Generate test fixtures from the TypeScript contracts.
- Type the CLI's requests from `shared/v2/contracts.ts`.
- Size: medium.

### 9. Native and desktop

The Mac app is the Electron app in `desktop/`, as on Windows and Linux. Retire the Swift Mac target and delete the old UI only it uses, including `WorkspaceView.swift`'s `DeployWorkspaceView`. The iPhone app stays Swift. Desktop reuses the web's tokens and event code instead of copying them. Size: small to medium.

## Not doing

- No rewrites and no framework or language changes.
- No merging of the event or job systems until someone shows they're accidental duplicates. The audit couldn't establish that.
- Replacing `better-sqlite3` with `node:sqlite` would remove a native build step, but it's a separate decision and needs its own measurements.

## How each step ships

Codex implements on its own branch. Claude verifies, measures against step 1 and commits. SER releases only on the owner's go-ahead, as today.

## Decisions

The owner confirmed the Mac app is the Electron app. The rest were left open, so this plan takes the choice that loses nothing:

1. **Wander and Groffee migrations:** kept. Both apps still exist on SER.
2. **Request logs:** raw logs stay at the 90-day setting (84 days exist today). Step 6 moves them without shortening that.
3. **Old backups:** nothing is deleted without the owner's word.
4. **`/api/discover` and `embed/computers`:** removed if a final search finds no caller.
