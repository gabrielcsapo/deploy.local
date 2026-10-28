# Slice 3 · Task, pull request and Ship

Branch: `codex/v2-task`. The brief, design-system rules, board markup and all eleven
1440/700 reference pairs were read. The reference renders were inspected together in a
contact sheet. No design sources, database schema, other worktrees or live services changed.

## Implemented

- Shared `Conversation` renders all eight `ConversationEvent` variants. Work logs use the
  existing expandable WorkLog, initially folded. Earlier calendar days fold with native
  disclosures; every decision remains outside the folded content and renders the existing
  `InboxDecision`. Screenshots form a gallery, attachments reject script URLs, and reports,
  task links and release progress use typed data. There is no Ship action in the renderer.
- Owner-authenticated `GET /api/v2/tasks/:id` reads the entire stored event history in pages,
  upserts stable event IDs, and includes project, computer, PR, check and screenshot context.
  It rejects agent/worker credentials through the existing v2 gate. New mappings cover real
  task-created, checkpoint, check lifecycle and job lifecycle events; no new agent command
  or release producer was introduced.
- Chat, Changes and Checks replace the three task placeholders. The composer sends a new
  message to the same task, with its revision and current adapter/model. Errors preserve
  the draft. Changes reads the actual PR diff, or the task diff before a PR exists. Checks
  reads pipeline jobs only from the latest run matching the diff's commit, including output.
  Task checks use the existing task diff response. Details refresh every ten seconds.
- Merge only calls the existing PR merge route with the displayed PR revision, base commit
  and head commit. The existing server remains responsible for conflict and check admission.
  Stalled and failed tasks show explicit banners and their stored conversation/decisions.
- This task shows repository, branch, computer, changed files/counts, linked PRs, screenshots,
  releases and start time. Content sections appear when their data exists. It folds away
  below 1180 px. First-task teaching is dismissible and remembered in browser storage.
- Ship… is in the header and panel. Its modal shows release source, placement, address,
  access and data. It posts exactly `{ source: { kind: 'ship', ref } }`, accepts `{ release }`,
  handles 404 with “Shipping needs the new release engine on this coordinator”, and renders
  subsequent `{ type: 'release', release }` updates from `/api/v2/events`. No automatic retry
  or legacy per-app release fallback exists. The task read requires an owner session before
  the controls appear; final release authorization remains the release endpoint's job.
- Pull requests has state filtering, search, pagination, recently merged rows and links to
  associated task pages. An open PR without a task can create and link a task using existing
  workspace commands; that action does not start a model run. Historical unlinked PRs are
  visibly disabled because the existing API forbids modifying merged PR associations.

## Not done: visual parity is blocked

**There are no implementation screenshots or paired PNGs. This slice is not visually signed
off and does not meet the screenshot acceptance requirement.** The prescribed command was
run against the isolated fixture and Vite servers on 5188/5187:

```sh
node design/v2/tools/capture.mjs http://127.0.0.1:5187/dashboard/tasks/Task docs/evidence/v2/3-task/captures/Task 1440,700 900
```

Chromium exited before opening a page with `bootstrap_check_in … Permission denied (1100)`.
`capture-error.log` preserves the failure. No computer-use or desktop-browser fallback was
used. HTTP 200 from the fixture page is a routing check, not visual verification. Vite also
logs the existing `workspace-icons.json?ssr` parsing problem before client rendering; the
production build passes. Keyboard, compact scrolling, focus and visual comparisons remain
unverified. Both preview servers were stopped via their original process sessions.

## Deliberate differences and integration gaps, per board

These are intended implementation differences, not claims of verified visual parity.

- **Task:** work starts folded as explicitly required, although the board exposes steps.
  Real inbox actions, times and answer provenance replace hardcoded examples; the existing
  InboxDecision also shows an answer input when an action accepts free text. Unsupported
  Update from main is omitted. Ship is available when a published source can be resolved.
- **TaskChanges:** actual patches determine file counts, additions and removals, and handle
  binary/renamed files. The narrow view hides the file navigation. Publish pull request and
  Update from main are not implemented by this slice. No made-up four-file summary appears.
- **TaskChecks:** only actual checks on the displayed PR commit appear; checks expand to show
  their output. The reference's arbitrary Run again action is omitted because task commands
  and pipeline reruns have different admission rules. The screenshot fixture includes the
  board's test output, but output starts folded in the implementation.
- **Review:** retains Chat/Changes/Checks as the brief requires. Merge only is the concrete
  existing PR command. There is no implemented combined Merge and release command here.
  An actual merge InboxDecision renders if its producer supplies it; the fixture supplies
  one only in memory. The board's unconditional Warden rollback promise is not fabricated.
  The panel is This task rather than an independent second approval/merge state.
- **PullRequests:** tabs appear only for supported project routes/content; no guessed issue,
  app or release counts. Row metadata comes from PR branches/status instead of unsupported
  reviewer identities and check totals. Existing task associations link directly. Merged or
  closed imported PRs without a task still need a durable historical-task association from
  a later backend change; they cannot yet open a task page. If multiple PRs share a task,
  the task currently selects its latest linked PR.
- **FirstTask:** same three teaching steps, dismissed with Got it and remembered in this
  browser. The server only offers the hint when the account has one task. There is no
  account-level persisted teaching preference yet.
- **TaskStalled / TaskFailed:** banners state only the known run status; no invented heartbeat,
  checkpoint number, offline timestamp or number of attempted approaches. Existing stored
  replies and InboxDecision cards appear. Move-to-computer and failed-task recovery decision
  producers do not exist on this base; this slice does not invent local approval state or
  implement those operations. The follow-up composer still uses the same task.
- **NewProduct:** screenshots are stored assets, never automatically launched previews.
  Fixture images are small stand-in meal-planner SVGs, not exact copies of the board's
  previews. Screenshot-taking/markup and their event producer belong to slice 6. Missing
  repository/computer/model details are explicit. No empty Releases section is shown;
  Ship stays in the panel as the task requires. The base task API cannot turn a projectless
  conversation into a new product; that existing workflow is outside these file boundaries.
- **LongChat:** reusable rendering implements folded calendar days and visible decisions.
  Its fixture runs inside the task page because agent routes are outside this slice. Agent
  filters, searching and the Tracking panel remain for the agent slice. Calendar headings
  and event counts use stored dates rather than invented briefs/shipped summaries.
- **ShipDialog:** access/placement/data are read-only. The agreed POST body has no fields to
  save those choices, and this base has no authoritative release-plan read endpoint.
  Production therefore explicitly says “Unavailable · uses project configuration”; fixture
  data shows SER, the meal-planner address, household access and Postgres. A follow-up release
  plan/settings contract is required for the board's access selector and complete preview.
  It is unsafe to ship `task.sourceRef` blindly: today it is the checkout's initial baseline.
  The read model resolves the published PR source branch, or the repository's actual default
  branch. The dialog names that source. Unpublished task edits must be published before they
  can be included; this slice never auto-publishes them. End-to-end first message → running
  app with one Ship press remains unverified pending the release engine and product workflow.
- Shared shell/account/sidebar behavior is inherited from slice 1 and uses fixture API data.
  Existing primitives supply fonts, tokens, focus states and modal semantics. No unsupported
  top-right search/more actions or invented resources are added.

## Reproduce the outstanding captures

With 5187 and 5188 free, start these in separate terminals:

```sh
node docs/evidence/v2/3-task/fixture-server.mjs
DEPLOY_DATA_DIR=/private/tmp/v2-task-preview-data DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5188 pnpm exec vite --host 127.0.0.1 --port 5187 --strictPort
node docs/evidence/v2/3-task/capture-all.mjs
```

`capture-all.mjs` invokes the required capture tool for every named board at 1440/700 and
then `design/v2/tools/pair.py` (board left, implementation right). It stops on the first
failure. ShipDialog opens via the normal `#ship` dialog deep link and does not submit a
release. Start the fixture with `TASK_SHIP_UNSUPPORTED=1` to exercise the 404 flow. Fixtures
have no database, runner, Docker or coordinator imports and all mutations stay in memory.
Inspect every pair, fix remaining visual differences, and record the review before accepting
this slice. Stop both preview processes afterwards.

## Validation

- `pnpm install --frozen-lockfile`: passed. Its tracked cache database change was restored.
- `pnpm typecheck`: passed (`typecheck.log`).
- `pnpm lint`: passed, existing warnings only (`lint.log`).
- `pnpm format:check`: passed (`format.log`).
- `pnpm build`: passed (`build.log`).
- Focused `node --test` covers `server/v2/tasks.test.ts`, `server/v2/api.test.ts`, and
  `app/routes/dashboard/v2/{tasks/api,conversation/model,conversation/render}.test.ts`.
  The render test bundles and renders the actual TSX, including WorkLog and InboxDecision,
  rather than checking source strings. **27 passed, 0 failed** (`focused-tests.log`).
- `pnpm test`: **654 tests; 626 passed, 4 failed, 11 cancelled, 13 skipped**, exit 1
  (`full-suite.log`). All new server tests passed. The four failures match prior slice logs:
  two `ca-profile.test.ts` certificate assertions (system OpenSSL flags and an expected
  exception), Home Assistant readiness in `catalog-api.test.ts`, and Linux `/proc/self/fd`
  in `legacy-preserving-update.test.ts`. `application-api.test.ts` cancelled eleven children
  after an HTTP socket failure during startup. This is not a green suite.
- Full-suite isolation used a new temporary data directory, an unavailable Docker socket,
  a temporary docker executable returning failure, and the existing
  `../1-inbox-api/test-guard.mjs` preload restricting listeners to 5180–5199. No live service,
  worker, container, installed app or real coordinator release was changed.

## Next slice

The release branch must provide the stated POST/GET and typed release event envelope, enforce
owner-only initiation, and expose authoritative shipping placement/access/data before the
modal can preview or edit them. The existing `shared/v2/api.ts` event union lacks release
updates; this client uses a local additive stream type until the release branch extends it.
No existing shared type was changed. The screenshot and agent slices can reuse Conversation;
decisions always come from InboxProvider. Resolve historical PR task associations, combined
merge-and-release semantics, and the missing published-product workflow before claiming all
slice-3 acceptance items complete. Finish all 22 paired screenshots on a permitted Chromium
host before visual sign-off.
