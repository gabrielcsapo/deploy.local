# Polish pass A

Read the implementation brief, both design READMEs, the earlier evidence notes and
visual reviews, and the assigned HTML/PNG boards at 1440/700 and the phone widths.
Design sources, project screens, release engine, Ship dialog, CLI and desktop files
were not edited. No live service, worker, container or installed app was changed.

## Implemented

- **Shared time:** inbox provenance, Live ages and release time, release step durations,
  backup/restore dates and account device dates use `data/time.ts`.
- **Waiting on you:** short answer provenance names iPhone, this Mac, terminal or web.
  An additive `answer.surface: 'menu-bar'` distinguishes the menu bar without changing
  existing client values. Today uses a clock, yesterday adds its calendar label, and
  older answers include a short calendar label. Answered rows and records render the
  new optional typed outcome with a state dot. Swift Codable mirrors both additions.
- **Outcome producers:** Live projects completed rollbacks into history. Rule-approved
  rollbacks record “Allowed by rule”; continuous observed project health for ten
  minutes records “Healthy after 10 min”. Gaps and unhealthy observations reset the
  observation window; once recorded, a historical healthy outcome survives later
  polling gaps. Outcomes emit typed inbox events. No release-engine files changed.
- **Live/Worker:** Warden avatars; cause-specific warning labels, including the board's
  memory summary; Start through the existing authenticated restart endpoint; colored
  Jobs/Queue/Process/Heartbeat glyphs; “Usually under 1%” from the measured baseline;
  release source title/reference and migration rows from release-service reads; a
  bounded error/stack excerpt from the existing app log stream, refreshed with health.
  AutoRollback shows the rule-approved completed rollback of the current release.
  Undo sends `from: rollback.to, to: rollback.from` to the existing project rollback API.
- **Release pages:** shared project navigation helpers reveal Pull requests and Issues
  from the actual project overview. Dotted names use the shared path encoder. Added
  the head search action, failed-step excerpt, Add the variable link with its key,
  and Ask Scout to fix it, which creates a project task containing the failure.
- **Backups:** local-only destinations show “Every copy is in this house”. Back up now
  calls an owner-only v2 endpoint around the existing maintenance backup operation;
  disabled/failed backups return errors rather than success. Restore uses the existing
  shared native modal and its fixed inset/margin/backdrop styles.
- **Sign-in/first run:** app initials get stable name-derived semantic colors. New
  project has Inspect repository, Found in the repository, Runs on and Address. The
  authenticated inspection reads committed deploy.yaml, package.json or Compose
  metadata in a temporary bare clone, without running scripts or writing the source.
  Install app shows the computer choices and measured capacity, declared persistent
  data/backup policy, and first-account instructions. Direct Discover app routes now
  select their catalog item. The standalone FirstTask helper verifies the current
  task is first; it clears on navigation. Tests also verify the production task read
  model rejects later tasks and remains scoped to the account.
- **Public:** LandingPhone's picture source is the supplied native Live capture, copied
  to `app/routes/v2-public/about/live-phone.png`.

## Parity status and deliberate differences

**No post-fix screenshot verification is claimed.** The required capture command failed
before opening a page: Chromium's `bootstrap_check_in` returned Permission denied (1100).
See `capture-attempt.log`. No computer use or alternate desktop browser was attempted.
`captures.md` and `capture-all.mjs` contain every exact URL, width, height and pairing
command. The fixture served HTML, transformed client modules and API data successfully;
its seeded inspected-repository result was checked in the transformed module.

- **Inbox / AnsweredPhone:** web history retains the shared responsive web shell. The
  390 capture is not a replacement for native SwiftUI verification. The native change
  here is the wire mirror. Health and rule outcomes are produced; Released <commit>
  outcomes need the release/merge producers owned by the other pass. Fixture examples
  of those chips demonstrate rendering only. Invalid/missing evidence remains unavailable.
- **Live / Worker / AutoRollback:** no invented usual queue-drain interval, retry count,
  schema-reading behavior, or “no errors” claim. Migration rows report reversibility;
  the contract has no per-migration applied timestamp. Release source.ref is displayed
  as on release pages; a distinct human commit title is not in the current Release
  contract. Unknown health stays unavailable. History retains measured percentages.
  Automatic rollback Undo surfaces API errors, including any required backup review,
  without bypassing release admission. See the report opens the project release record.
- **Deployments / ReleaseFailed:** humans remain the release starters; the board's
  “Released by Scout” violates the settled brief. Conditional tabs follow the project
  helper (including hiding a one-app Apps tab). Add the variable appears only when a
  missing key can be identified; other errors offer Project settings. Search opens the
  searchable project list. Logs contain real step details, not illustrative board logs.
- **Backups / RestoreData:** no off-site provisioning action is invented because that
  endpoint does not exist. Local absolute paths establish the warning; remote or
  unknown destinations suppress it. Dates describe stored backups, not a fictional
  next-night completion. The restore-to-copy flow is retained per the v2 decision.
  Centering follows the fixed shared Dialog CSS, but visual/keyboard confirmation is
  still required when the orchestrator captures both widths.
- **AppsHome:** colors derive from actual app names and shared tokens, so exact hues and
  initials can differ from the board's illustrative branded apps.
- **NewProject:** inspection is explicit and read-only. Project name remains required.
  Runs on says “Choose when you ship”; Address shows a declared hostname or explains
  that it is set before shipping. Project creation does not accept placement/address
  settings, so those fields do not pretend to save choices. Automatic Scout PR creation
  is not added. Fixture state represents a completed inspection, seeded only by Vite.
- **InstallApp:** declared data resources and backup inclusion replace the board's
  assumed nightly schedule and configurable folder. No memory slider or nightly toggle
  is shown because the install API does not accept those choices. Memory is reported as
  capacity, not free memory. Existing application-name and required-answer inputs stay.
- **FirstTask:** the real task page already guarded its hint with the account-scoped
  server flag; this pass adds regression coverage and fixes the independent onboarding
  helper. Existing task-page teaching styling and dismissal remain unchanged.
- **LandingPhone:** the image comes from the native capture. Browser status/address bars
  remain browser chrome, not simulated page content.

## Validation

- `pnpm install --frozen-lockfile`: passed; generated tracked pnpm index restored.
- `pnpm typecheck`: passed (`typecheck.log`).
- `pnpm lint`: passed with warnings, no errors (`lint.log`).
- `pnpm format:check`: passed (`format.log`).
- `pnpm build`: passed (`build.log`).
- Focused `node --test` (all changed test files plus health and shared time): **44 passed,
  zero failures** (`focused-tests.log`). Includes Swift Codable round-trip, actual
  repository inspection, answer provenance, observation gaps, rule attribution,
  error extraction, missing-variable keys, backup authorization and first-task guards.
- Full `pnpm test`: **756 tests; 738 passed, 5 failed, 0 cancelled, 13 skipped**, exit 1
  (`full-suite.log`). The four known environment failures remain: two system OpenSSL
  assertions in `ca-profile.test.ts`, Home Assistant readiness with Docker unavailable,
  and Linux `/proc/self/fd` in `legacy-preserving-update.test.ts` on macOS.
- The fifth failure is `ci-http.test.ts`: its fixture needs three simultaneous TCP
  listeners (backend, HTTP and HTTPS), exceeding this pass's two assigned ports.
  The guard refuses the third listener. Consequently the requested “only four failures”
  finish condition is **not met** in this constrained environment. All v2 tests pass.
- The first full run (`full-suite-first.log`) also had ten application API socket
  failures: a repeated TLS probe reused the fixture's retained HTTP port after restart.
  The isolated harness now preserves that suite's HTTP/TLS port pair. Its eleven tests
  pass (`http-recheck.log`), as they do in the final full run.

The suite used fresh temporary data, a deliberately unavailable Docker socket and a
failing fixture-only docker executable. `test-guard.mjs` serializes test files and
restricts TCP/UDP listeners to 5194–5195. Only this pass's preview processes were
started/stopped; no live coordinator was contacted or reconfigured.

## Integration for the next pass

- Capture and inspect all pairs, particularly NewProject, InstallApp, RestoreData and
  narrow answered-history rows. Stop the fixture afterwards.
- Desktop menu-bar answers can now send `{ on: 'desktop', surface: 'menu-bar' }`.
  Older desktop clients remain compatible and display “on this Mac”.
- Release/merge producers can attach `InboxItem.outcome`; no contract replacement or
  schema migration is needed. The Live response adds optional `rollbacks`, and its app
  detail adds optional `release`. Clients that ignore unknown fields remain compatible.
- Add the variable links to `/dashboard/projects/:project/settings?key=<missing-key>`.
  Polish B owns that editor; it can consume `key` to prefill the add-variable dialog.
  This pass deliberately does not edit those project files.
- A future placement/creation contract can make the NewProject fields editable. The
  current read-only values do not change release placement or install behavior.
- Re-run the CI HTTP test where three allowed ports are available. This work makes no
  claim that the full suite is green or that visual parity is signed off.
