# Slice 11 docs refresh

Scope: `app/routes/docs/**` and this evidence directory, on `codex/v2-docs-2`.
The brief, design rules, earlier slice notes and merged implementation were used
for this audit. Older notes are historical: the final polish, release integration,
sign-in integration and supervised-updates continuation supersede their earlier
missing-feature lists. No API, schema, route registration or design source changed.

## Page audit

All 19 canonical pages were reviewed against the code, including retained sentences.
Paths below are relative to the repository root. The shared article source is
`app/routes/docs/content.tsx`; route wrappers still select the same pages.

| Page                   | What changed or was confirmed                                                                                                                                                                                                                                                   | Code checked                                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Get started            | Fresh/recover setup, printed code, password-first account, optional passkey after trust, working Home and Ship. Removed placeholder claims.                                                                                                                                     | `server/v2/setup-installer.ts`, `setup.ts`; `app/routes/v2-public/auth-policy.ts`; `app/routes/dashboard/v2/start/home.client.tsx`, `account.client.tsx`; `app/components/ui/v2/Composer.tsx`                                                                                                          |
| Install on a computer  | Explicit local setup helper in the source build instructions; 30-minute code, `/setup`, replacement-folder recovery and `/recover`; browser CLI login and password fallback; trusted HTTPS passkeys. `/install` still installs the CLI, not a fresh coordinator.                | `server/v2/setup-installer.ts`, `setup.ts`, `auth.ts`, `auth-cli.ts`; `server/cli-download.ts`; `bin/deploy.js`; `package.json`                                                                                                                                                                        |
| Add a computer         | Mac/Linux CLI join versus Windows desktop join; retained ten-minute code and supported roles; removal checks model serving as well as apps/work, leaves disk files.                                                                                                             | `server/v2/computers.ts`; `app/routes/dashboard/v2/computers/page.client.tsx`; `bin/deploy.js`; `desktop/src/worker.mjs`                                                                                                                                                                               |
| Your devices           | Desktop enrollment, tray, Take new tasks, platform-specific notifications, closing versus Quit, offline behavior; iPhone QR pairing, push actions, category/quiet-hour preferences and paired-device removal. Kept actual desktop role/download limits.                         | `desktop/src/main.mjs`, `views.mjs`, `coordinator.mjs`, `worker.mjs`; `server/v2/devices.ts`, `push.ts`, `phone-preferences.ts`; native `DeployUI/V2/V2SignIn.swift`, `V2NotificationSettings.swift`, `V2Devices.swift`, `V2Root.swift`; native `DeployCore/V2/V2Pairing.swift`, `V2Preferences.swift` |
| Ask and build          | Home task creation and the project’s New task link back to Home, Chat follow-ups, folded work log, per-chat model. Retained tool-free agent chat, Scout-only CLI task selection and first-answer-wins inbox behavior.                                                           | `app/components/ui/v2/Composer.tsx`; `server/v2/attachments.ts`, `agents.ts`, `inbox.ts`; `app/routes/dashboard/v2/tasks/page.client.tsx`, `projects/page.client.tsx`; `bin/cli-v2.mjs`                                                                                                                |
| Review and ship        | Chat/Changes/Checks, linked PRs, This task, editable per-app Ship choices, placement/data guards, discoverability versus address authorization, Merge only and configured push pipelines, progress and disabled controls.                                                       | `app/routes/dashboard/v2/tasks/page.client.tsx`, `ShipDialog.tsx`, `api.ts`; `server/v2/tasks.ts`, `releases-plan.ts`, `releases-api.ts`; `server/workspace/project-collaboration.ts`, `pipeline-triggers.ts`, `pipelines.ts`, `pipeline-deployment.ts`                                                |
| Screenshots and markup | Replaced stub with requested worker capture for web, booted iOS simulator and approved desktop window; Pen/Arrow/Text/Undo and three colors; original preservation, sent annotations and file limits. Native iPhone media remains unconnected.                                  | `app/components/ui/v2/Composer.tsx`; `app/routes/dashboard/v2/markup/Markup.tsx`, `model.ts`, `client.ts`; `server/v2/screenshots.ts`, `attachments.ts`, `events.ts`; `server/workspace/screenshot-runtime.ts`; native `DeployUI/V2/V2Composer.swift`, `V2Conversation.swift`, `V2TaskInfo.swift`      |
| Live and incidents     | Confirmed real health and missing-data behavior, worker signals, shared rollback decision and rules; added automatic rollback reports.                                                                                                                                          | `server/v2/live.ts`, `health.ts`, `releases.ts`; `app/routes/dashboard/v2/live/page.client.tsx`, `presentation.ts`                                                                                                                                                                                     |
| Releases and rollback  | Remote execution and all-computer activation acknowledgment; reverse jobs; startup recovery and uncertain-data lock; blocked conflicting changes. Retained copy verification, activation downtime, exact backup/data-loss confirmation and unrestricted rollback-rule behavior. | `server/v2/releases.ts`, `releases-runtime.ts`, `releases-remote.ts`, `releases-worker.ts`, `releases-journal.ts`, `releases-fence.ts`, `project-policy.ts`; `bin/deploy.js`; `app/routes/dashboard/v2/releases/page.client.tsx`                                                                       |
| Projects and apps      | Multi-app membership and working PR task links; write-only secrets with overrides; keep 1–100 earlier releases (default five), Verify migrations, typed-name removal and actual local/remote backup limits. Confirmed logs are a tail with text filters.                        | `server/v2/projects.ts`, `settings.ts`, `project-policy.ts`, `project-removal.ts`, `logs.ts`; `app/routes/dashboard/v2/projects/page.client.tsx`, `app.client.tsx`, `settings.client.tsx`, `logs.client.tsx`, `routing.ts`                                                                             |
| Backups and restore    | Back up now, owner-only private home-network copy address, sign-in handoff, revocation and WebSocket limit. Retained copy-first/check/Switch sequence, saved schedules, compatible local archive requirement and separate coordinator recovery.                                 | `server/v2/backups.ts`; `server/edge/copies.ts`, `upgrade-proxy.ts`; `server/maintenance.ts`; `app/routes/dashboard/v2/settings/backups/page.client.tsx`; native `DeployUI/V2/V2Backups.swift`                                                                                                         |
| Updates                | Replaced “no automatic updates” with off-by-default admin switch, ten-minute scheduler, idle admission, verified Live target, startup confirmation and rollback. Coordinator self-release requires a verified bundle and isolated verifier; ordinary build output lacks them.   | `server/v2/updates.ts`, `fleet-updates.ts`, `update-admission.ts`, `self-release-runtime.ts`, `coordinator-executor.ts`; `server/supervisor.ts`; `app/routes/dashboard/v2/computers/page.client.tsx`; `bin/deploy.js`                                                                                  |
| Agents                 | Draft schedule/coverage choices, iPhone mute/unmute and pause/resume, actual scope of pause; retained tool-free chat and inactive standing-agent schedules.                                                                                                                     | `server/v2/agents.ts`, `phone-preferences.ts`, `attachments.ts`, `releases.ts`; `app/routes/dashboard/v2/agents/page.client.tsx`; native `DeployUI/V2/V2TaskInfo.swift`                                                                                                                                |
| Approvals              | Exactly five delegable actions; Always yours screen/deletion/secrets/release rules; narrow stacking, project overrides, Ask defaults and text-limit behavior. No invented autonomous executor for saved matrix actions.                                                         | `app/routes/dashboard/v2/settings/approvals.tsx`; `server/v2/agents.ts`, `releases.ts`, `phone-preferences.ts`; `shared/v2/contracts.ts`                                                                                                                                                               |
| Models                 | Defaults per job now feed writing-code and answering-question composer paths; saved Reviewing is not an automatic review runner. Retained reported weekly usage, local inventory and compatible-provider requirement for chat.                                                  | `server/v2/computers.ts`, `attachments.ts`, `agents.ts`; `app/routes/dashboard/v2/computers/page.client.tsx`; `app/components/ui/v2/Composer.tsx`                                                                                                                                                      |
| CLI                    | Full help output matches the actual entry point verbatim, including optional flags; browser login/password fallback; current exact release/rollback progress and legacy receipt distinction. Retained fixture transcripts and exit codes.                                       | `node bin/deploy.js --help` (captured as `CliHelp.txt`); `bin/deploy.js`, `bin/cli-v2.mjs`; `server/v2/auth-cli.ts`; `docs/evidence/v2/14-cli/CliStatus.txt`, `CliErrors.txt`; `docs/evidence/v2/11-docs/CliReleases.txt`                                                                              |
| deploy.yaml            | Confirmed example against the actual parser; documented sibling `release-migrations.json` reverse command map, original receipts and reverse-chain verification limit. No invented YAML key.                                                                                    | `server/application-spec.ts`; `server/v2/releases-runtime.ts`, `releases-worker.ts`; `app/routes/docs/docs.test.mjs`                                                                                                                                                                                   |
| How it works           | Remote project verification/activation and persisted recovery replace coordinator-only claim; retained coordinator, edge, shared events and local address behavior.                                                                                                             | `server/v2/api.ts`, `events.ts`, `releases-runtime.ts`, `releases-remote.ts`; `server/edge/runtime.ts`, `restarting.ts`; `server/v2/setup.ts`                                                                                                                                                          |
| Troubleshooting        | Restart recovery instead of “not available”; uncertain data outcomes and blocked changes; private copy access instead of localhost-only; retained connection, Docker, model-provider and CLI selection guidance.                                                                | `server/v2/releases.ts`, `releases-runtime.ts`, `releases-fence.ts`; `server/edge/copies.ts`; `server/v2/agents.ts`; `bin/cli-v2.mjs`                                                                                                                                                                  |

Public docs chrome now links the brand to `/about` and both Sign in links to `/signin`.
The link test checks those newly merged routes plus `/setup` and `/recover`.
The additional CLI test executes only `--help`, without contacting a coordinator,
and compares the rendered help block byte-for-byte (excluding the terminal newline).

## Deliberate differences from the boards

DocsHome, DocsArticle and DocsPhone source markup and all five supplied renders
were inspected. The existing docs layout, hierarchy, tokens and responsive behavior
are unchanged. `design/v2` was not edited.

- DocsHome retains four steps and its glossary, with no invented installation time.
  The board's passkey-first account is wrong: the first account uses a password,
  and passkeys require trusted HTTPS. A working local setup helper is documented;
  the board's unverified published one-command installer URL is not advertised.
  The helper is not automatically invoked by another coordinator installer in the
  merged code, so Install explicitly runs it. Desktop roles remain capability based.
- DocsArticle adds remote releases, restart recovery and conflicting-change rules,
  so it is longer. Watch describes the actual ten-minute process checks rather
  than promising a separate Warden monitoring job. Rollback reverses registered
  jobs; it does not promise arbitrary data reversal or a ten-minute-only Allow rule.
  CLI release-list output remains the recorded fixture instead of invented output.
- The Ship documentation distinguishes Apps at home visibility from app-address
  authorization. The native iPhone media UI still says its APIs are missing even
  though the server APIs have merged; the docs correctly identify the client gap.
- Existing narrow behavior remains: navigation menu and collapsible contents at
  700, rather than the board's squeezed three columns. At 390 the article scrolls
  and does not imitate browser status/address bars or clip content. Added sections
  and full CLI help use the same article layout; no new screen design is introduced.
- Retained limits are tied to actual guards: privileged verification, uncertain
  data recovery, iPhone media, standing-agent scheduling, unsupported desktop roles,
  remote-only removed-project backup retention and ordinary coordinator builds.

## Validation

- `pnpm install --frozen-lockfile`: passed. Restored the generated tracked pnpm
  cache index; dependencies and lockfile are unchanged.
- `pnpm typecheck`: passed (`typecheck.log`).
- `pnpm lint`: passed, warnings only (`lint.log`).
- `pnpm format:check`: passed (`format.log`).
- `pnpm build`: passed (`build.log`).
- `node --test app/routes/docs/docs.test.mjs`: **8 passed, 0 failed**
  (`docs-tests.log`). Includes all 19 routes, every internal link/heading, all five
  308 redirects, search (including new passkey/mute/reversal headings), navigation,
  compiled YAML, recorded transcripts and exact live CLI help output.
- `node --test server/edge/copies.test.ts` with the evidence preload: **2 passed**
  (`copies-recheck.log`). This checks the corrected fixed-port remapping only;
  no edge or test source was changed.
- Final `pnpm test`: **857 tests, 840 passed, 4 failed, 13 skipped, 0 cancelled**
  (`full-suite.log`, exit 1). The full suite is not green. The remaining failures
  are in unchanged code and match prior slice evidence: two CA-profile assertions
  under system LibreSSL (`server/ca-profile.test.ts`), Home Assistant readiness
  without Docker (`server/catalog-api.test.ts`), and Linux `/proc/self/fd`
  assumptions on macOS (`server/legacy-preserving-update.test.ts`). All discovered
  docs and v2 tests passed.
- The first full run had **857 tests: 839 passed, 5 failed, 13 skipped, no
  cancellations** (`full-suite-first.log`). Four are the previously documented
  environment failures. The fifth was the copy-preview fixture's hard-coded
  5186/5187 listeners, refused by this task's port guard. The harness now remaps
  those two ports at both listen and connect, as it already did for 5194–5197.
- **Visual acceptance remains blocked.** The required capture command failed
  before opening a page with `bootstrap_check_in … Permission denied (1100)`
  (`capture.log`). No implementation PNGs or pairs exist to inspect. The actual
  hydrated route fixture served `/docs` and `/docs/releases`; `fixture-server.mjs`
  and `captures.md` provide the exact five capture/pair commands at 1440, 700 and 390. No computer use or alternate desktop browser was attempted. The fixture
  was stopped before resuming the suite.

The suite uses temporary data, an unavailable Docker socket and a failing Docker
executable on a temporary PATH. The evidence-only preload serializes test files,
restricts TCP/UDP to **5180 and 5181**, remaps fixed fixture ports, and suppresses
multicast announcements. HTTP and TLS can use separate loopback address families
within those two ports. It does not modify production or test assertions. No live
coordinator, service, worker, container or installed app was operated.

Reproduce from the repository root with the fixture stopped:

```sh
v2_docs_temp=$(mktemp -d /tmp/v2-docs-2-check.XXXXXX)
mkdir -p "$v2_docs_temp/bin" "$v2_docs_temp/data"
printf '#!/bin/sh\nexit 1\n' > "$v2_docs_temp/bin/docker"
chmod +x "$v2_docs_temp/bin/docker"
unset CI_REAL_DOCKER DEPLOY_TEST_DOCKER DEPLOY_RUN_DOCKER_TESTS
PATH="$v2_docs_temp/bin:$PATH" DEPLOY_DATA_DIR="$v2_docs_temp/data" DOCKER_HOST="unix://$v2_docs_temp/no-docker.sock" NODE_OPTIONS="--import=$PWD/docs/evidence/v2/11-docs-2/test-harness.mjs" pnpm test
```

## Commits

- `d6709bd` — Refresh v2 docs against merged product behavior.
- The following evidence commit records the page audit, captures and final results.

## Handoff

No shared-file merge is needed. Keep `docs.test.mjs` in the root suite (already
configured in `scripts/test.mjs`). Update the relevant page when native media,
standing-agent execution, remote archive retention or the production coordinator
bundle recipe changes. The docs do not claim those are implemented.

## Visual review (added by the orchestrating session)

DocsHome and DocsArticle were captured at 1440 against the docs fixture on 5180 and paired with their boards (board left); Approvals is in `captures/`.

- The layout is unchanged and still matches.
- Content checks: Get started now describes the setup code, the password-first account and the later passkey offer. Approvals lists the five delegable actions and the four Always yours rules, matching the merged code.
- No stale phrases remain ("not available in this version", "still being connected", "source installation").
