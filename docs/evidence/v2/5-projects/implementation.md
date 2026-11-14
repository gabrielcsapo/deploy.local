# Slice 5 · projects, apps, logs and project settings

Implementation on `codex/v2-projects`. No live coordinator, service, worker,
container or installed app was changed. Preview processes on 5195 and 5196 were
stopped. Test databases and secret keys were created only in temporary directories.

## Implemented

- Projects, project overview, one-app overview, Code, Issues, app Overview/Settings,
  project Logs and project Settings replace their route placeholders. The global
  Settings route provides account identity and navigation to Approvals, Backups,
  Computers and project configuration; it is not the complete general Settings board.
- Project tabs derive from existing content. Code requires a repository, Pull
  requests and Issues require records, Apps requires a second app, Releases requires
  a release, and Logs requires an app. A one-app project without collaboration
  records shows its app health directly. Apps is `?tab=apps` on project overview,
  because this wave cannot add an app-list route. The Apps list and one-app
  overview can attach an existing app. New app creation remains the Ship flow.
- Dotted names use `encodeURIComponent` plus `%2E` in resource links. A narrowly
  scoped pre-router Vite rewrite also accepts existing literal-dot project links,
  including links emitted by other slices. This is the one additional Vite change
  explicitly needed for the task's dev-routing fix. Production handles both forms.
- `project_applications` gives each app one persistent, owner-scoped project.
  Migration `0037_project_configuration.sql` creates the tables. On first project
  lookup, existing repository/deploy.yaml links seed membership; unlinked apps get
  stable `app:<name>` projects. The workspace and coordinator databases are separate,
  so repository-link backfill runs idempotently in the projection, not in SQL.
  Explicit links survive subsequent manifest changes. The existing release API's
  `GET /api/v2/projects` and release engine use this same projection.
- Adding an app rejects cross-owner access, another repository's membership, and
  an active release. A standalone app's configured shared defaults become its app
  overrides when it joins; secret ciphertext is re-encrypted for the new address.
  This does not transfer historical standalone releases to the new project.
- Settings migrate the active (or desired, if no active) revision's application-wide
  configuration to app overrides, preserving differences between apps. Legacy
  untyped environment values are conservatively copied as encrypted overrides.
  Original versioned and site-scoped values remain intact. A per-app marker prevents
  repeat migration or resurrection after deletion. Project settings store no
  plaintext secret values; authenticated encryption binds owner/project/app/key.
- New reads return secret names, `set: true`, scope and `updatedAt`, never a value,
  digest or ciphertext. Project defaults feed declared application configuration;
  app overrides win. Deleting an override inherits a shared value, otherwise a
  tombstone prevents fallback to the old per-app secret. Existing declaration
  validation still applies. Writes are fenced during active releases so Verify and
  Activate cannot resolve different settings through this API.
- App health reads `/api/v2/live/:app`. Release history links to project Releases.
  App Settings provides address/health/computer information, a memory-limit update,
  and a link to project Settings. Restart uses the existing per-app endpoint after
  an explicit UI confirmation.
- Logs validate project/app membership, then stream the existing authenticated
  per-app endpoints. All apps or `?app=<name>` are supported, plus text/level filters.
  Streams decode split chunks, retain a bounded line history, cancel on navigation
  or filter changes, and expose connection failures and a Reconnect action.
- Code browses repository directories, previews files and README, copies the clone
  URL, and displays history. Issues filters open/closed records, links associated
  tasks, and creates issues through the existing idempotent workspace API.

## API for web and iPhone integration

Existing `Project` and `AppHealth` contracts are unchanged. Added `ProjectSetting`
and `ProjectSettings` types. No native files changed; ProjectPhone was read only.

- `GET /api/v2/projects` → `{ projects: Project[] }` (existing release dispatcher).
- `GET /api/v2/projects/:p/overview` → safe project/repository/task/issue/pull/app
  metadata for the web page. IDs take precedence over names.
- `POST /api/v2/projects/:p/apps` with `{ "app": "home-gym-sync" }` attaches an
  existing owned app. Response: `{ project }`.
- `GET /api/v2/projects/:p/settings` → `{ values, appliesOn: "next-release" }`.
  Each value has `key`, optional `app`, `type`, `set`, `updatedAt`; only non-secrets
  have `value`. Omitted `app` means every app in the project.
- `PUT /api/v2/projects/:p/settings` with
  `{ "values": [{ "key": "NODE_ENV", "value": "production", "app": "home-gym" }] }`
  atomically patches variables; other entries remain unchanged.
- `PUT /api/v2/projects/:p/secrets/:key` with `{ "value": "…", "app": "…" }`.
  `?app=` is also accepted and takes precedence over the body.
- `DELETE /api/v2/projects/:p/secrets/:key?app=…` deletes that scope. Omit `app` for
  the shared secret. Responses contain only the redacted settings view.
- `GET /api/v2/projects/:p/logs?app=…` → `{ sources: [{ app, url }] }`. Clients
  stream each returned URL with their existing session credentials. Invalid app
  filters return 404 before response headers are sent.

All new routes use the v2 signed-in-owner boundary; agent and worker credentials
cannot read or write project settings through it. No HTTP request in this work
was sent to the live coordinator.

## Design references and deliberate differences

Read the implementation brief, both design READMEs, the named board markup,
corresponding 1440/700 renders, ProjectPhone at 390, and the shared `dl-*` styles.
The live pages use the foundation components and tokens. `design/v2` is unchanged.

**Captures are blocked, so visual parity and browser interactions remain unverified.**
The headless capture command aborted with `bootstrap_check_in … Permission denied`.
No computer use or desktop browser fallback was attempted. See `captures.md` for
all exact URLs, widths, heights and pairing commands, and `capture-attempt.log`.
The fixture server is committed. No implementation images exist to inspect or pair.

Deliberate differences from the boards:

- Projects: rows summarize actual app counts, addresses and health; branch, PR count
  and age are not fabricated from missing list metadata. Fixture pantry/Immich are
  available by direct URL without adding them to the Projects board's four rows.
- Project: work counts and release counts derive from returned records. There is no
  invented “waiting on you” count, computer assignment, additions/deletions, or PR
  summary. Apps is hidden for one app, following the explicit build rule even
  though the Project board shows “Apps 1”. The isolated fixture has three releases,
  not a fabricated weekly total of fourteen.
- OneAppProject: the live health contract supplies requests and latency, but no
  memory series or origin activity. The page omits invented sparklines and “created
  from a folder” history, and adds an actual Add an app action. Release history uses
  the project Release records.
- Code: file metadata uses returned dates and commit subjects. README is rendered
  from the repository. The Clone button copies the actual HTTP clone URL; file
  preview uses an accessible modal. No keyboard-shortcut claim is added.
- Issues: Open and Closed counts use actual records. Unsupported Scout provenance,
  PR-closing relationships and tags are omitted. Associated tasks are links; issues
  without tasks remain readable rows. Dedicated issue detail is not implemented.
- App and ImmichApp: app pages have exactly Overview and Settings, as the settled
  brief requires, overriding the boards' project/four-tab navigation. Health is the
  real Live contract; absent CPU, memory usage, library size, uptime, activity and
  catalog update metadata are not invented. The warning uses its actual summary.
  Catalog version updates, connecting repositories and raising a suggested limit
  require later catalog/runtime integrations; no pretend buttons are shown.
- AppSettings: project configuration is linked. Domains, health checks and placement
  are displayed from available contracts; editing them remains manifest/placement
  work. Memory limit uses the existing PATCH endpoint. Domain-add, app removal and
  computer-move controls are omitted because this slice adds no corresponding safe
  project-aware mutation contract.
- Logs: app membership is the filter boundary. The board includes services and
  home-gym errors inside deploy.local's project log; the implementation does not
  mix another project's logs. The existing streams provide a tail, not time-window
  queries, so “Last hour” is omitted. The API provides no structured service/level/
  timestamp union; source app is separate and original log text is preserved.
- ProjectSettings: secret rows say “set” plus the actual last-updated time, never
  masked stand-ins for a fetched value. The repository source/branch is read-only.
  Approval policy links to the Approvals page. Retention and removal controls are
  omitted because those contracts are not implemented here. Verify is displayed as
  release behavior, not a toggle that could silently disable verification.
- SecretEdit: a replacement opens with an empty password input; no reveal button or
  previous value exists. Scope is All apps or a single app, matching the API's
  optional `app` contract. Existing scope is fixed so replacing cannot accidentally
  leave an old secret behind. Delete secret is available. Saving applies on the
  next release; “Save and restart” is omitted in favor of project release semantics.
  The `editSecret` query parameter opens the named secret for the fixture/deep link.
- General Settings is a navigation/account landing page only. Appearance, SSH-key,
  passkey, device and sign-out parity belong to the broader Settings/account work.

## Remaining integration and limits

- The releases page is owned by another slice and still builds its own tabs, links
  Apps to the first app, and does not offer the complete Ship dialog. This slice's
  “Ship…” link goes to project Releases. Reuse `projectTabs`/`projectPath` there when
  integration permits; the Vite rewrite already fixes its literal dotted links.
- Project variables feed the **declared deploy.yaml configuration resolver**. An
  arbitrary new name still needs a declaration/environment reference in deploy.yaml.
  Existing site-scoped values and historical revision values remain in their old
  store, with their validation and resolution intact; this UI cannot edit sites.
- Legacy untyped `env_vars` are preserved and copied conservatively as encrypted
  values, but legacy container recreation still reads its original settings through
  `server/store.ts`/`server/api.ts`, outside the permitted mutation boundary. It is
  not yet wired to consume new project edits. Existing legacy API exposure is not
  changed by this slice. Finish that adapter before promising project-edit behavior
  for legacy, non-graph apps; typed graph apps use the new resolver now.
- Persisted settings do not rewrite immutable manifests. Invalid types/allowed
  values are rejected by the existing runtime declaration validator. General
  deletion of ordinary variables and selecting multiple individual apps in one
  operation are not implemented (shared defaults and single-app overrides are).
- Membership migration seeds the current legacy manifest link; it does not invent
  extra workers. Add the second owned app through POST `/apps`. Existing remote
  release/runtime limitations from slice 4 remain unchanged.
- The native client should consume Project.apps and use a stable project ID in
  URLs. No Project or Release contract changes are required for multiple apps.

## Verification

The evidence logs are retained beside this note; repeated identical port-fallback lines in the
first full-suite log are collapsed with an explicit repetition count.

- `pnpm install --frozen-lockfile`: passed. No dependency or lockfile change; the
  tracked pnpm cache database was restored after install.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with warnings, no errors. Includes existing warnings and the
  surrounding code's error-variable shadowing style in the new client modules.
- `pnpm format:check`: passed.
- `pnpm build`: passed after the final UI changes.
- `node --test server/v2/projects.test.ts server/application-configuration.test.ts
  server/v2/releases.test.ts server/v2/releases-runtime.test.ts`: **32 passed, 0
  failed**, including 7 new project tests. Covers real repository-link migration,
  multi-app attachment, encrypted value migration, standalone-app transfer, shared
  defaults/app overrides/deletion, owner isolation, API redaction, atomic variable
  writes, release fencing, dotted names, conditional tabs and log filters.
- Actual Vite HTTP requests returned 200 for literal
  `/dashboard/projects/deploy.local/code` and encoded
  `/dashboard/projects/deploy%2Elocal/apps/deploy%2Elocal/settings`. The returned RSC
  payload matched the expected project route and decoded identity. Dev SSR logs the
  pre-existing `workspace-icons.json?ssr` parse problem and falls back to the client.
- `node docs/evidence/v2/5-projects/production-routing.mjs`: **14/14 passed** through
  the built production router, in memory with no listener. Literal and encoded dots
  cover overview, code, issues, app, app settings, logs and project settings. The
  shared production renderer emits existing React key/localStorage warnings.
- Final `pnpm test`: **683 tests; 655 passed, 4 failed, 11 cancelled, 13 skipped**,
  exit 1. This suite is **not green**. `full-suite.log` contains the complete final
  output. The failures are in unchanged files:
  - `server/ca-profile.test.ts`: two failures; system OpenSSL does not support the
    requested hostname-verification flag, and the correction test expects an
    exception that is not thrown.
  - `server/catalog-api.test.ts`: Home Assistant readiness is false with Docker
    unavailable under the test isolation.
  - `server/legacy-preserving-update.test.ts`: fsync test assumes Linux
    `/proc/self/fd`, which does not exist on this macOS host.
  - All eleven `server/application-api.test.ts` cases cancel during startup after
    `UND_ERR_SOCKET` / “other side closed” on the temporary listener. Earlier slices
    record the same environment/startup cancellation; this run did not separately
    rebuild the base commit to re-establish a baseline.
- An initial full-suite run had the same totals but a different startup failure:
  concurrent build output replacement plus a port collision caused the application
  API startup to fail. The final run was repeated after the build and after stopping
  both preview processes. `full-suite-first.log` retains that first result with
  repeated identical port-fallback lines collapsed and counted.

Full-suite isolation used a fresh temporary `DEPLOY_DATA_DIR`, a fixture-only Docker
executable that exits unsuccessfully, an unavailable Docker socket, and the existing
`docs/evidence/v2/1-inbox-api/test-guard.mjs` preload. It constrains TCP/UDP listeners
to 5180–5199 and bounds each test file. This changes the test environment, not
production code, and explains why the result is reported with cancellations rather
than as a clean pass. Only this slice's preview/test processes were stopped.
