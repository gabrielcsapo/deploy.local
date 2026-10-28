# Slice 5 · projects, apps, logs and settings

Implemented project/content tabs, multi-app membership and migration, app Overview/
Settings, streamed project logs, and encrypted project settings with app overrides.
Dotted names work through the dev rewrite and production router. Only the assigned
routes and files changed, plus the minimal Vite fix required by the task.

[Implementation and API details](implementation.md) document migration behavior,
contracts, tests and remaining integration. [Capture handoff](captures.md) lists
all eleven boards at 1440/700, exact URLs/heights, and the pairing commands.

**No implementation screenshots or pairs exist.** Headless Chromium failed with
`bootstrap_check_in … Permission denied`; visual parity and browser interactions
remain unverified. The fixture server and failed capture log are committed. The
reference renders, markup, styles and read-only ProjectPhone board were inspected.
No desktop browser or computer-use tools were used. `design/v2` was not changed.

## Deliberate differences

- **Projects:** actual app counts, addresses and health replace unavailable branch,
  PR-count and age metadata. No values are fabricated.
- **Project:** counts derive from returned records. Missing work provenance,
  additions/deletions and inbox totals are omitted. Apps appears only with a second
  app, following the build rule despite the board's “Apps 1”. Apps uses `?tab=apps`
  because no separate list route exists. The fixture has three recent releases.
- **OneAppProject:** no invented memory series, sparklines or folder-origin history.
  Recent activity is project release history. Adds a working Add an app action.
- **Code:** actual repository dates/subjects and README; Clone copies its HTTP URL,
  files open in an accessible modal, and no unsupported shortcut is advertised.
- **Issues:** actual open/closed counts, task links and issue creation. Scout tags,
  PR-closing relationships and provenance absent from the response are omitted.
  Issues without an associated task remain readable rows, without a detail page.
- **App / ImmichApp:** exactly Overview and Settings, overriding the older boards'
  project/four-tab navigation. Uses real Live health and project release history.
  Missing CPU, memory usage, library size, uptime and activity are not invented.
  Catalog update/connect-repository actions remain for the catalog slice.
- **AppSettings:** links project configuration; displays available address, health,
  placement and memory limit. Memory can be saved. Domain-add, placement changes
  and removal are omitted because no project-aware mutation is added for them.
- **Logs:** app membership bounds sources; another project's lines are never mixed
  in. The legacy streams supply a tail, so “Last hour” is omitted. Original text
  remains intact with its source app; level filtering is textual. Adds Reconnect.
- **ProjectSettings:** secrets say “set” and show last-updated time, never values.
  Repository fields are read-only, approvals link to their page, and Verify is
  shown as release behavior. Unsupported retention/removal controls are omitted.
- **SecretEdit:** empty password input, no previous-value/reveal control; All apps
  or one app matches the API's optional `app`. Existing scope stays fixed. Adds
  Delete secret. Saving applies on the next release; no Save and restart action.
  `?editSecret=<key>` supports direct links and the capture fixture.
- **General Settings:** account identity and navigation only; full appearance,
  SSH-key, device, passkey and sign-out parity is outside these named boards.

## Verification

- Frozen dependency install, typecheck, lint (warnings only), format and build pass.
- Focused project/configuration/release tests: **32 passed, 0 failed**.
- Two real Vite dotted-route requests returned 200; all **14 production dotted-route
  checks passed**, with both literal and encoded names. Existing dev SSR JSON
  parsing and shared production renderer warnings are recorded in the details.
- Final full suite: **683 tests: 655 passed, 4 failed, 11 cancelled, 13 skipped**.
  Failures are in unchanged CA-profile, Home Assistant readiness and macOS
  `/proc/self/fd` tests. Application API cases cancelled after a startup socket
  failure. These areas are also recorded by earlier slices; no fresh base-commit
  comparison was run. The full suite is not green.
- Tests used temporary data, unavailable Docker and the earlier slice's port guard.
  Both preview processes were stopped. No live service or container was changed.

## Next slice

- Reuse `projectTabs` / `projectPath` in Releases when ownership permits. That page
  still links Apps to its first app. The new Ship… link goes to project Releases;
  the complete Ship flow belongs to the task/release work.
- Project edits feed declared deploy.yaml configuration. Names still need manifest
  declarations/references. Site-scoped and historical values remain intact in their
  old stores. Legacy untyped environment values are copied encrypted, but the legacy
  container adapter still reads its original per-app settings; wiring that adapter
  needs changes outside this slice's allowed boundary. Existing legacy API exposure
  is unchanged. Do not promise new project-edit behavior for non-graph apps yet.
- Add an app attaches an existing owned app. New-app creation remains the Ship flow.
  Historical standalone releases do not move when its app joins another project.
- iPhone can use the unchanged `Project.apps` contract and stable IDs. See the
  [implementation/API notes](implementation.md) for the new settings/log endpoints.

## Visual review (added by the orchestrating session)

All rows in `captures.md` were captured with the fixture and Vite on 5195/5196, and paired at 1440 and 700 (`<Board>-<width>.png`, board left). Raw dotted URLs (`/dashboard/projects/deploy.local/...`) return 200 in dev.

The structure matches: tabs, overview, releases list, variables and secrets, repository, and logs. Differences to polish:

- **Overview:** the stat cards lack their subtext ("2 running · 1 waiting on you", "#18 ready to merge"), and the Work rows lack state glyphs, times and diff counts.
- **Settings:**
  - Rows lack their icons, and secret rows show a raw timestamp instead of "set 9 days ago".
  - The Releases settings rows render as text, not the board's controls (Ask me chip, keep-N stepper, Verify migrations switch).
  - The Remove section is missing.
- **Logs:** error rows aren't highlighted, the filters stack with labels instead of the board's inline row, and there's an extra app column on single-app filters.
