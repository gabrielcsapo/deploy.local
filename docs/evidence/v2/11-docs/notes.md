# Slice 11 part 2 · docs

Rewrote the committed docs on `codex/v2-docs`. No other worktree, live service,
worker, container or installed app was changed. Changes are confined to
`app/routes/docs/`, the `/docs/*` entries in `app/routes.ts`, and this evidence folder.

## Implemented

- All 19 canonical pages and the exact Start / Build / Run / Agents / Reference
  navigation. Ten required routes had no entries on this branch, so those docs-only
  entries were added; five existing component imports were renamed. The five old
  docs routes retain their shared redirect component and land on canonical pages.
- A shared docs screen uses the v2 tokens, icons, controls, Group, Setting, Steps
  and Term. It has the top bar, search, current-page navigation, article, right
  contents column, previous/next and GitHub edit link. Search matches titles and
  headings locally, supports multiple terms, empty results, clearing and Cmd/Ctrl-K.
- Below 1180px, contents become a native expandable section. Below 900px, the
  navigation opens with a menu button. Escape closes it and restores focus. The
  article has a skip link, stable heading IDs, visible focus and wrapping code.
- Every page describes the code in this checkout. Screenshots and markup is an
  explicit short stub. Get started teaches the six board glossary entries plus
  Ship…. New public copy uses computers, releases, Waiting on you, Live, Scout
  and Warden; rendered-page tests reject the retired vocabulary.
- Seven focused tests render all actual route modules, compare exact navigation,
  check every internal href/fragment and heading ID, verify all five 308 redirects
  with query/hash preservation, exercise heading/title search, check previous/next,
  compile the YAML example with the real parser, and compare CLI output to evidence.
  Run `node --test app/routes/docs/docs.test.mjs`; the root suite only discovers
  `server/*.test.ts`, so it does not discover this docs-owned test automatically.
- The fixture serves those same route components with hydration, without an API,
  on 5180. A separate read-only CLI fixture on 5181 records release-list output.

## Code and evidence used for content

- `server/v2/api.ts`, inbox/events, Live/health and release API/service/runtime;
  `app/routes/dashboard/v2/inbox`, `live` and `releases`; slices 1, 2 and 4 notes.
- Projects/settings/logs, computers/models/updates, agents/Approvals and backups
  code under `server/v2/` and `app/routes/dashboard/v2/`; slices 5, 7, 8 and 10 notes.
- Current `app/routes.ts`, `v2-home.client.tsx` and the shared Composer. Home and
  task/Changes/Checks/Pull requests remain previews/placeholders on this branch.
- `bin/deploy.js`, `bin/cli-v2.mjs`, `server/cli-download.ts`, package.json, the
  committed source installation instructions, and the application manifest parser.
- `desktop/src/` (password/certificate pinning, worker setup, roles, tray and offline
  behavior); native `DeployCore/V2` and `DeployUI/V2` (shared state, task composer,
  local-only attachments, offline behavior); slices 12 and 13 notes.
- `node bin/deploy.js --help` was run without contacting a coordinator. Its six
  command groups and syntax match `14-cli/CliHelp.txt`. The status and missing-app
  examples quote `14-cli/CliStatus.txt` and `14-cli/CliErrors.txt` verbatim.
  `node docs/evidence/v2/11-docs/cli-fixture.mjs` captured `CliReleases.txt` against
  synthetic data on 5181 with real account loading disabled. The full suite also
  runs the unchanged CLI tests. No documented mutating CLI command was run against
  a real installation. Installation shell commands are source instructions, not
  actions performed during this task.

## Deliberate differences from the boards

The design files are unchanged, as instructed. Read all five named renders and
all three HTML sources before implementation.

- **DocsHome:** no invented ten-minute setup duration, fresh/recover installer,
  setup code, passkey-first account, published desktop downloads or working Home
  task flow. The first account uses a password. Passkeys are described as later,
  after certificate trust, and explicitly unavailable in this checkout. The
  installer command on the board is replaced by a working docs link: the real
  `/install` endpoint installs only a CLI from an existing coordinator. Source
  coordinator installation is documented on Install. The desktop/role wording
  explains only supported roles. Tasks can lead to a pull request; not every task
  necessarily ends in one. Added Ship… to the glossary and a GitHub edit link.
- **DocsArticle:** keeps the same article sections and four-step hierarchy. Adds
  the actual coordinator-only/host-access limits and possible activation downtime.
  Does not promise arbitrary migration reversal: ordinary jobs need backup restore.
  Watch checks running processes; no claim that Warden performs the board's exact
  monitoring checks. An Allow rule is not a ten-minute policy; text limits cannot
  authorize unattended action. Data loss always requires explicit review. The CLI
  example is actual release-list output rather than the board's invented dates,
  PR labels, migration details and interactive rollback sentence.
- **700px web boards:** both source renders squeeze the article between two open
  sidebars. Implemented the task's requested narrow menu and collapsible contents
  instead, so the article stays readable. This is intentional, not pixel parity.
- **DocsPhone:** uses the same top bar, breadcrumb, title, expandable contents and
  steps hierarchy, with a real scrolling article. No simulated browser status bar,
  address bar or blank clipped continuation. Long step text wraps rather than
  hiding health/verification details. The header starts at the viewport top; it
  does not add the board's fake system safe-area space.
- **Shared presentation:** the existing v2 icon set replaces board-only glyphs.
  Hanken Grotesk is the token's preferred font; it falls back to the shared system
  stack when unavailable, without a third-party font request. Search is a real
  input and results list. Contents anchors work, but no fabricated active section
  state is shown before the reader follows one. Text lengths differ where the
  current limitations need explanation; every page has previous/next and edit.
- **Public chrome:** docs-scoped CSS hides the legacy root header/footer only while
  `.docs-v2` is present, so no public-site files needed edits. `/about` and `/signin`
  are not registered on this branch. The brand links to `/` and Sign in keeps the
  existing `/dashboard` destination. The link checker caught this; it does not
  whitelist missing future routes. Repoint these after those sibling slices merge.

## Features intentionally not documented as working

- Fresh/recover installer, setup codes, passkey registration and QR pairing.
- Home submission, combined web task review and a working task Ship… action;
  automatic v2 shipping from a merge. The user always starts a release.
- Screenshot capture/markup or sending iPhone attachments. Picked attachments are
  local-only; the text-only workaround is documented.
- Project releases on remote computers, privileged/host-bound verification,
  arbitrary reverse migration commands or automatic recovery of stuck reservations.
- Automatic coordinator self-release/worker installation, downloading published
  desktop installers, changing Run apps/Serve models in Computers, moving all data
  during removal, or saved model defaults changing task execution.
- Standing-agent scheduling, tools in agent chat, or universal enforcement of all
  actions shown in Approvals. Only rollback is wired to the shared rule gate.
- Always-nightly backups, guaranteed off-site copies, remote/legacy copy restore,
  opening a localhost restore copy from another device, or coordinator recovery in
  the Backups page. The copy-first check and explicit switch are documented.

## Validation and remaining acceptance

- Frozen dependency install passed. Its tracked pnpm cache change is not part of
  this slice; the lockfile and dependencies are unchanged.
- Typecheck passed; lint passed with warnings and no errors; format check passed.
  Production build passed. Logs are beside this note.
- Focused docs tests: **7 passed, 0 failed** (`focused-tests.log`). The rendered
  YAML example compiles, and internal links/anchors resolve in the current branch.
- Full-suite results are recorded in `full-suite.log`. The initial run is kept as
  `full-suite-first.log`: **719 tests, 691 passed, 15 failed, 13 skipped**, none
  cancelled. Ten failures came from an isolated HTTP fixture reusing its HTTP
  port for HTTPS after a restart under the two-port guard. After preserving its
  original HTTP port in the temporary guard, **all 11 application API tests passed**
  (`application-api-recheck.log`). **Final rerun: 719 tests, 701 passed, 5 failed, 13 skipped, none cancelled.**
  The five failures are two unchanged CA-profile assertions under system LibreSSL,
  Home Assistant readiness with Docker disabled, the Linux `/proc/self/fd` assumption
  on macOS, and `ci-http.test.ts` needing a third TCP listener. This is not a green
  full-suite result. No docs or v2 test failed.
- Tests use temporary data, an unavailable Docker socket/executable, and a
  temporary preload (preserved as `test-guard.mjs`) limiting TCP/UDP listeners to **5180 and 5181** and serializing
  test files. The CI HTTP fixture needs three simultaneous TCP listeners and cannot
  fit this slice's allocation; no additional port was used. No test assertions or
  application code were changed to hide failures.
- **Visual acceptance is blocked, not complete.** The prescribed Chromium capture
  failed at launch with `bootstrap_check_in … Permission denied (1100)`.
  `capture.log` preserves it; `captures.md` gives all five exact URL/width/height
  combinations, capture/pair commands and keyboard checks. No implementation PNGs
  or side-by-side pairs exist to inspect. No desktop browser or computer use was
  attempted. The fixture and CLI-example server were stopped.

## Handoff

Finish the five captures/pairs and keyboard/scrolling checks in a Chromium-capable
session. Check the real root layout after merging the public site; if that slice
suppresses docs chrome itself, the local `:has(.docs-v2)` rule can be simplified.
Update the missing-feature paragraphs only after checking merged task/sign-in/iPhone
code. Keep the ten new docs route entries when merging `app/routes.ts`. All article
text and heading/search metadata live in `app/routes/docs/content.tsx`; the small
route modules select their canonical page. The edit link intentionally targets
that shared content file. No database, API, contract or design-source change is
required by this slice.
