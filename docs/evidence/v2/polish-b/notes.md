# Polish pass B

## Implemented

- **Project:** running/waiting summary, a linked PR ready to merge, latest release age,
  and the single app's Live health/placement. Work rows use running/ready glyphs,
  elapsed time, computer names and actual patch additions/deletions. Data comes
  from the existing overview, workspace, task, diff, inbox and Live endpoints;
  unavailable diffs never appear as zero changes. All dates use `data/time.ts`.
- **ProjectSettings:** variable/secret icons, relative secret ages and an Ask me
  chip linking to Approvals. Added the release retention input, Verify switch,
  Remove section and removal explanation dialog. **Retention editing, disabling
  Verify and removal remain unavailable**, as detailed below.
- **Logs:** inline search/app/level controls, highlighted error/fatal lines, and no
  redundant app prefix when one app is selected or the project has only one app.
- **Approvals:** the matrix/editor no longer offers ship. The public `/approvals`
  API rejects ship in Ask, Allow and Never modes atomically, hides legacy ship
  rules on reads, and new agents receive no ship rule. Start a release is Always
  yours. Added Start a task and Open a pull request with descriptive subtext.
  Suggested from your answers derives from at least four answered rollbacks in
  the last 30 days, all approved, scoped to the owner and agent. No suggestion
  appears for an existing global Allow/Never rule. Review rule opens the existing
  editor; it does not immediately grant permission.
- **Agents:** removed the local event switch; all event kinds render through
  `conversation/ConversationItem`. Decisions retain shared inbox behavior and
  gain the agent glyph/relative time. Tracking has Running, Watching and Shipped
  this week, derived from explicitly attributed runs/tasks/issues/merged PRs.
  New agent has its glyph/name header and Rename, When it works, and Covers.
  Morning time, enablement, disk/mention triggers and app/computer coverage are
  validated, saved on the generic agent record and retained when tuning.
- **Brief:** ship is removed from the approval actions with the person-only reason;
  the two new task actions are listed. Existing shared contracts stay unchanged;
  additive AgentApprovalAction/Rule and AgentConfiguration types carry new fields.

## Unfinished within the assigned boundary

The task permits project server **read paths only**. No existing API implements
project retention preferences, turning off verification, or removing a whole
project while retaining backups for 30 days. Those mutations would require
coordinating the release/runtime and backup owners. A scope clarification was
sent while independent work continued; no expansion was assumed. The UI exposes
unavailable controls and explains why, instead of saving a local preference or
claiming an unperformed removal. Verify remains always on. The Remove button
opens a dialog naming the apps and released addresses; its final action stays
disabled and explains the required 30-day backup behavior. This does **not** meet
the requested fully functional controls/removal flow.

## Parity and deliberate differences

All ten assigned boards were inspected at 1440 and 700, along with their markup
and the design-system CSS. `design/v2` is untouched. Chromium failed at launch;
see `capture-attempt.log`. No captures or pairs exist, so visual parity, keyboard
focus and browser interactions are **not verified**. `captures.md` lists the exact
commands, fixture URLs, widths, heights and pairing commands for all ten boards.

- **Project:** actual counts replace the board's illustrative 3/2/14. Work says
  Running when no finer phase is available. Diff counts come from the current
  task diff; they are omitted until available. App health/placement uses Live.
  Shared time formatting uses “hr/min” rather than the board's “h/m”. A one-app
  project's Apps tab remains suppressed under the existing noun rule.
- **ProjectSettings:** unsupported mutations are visibly unavailable, as above.
  No claim that backups already have a 30-day guarantee is made. No invented
  repository authorship or “written in PR #1”. Secret masks never contain values.
- **Logs:** filters remain scoped to project apps; the board's cross-project
  service aggregation and Last hour are not supplied by the existing log tail API.
  Error highlighting covers the whole line. Reconnect remains available on error.
- **SettingsAgents / SettingsAgentsNew:** ship is intentionally removed even though
  the boards still show it. The existing install, secrets, screen and spend actions
  remain supported by the contract. Defaults stay Ask, rather than copying the
  board's sample privileges. Scoped rules remain visible. There is no fabricated
  new-agent age or notification promise. Suggestions report actual count/window;
  the board's “within 20 minutes” claim is omitted. Keep asking and Not now dismiss
  the suggestion for the mounted page without changing a rule.
- **RuleEdit:** keeps actual project scope and free-text limit fields. The board's
  unimplemented When, app exclusions, Tell me and usage counters are not simulated.
  A suggestion opens Review rule because conditional health-check-only grants
  cannot be expressed by the current rule contract.
- **Main / LongChat / KeeperPage:** shared work logs fold by default; decisions
  remain visible through filtering and older days with waiting decisions stay
  expanded. Date groups use the shared formatter. Tracking uses real attributed
  records; Keeper's disk-growth projections and next scheduled run are unavailable.
  Existing Composer wording and model handling remain; no model name is invented.
- **NewAgentDraft:** schedule and triggers persist but do not install a scheduler.
  The UI explicitly says automatic checks are inactive and directs users to the
  agent conversation today. Coverage uses editable IDs/names, with empty meaning
  all, rather than fabricated computer/app choices. This is configuration storage,
  not new agent execution or authorization enforcement.

## Integration notes

`agentsApi` already runs before `releasesApi`; it now owns public `/approvals`
GET/PUT without edits to the release agent's files. The old internal release
validator still accepts legacy actions and remains outside this branch. The
release gate already refuses unattended ship. The next integration should
consolidate those validators and update execution gates to use the additive action
type when implementing Start a task/Open a pull request. No new execution path is
introduced here. Automatic rollback continues to read the same `v2-approval`
records. Owner isolation and atomic PUT validation are preserved.

Tracking requires explicit agent attribution; older unattributed records are not
guessed to belong to Scout. Work-row patch fetches use the existing diff API.
No schema, release implementation, CLI, desktop, public/sign-in, inbox or other
worktree was changed. No live service, worker or container was operated.

## Validation

- Frozen dependency install passed; tracked pnpm cache restored, no dependency changes.
- `pnpm typecheck`, `pnpm lint` (warnings only) and `pnpm format:check` passed before each commit. See adjacent logs.
- `pnpm build` passed (including after the final UI edits).
- `node --test --test-concurrency=1 server/v2/agents.test.ts server/application-api.test.ts`: **23 passed**, no failures/cancellations. Includes all 12 agent cases and 11 application API cases.
- Shared conversation/model/task API tests: **11 passed**, no failures. See `conversation-tests.log`.
- The capture command failed before loading a page; no screenshots are claimed.

The fixture is in memory only and uses 5196/5197. Tests use temporary data, an unavailable Docker socket/executable,
and `test-guard.mjs` to restrict listeners to those two ports and serialize test
files. The guard only affects validation, not production code or the test runner.

The first complete suite run had 15 failures: the four known failures, ten
application API socket errors, and the three-listener CI fixture. The socket
errors came from the temporary two-port guard: a restarted fixture's HTTPS probe
could select its retained HTTP port. The guard now corrects that test-only
collision; all eleven application API cases pass. An earlier run was interrupted
when preview listeners had not yet released their ports. No production/test
source was modified to conceal either issue. Final suite totals are recorded below.

Final `pnpm test`: **755 tests, 737 passed, 5 failed, 13 skipped, 0 cancelled**,
exit 1. `full-suite.log` contains the complete final run. The failures are:

1. Two unchanged `server/ca-profile.test.ts` LibreSSL/profile assertions.
2. The unchanged Home Assistant readiness assertion in `server/catalog-api.test.ts`.
3. The unchanged Linux `/proc/self/fd` assumption in `server/legacy-preserving-update.test.ts`.
4. `server/ci-http.test.ts`: its fixture needs three simultaneous TCP listeners
   (mock application backend, HTTP API, HTTPS API). The task owns only 5196/5197,
   so the guard refuses the third listener with `No permitted test ports available`.

Thus the requested “only four known failures” criterion is **not met** in this
port allocation. No agent/project implementation test failed. Rerun CI HTTP in
an integration session with at least three assigned ports; do not weaken the
fixture or change production behavior to make this environment pass.

Both preview processes were stopped through their own sessions. After the final
suite, no listener remained on 5196 or 5197. No desktop browser was used.

## Commits

- `73344ba` — Polish agent drafts, tracking and person-only release approvals.
- The following project/evidence commit contains the project UI changes and this
  capture/test handoff; see the branch log for its hash.
