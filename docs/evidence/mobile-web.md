# Mobile web evidence

Branch: `codex/mobile-web`. Changes are uncommitted and confined to `app/` and `docs/`. No native files, server code, API definitions, dependencies, commits, pushes or deployments were changed.

## Pages and flows

| Surface                                                        | Phone changes below 640 px                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared workspace                                               | Hidden activity rail; four bottom tabs reuse its routes and glyphs, with safe-area padding and current-page semantics. Account/provider usage, Settings and Sign out are available from the profile button. CompactTopBar replaces breadcrumbs and Commands text with a one-line ellipsized title, optional context line, Back and palette search.                                              |
| Tasks                                                          | Phone entry opens the task list. Full-row resource links show project, actual task status and update time. Filtering and the project drawer remain available. New task is the primary top-bar action.                                                                                                                                                                                           |
| New task                                                       | Full-width title, docked composer with safe-area padding, project chip opening the existing drawer, and a computer chip opening a worker popover with actual online/offline dots. Existing model, effort, voice and worker-setup recovery remain.                                                                                                                                               |
| Task conversation                                              | Tabs disappear. Title and project/computer/status have separate rows. Conversation / Changes / Checks share a segmented control. Long user messages fold at roughly six rendered lines; Show more / Show less preserves mounted text. Existing task execution context is read-only. Computer-use remains an icon action in the top bar.                                                         |
| Task Changes / Checks                                          | File chips navigate to real file sections and show counts from the parsed patch. Added-file mode/hunk rows become New file. Sticky file headers, unbordered code, real gutters, default wrapping, optional horizontal scroll and an edge fade. Bottom actions are Back to chat and the real Checks summary. Local Run check remains only where already supported. No merge/PR action was added. |
| Applications                                                   | Phone ResourceRows replace table headers and cells, showing runtime status and available live metrics. Selection is behind Edit; destructive actions are behind a menu and the existing confirmation. Filtering and catalog entry remain.                                                                                                                                                       |
| Application detail                                             | Compact top bar with runtime status and real Open action. Overview / Deployments / Logs / Activity / Settings become scrolling section chips.                                                                                                                                                                                                                                                   |
| Deployment history                                             | Vertical ResourceRows select existing build output with the supported selected query parameter. Status, timestamp and duration come from recorded logs. Output and pagination remain available.                                                                                                                                                                                                 |
| Computers                                                      | Scrolling section chips; ResourceRows reveal the existing computer details, with real inventory/status. Revocation is in a row menu using the existing confirmation. Worker setup and enrollment sections remain mounted.                                                                                                                                                                       |
| Settings / design reference / catalog / application management | Context sections become scrolling chips under the compact top bar. Settings forms stay mounted. New compact-component specimens appear only at phone width in the reference.                                                                                                                                                                                                                    |
| Repository library / repository                                | Existing filters and project sections become phone chips below CompactTopBar. The repository work pane uses the full width after the rail disappears; existing repository operations remain.                                                                                                                                                                                                    |
| Runtime/placement notices                                      | One severity-ranked disclosure retains the original messages and recovery link. Docker notices appear on affected runtime surfaces; placement notices appear on application/catalog creation surfaces. Settings, tasks and repositories do not receive these unrelated notices.                                                                                                                 |

## Components and behavior

Added shared exports in `@/components/ui`: `CompactTopBar`, `NoticeRow`, `ResourceRow`, `ContextChip`, and `CollapsibleMessage` (plus the `Notice` type). Phone composition lives in `app/routes/dashboard/phone-workspace.css`. The existing WorkspaceRail supplies both desktop navigation and phone tab destinations. Review Checks aggregation is a pure helper with tests preventing fabricated success.

Desktop controls and views remain mounted, with new composition scoped below 640 px. F6 handles the phone navigation/context/work regions, horizontal section controls accept arrow keys, project drawer focus containment/Escape/restoration remains, and native popovers retain dismissal. No motion was added. Forced-colors resource selection and the existing focus outlines remain.

## Validation

All requested scripts passed using the installed tools:

| Command                                                                                                                              | Result                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `pnpm --pm-on-fail=ignore --config.use-node-version= typecheck`                                                                      | Passed                                                                                                      |
| `pnpm --pm-on-fail=ignore --config.use-node-version= lint`                                                                           | Passed, with existing repository warnings; design literal guard and native palette parity guard both passed |
| `pnpm --pm-on-fail=ignore --config.use-node-version= build`                                                                          | Passed, including server extras; existing transformWithEsbuild deprecation warning                          |
| `npx oxfmt --check .`                                                                                                                | Passed; npm warns that the existing use-node-version project setting is not an npm setting                  |
| `node --import tsx --test app/routes/dashboard/{task-review,task-diff,task-resource,repository-navigation,transcript-index}.test.ts` | Passed: 11 tests                                                                                            |
| `node --test app/routes/dashboard/phone-workspace.test.mjs`                                                                          | Passed: 5 cascade regression tests at 375/390/430/639 px and desktop boundaries                             |
| `git diff --check`                                                                                                                   | Passed                                                                                                      |

The installed pnpm is 11.25.0 and the repository pins 11.1.3. Plain pnpm commands initially failed trying to verify/download the pinned version through the unavailable registry. The command-line options above skip that version switch and the Node download without changing `.npmrc`, the manifest, or lockfile. Tests use the installed tsx loader because one existing navigation test has extensionless imports; a direct Node test invocation failed on that import before the loader-based run passed. No dependency installation or network access was needed.

## Limits and remaining verification

- **Follow-up rendered review supplied by the user:** desktop application overview is pixel-identical to the previous build; Applications differs by 0.12% from its live sparkline. The supplied `.review/mw-sheet1.png` and `.review/mw-sheet2.png` exposed the broken phone layout. That review predates the cascade correction below.
- **No browser screenshots were possible in this sandbox.** Playwright found the installed Chromium executable, but launch failed with `bootstrap_check_in … Permission denied (1100)` / `mach_port_rendezvous_mac.cc` before a page could open. Browser interaction, visual comparison at 390 × 844 and ≥640 px, light/dark/forced-colors rendering, keyboard traversal, safe-area behavior, and real iOS Safari keyboard/zoom still need an external browser pass. Static checks and a production build do not establish pixel parity.
- The application inventory exposes current rates and resource metrics, not a 24-hour request total. Rows report the real available values or unavailable text; no 24-hour claim was fabricated.
- Existing tasks have no supported project/computer reassignment operation in this UI. Their composer context chips are read-only; new tasks provide both pickers.
- File +/− counts describe the available parsed patch. Existing truncation, binary and unavailable notices remain; this does not claim a complete patch when the backend truncates it.
- No supported merge or PR operation exists in this task review surface, so its footer offers Back to chat and Checks only.

## Follow-up: order-independent phone cascade

The review sheets show content placed in the legacy 48/52 px track. The original phone root selectors tied `native-workspace.css` in specificity: `.project-workspace` was `(0,1,0)` and its `:is(...)` state variants `(0,2,0)`. The later stylesheet could therefore restore two/three desktop columns while phone children still requested column 1. Several child visibility/placement rules had the same order dependency. Import order in a build manifest was not a sufficient fix.

The shell now always has `data-phone=""`. Only the existing `<640 px` media query activates it. Every phone selector is anchored to `.project-workspace[data-phone]`; root state variants have specificity `(0,3,0)`, above the legacy `(0,2,0)`. Direct child placements and state visibility are explicit, and phone descendant rules also receive the scope so a later native rule cannot restore vertical chips, desktop headers or narrow panes. There are no changes to the desktop CSS. The title now uses one-line ellipsis; its full text and title attribute remain. Tabs use four equal grid columns, and “Repos” retains `aria-label="Repositories"`.

### Final shell composition at 375, 390, 430 and 639 px

All direct children reset to column `1 / -1`, row `auto`, and `min-width: 0`, followed by these explicit state/placement rules. Hidden elements do not create tracks. Floating surfaces do not participate in grid sizing. Nothing uses a rail-width offset in phone flow.

| Element / state                                                        | Display and flex/grid                                                                                                  | Final column; row                              | Sizing / placement                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.project-workspace[data-phone]` in every route/state                  | `grid`; columns `minmax(0, 1fr)`; rows `auto auto minmax(0, 1fr) auto`; auto-flow `row`; auto-columns `minmax(0, 1fr)` | —                                              | width/max-width `100%`, min-width `0`, height `100dvh`, align/justify items `stretch`                             |
| `.workspace-rail`                                                      | `none`                                                                                                                 | `1 / -1`; `auto`                               | no rail track                                                                                                     |
| `.compact-top-bar` directly in shell                                   | `block`                                                                                                                | `1 / -1`; `1`                                  | stretches across column; action row flex, title nowrap/ellipsis; full title remains accessible                    |
| `.phone-task-segments` (existing task only)                            | `flex`; buttons `flex: 1`                                                                                              | `1 / -1`; `2`                                  | Conversation / Changes / Checks                                                                                   |
| `.ds-context-sidebar` on management surfaces except application detail | `flex`, direction `row`; nested links `flex`, row, nowrap                                                              | `1 / -1`; `2`                                  | static, inset auto, transform none, width auto, max-width 100%, horizontal overflow; links width auto / flex none |
| `.ds-context-sidebar` on application detail                            | `none`                                                                                                                 | `1 / -1`; `auto`                               | replaced by local application section chips                                                                       |
| `.pw-sidebar:not(.ds-context-sidebar)` project drawer, closed          | `none`                                                                                                                 | `1 / -1`; `1 / -1`                             | absolute, left/top/bottom 0, width min(320px, viewport − 44px)                                                    |
| Same drawer with `.show-sidebar` in task views                         | `flex`, direction `column`                                                                                             | `1 / -1`; `1 / -1`                             | overlay; Tab/Escape/focus restoration retained                                                                    |
| `.ds-sidebar-resizer`                                                  | `none`                                                                                                                 | `1 / -1`; `auto`                               | no divider track                                                                                                  |
| `.pw-sidebar-scrim` when rendered                                      | `block` with `.show-sidebar`, otherwise `none`                                                                         | `1 / -1`; `1 / -1`                             | absolute; inset 0                                                                                                 |
| `.ds-task-list` (rendered for Tasks list)                              | `flex`, direction `column`                                                                                             | `1 / -1`; `3`                                  | width 100%, min-height 0, local overflow auto                                                                     |
| `.pw-chat` in new task / conversation                                  | `flex`, direction `column`                                                                                             | `1 / -1`; `3`                                  | width 100%, min-height 0, overflow hidden                                                                         |
| `.pw-chat` in management, repositories, Tasks list or review           | `none`                                                                                                                 | `1 / -1`; `3`                                  | conversation stays mounted                                                                                        |
| `.pw-context` with `.has-inspector`                                    | `flex`, direction `column`                                                                                             | `1 / -1`; `3`                                  | width 100%, height 100%, min-height 0, overflow hidden; review body scrolls, footer flex none                     |
| `.pw-context` otherwise                                                | `none`                                                                                                                 | `1 / -1`; `auto`                               | no hidden review track                                                                                            |
| `.pw-surface` on management routes                                     | `flex`, direction `column`                                                                                             | `1 / -1`; `3`                                  | width 100%, min-height 0; content and dashboard chain min-width 0 / max-width 100%                                |
| `.pw-surface` on application detail                                    | `flex`, direction `column`                                                                                             | `1 / -1`; `1 / 4`                              | local application top bar/chips/work live inside this surface; no duplicate outer header                          |
| `.pw-project-hub.repository-workspace`                                 | `grid`; columns `minmax(0, 1fr)`; rows `auto minmax(0, 1fr)`                                                           | `1 / -1`; `2 / 4`                              | width 100%; internal navigation col 1 / −1, row 1; work col 1 / −1, row 2                                         |
| `.workspace-tabs` outside task flow                                    | `grid`; columns `repeat(4, minmax(0, 1fr))`; gap 0                                                                     | `1 / -1`; `4`                                  | width 100%, min-width 0, border-box; 4px side padding, bottom includes safe area                                  |
| `.workspace-tabs` inside task/new-task flow                            | `none`                                                                                                                 | `1 / -1`; `4`                                  | composer/review uses bottom safe area                                                                             |
| `.wr-account-popover`                                                  | closed: UA `none`; open: block in top layer                                                                            | reset `1 / -1`; `auto`, irrelevant out of flow | fixed, inset 12px 12px auto auto; native popover dismissal                                                        |
| `.pw-project-dialog`                                                   | closed: UA `none`; open: block in top layer                                                                            | reset `1 / -1`; `auto`, irrelevant out of flow | native modal dialog; existing form layout retained                                                                |
| `.pw-control-panel.pw-floating-viewer` (existing task only)            | `flex`, direction `column`, overridden by inline `display: none` when not revealed                                     | reset `1 / -1`; `auto`, irrelevant out of flow | existing fixed viewer / expanded overlay; no grid track                                                           |
| performance `<output hidden>`                                          | UA `none`                                                                                                              | `1 / -1`; `auto`                               | optional instrumentation; no grid track                                                                           |

The notice row is nested in `.dashboard-frame-root`, not a direct shell child: that wrapper is flex column, width/height 100%, min-width/min-height 0. The single NoticeRow is block / `flex: 0 0 auto`, width 100%; desktop notices and location chrome are hidden. The remaining `.dashboard-shell` is `flex: 1`, min-height 0. Application detail keeps its local top bar, horizontally scrolling section chips, and a flexible work body inside this surface. Native descendant selectors cannot reset these phone declarations because each now includes the attribute scope.

The composer is nested in `.pw-chat`, not a direct shell child. Transcript is `flex: 1 1 0`, min-height 0, overflow auto; compose area is `flex: 0 0 auto` with safe-area padding. In a new task the transcript is hidden and the compose area has an auto top margin. The composer grid explicitly places textarea at row 1 / both columns, project/computer chips at row 2 / both columns, model/voice controls at row 3 / column 1, and Send/Stop at row 3 / column 2. Code review instead flexes its scrollable body above the safe-area footer. No fixed rail column remains in either path.

At 375/390/430 px the tab grid has 367/382/422 px inside its 4px side padding, giving each tab approximately 91.75/95.5/105.5 px before the border-box details. All exceed 44px; labels are nowrap and bounded to the tab, with ellipsis as fallback. This arithmetic and the cascade tests do not measure actual font shaping.

### Every applicable authored grid/flex/display rule

The following inventory is generated from the actual stylesheets with `node scripts/mobile-web-cascade.mjs --inventory`. It includes losing rules, all route states above plus the open project drawer, and the 375/390/430/639 px viewport conditions. Selectors are restricted to those that match the root or a direct child. “Final values” are the resulting property values across matching fixtures; where several values occur, the state table above identifies the visible state. Grid/flex properties on hidden or out-of-flow nodes remain computed but do not allocate tracks. UA and inline visibility are called out separately above.

<!-- mobile-cascade-inventory -->

- `app/routes/dashboard/workspace.css:2` — `.project-workspace`.
  Declares `display: grid`; `grid-template-columns: 54px 240px minmax(0, 1fr)`.
  Final: `display: grid`; `grid-template-columns: minmax(0, 1fr)`.

- `app/routes/dashboard/workspace.css:36` — `.project-workspace.has-inspector`.
  Declares `grid-template-columns: 54px 240px minmax(0, 1fr) 310px`.
  Final: `grid-template-columns: minmax(0, 1fr)`.

- `app/routes/dashboard/workspace.css:167` — `.pw-sidebar`.
  Declares `display: flex`; `flex-direction: column`.
  Final: `display: flex or none`; `flex-direction: column or row`.

- `app/routes/dashboard/workspace.css:397` — `.pw-chat`.
  Declares `display: flex`; `flex-direction: column`.
  Final: `display: flex or none`; `flex-direction: column`.

- `app/routes/dashboard/workspace.css:1120` — `.pw-sidebar-scrim`.
  Declares `display: none`.
  Final: `display: block`.

- `app/routes/dashboard/workspace.css:1124` — `.project-workspace`, `.project-workspace.has-inspector`.
  Declares `grid-template-columns: 54px 226px minmax(0, 1fr)`.
  Final: `grid-template-columns: minmax(0, 1fr)`.

- `app/routes/dashboard/workspace.css:1130` — `.project-workspace`, `.project-workspace.has-inspector`.
  Declares `grid-template-columns: 54px 218px minmax(0, 1fr)`.
  Final: `grid-template-columns: minmax(0, 1fr)`.

- `app/routes/dashboard/workspace.css:1142` — `.project-workspace`, `.project-workspace.has-inspector`.
  Declares `grid-template-columns: 48px minmax(0, 1fr)`.
  Final: `grid-template-columns: minmax(0, 1fr)`.

- `app/routes/dashboard/workspace.css:1146` — `.pw-sidebar`.
  Declares `display: none`.
  Final: `display: flex or none`.

- `app/routes/dashboard/workspace.css:1149` — `.show-sidebar .pw-sidebar`.
  Declares `display: flex`.
  Final: `display: flex`.

- `app/routes/dashboard/workspace.css:1159` — `.show-sidebar .pw-sidebar-scrim`.
  Declares `display: block`.
  Final: `display: block`.

- `app/routes/dashboard/workspace.css:2061` — `.pw-control-panel`.
  Declares `display: flex`; `flex-direction: column`; `gap: 12px`.
  Final: `display: flex`; `flex-direction: column`; `gap: 0`.

- `app/routes/dashboard/workspace.css:2189` — `.pw-control-panel`.
  Declares `gap: 10px`.
  Final: `gap: 0`.

- `app/routes/dashboard/workspace.css:2237` — `.pw-control-panel.pw-control-viewer`.
  Declares `gap: 0`.
  Final: `gap: 0`.

- `app/routes/dashboard/workspace.css:2598` — `.project-workspace.has-surface`.
  Declares `grid-template-columns: 54px minmax(0, 1fr)`.
  Final: `grid-template-columns: minmax(0, 1fr)`.

- `app/routes/dashboard/workspace.css:2601` — `.has-surface > :is(.pw-chat, .pw-sidebar, .pw-context)`.
  Declares `display: none`.
  Final: `display: flex or none`.

- `app/routes/dashboard/workspace.css:2604` — `.pw-surface`.
  Declares `grid-column: 2`; `grid-row: 1`; `display: flex`; `flex-direction: column`.
  Final: `grid-column: 1 / -1`; `grid-row: 1 / 4 or 3`; `display: flex`; `flex-direction: column`.

- `app/routes/dashboard/workspace.css:2664` — `.project-workspace.has-surface`.
  Declares `grid-template-columns: 48px minmax(0, 1fr)`.
  Final: `grid-template-columns: minmax(0, 1fr)`.

- `app/native-workspace.css:81` — `.ds-sidebar-resizer`.
  Declares `display: none`.
  Final: `display: none`.

- `app/native-workspace.css:85` — `.project-workspace`, `.project-workspace:is(.has-surface, .has-inspector, .has-repository)`.
  Declares `grid-template-columns: 52px var(--ds-sidebar-width, 224px) minmax(0, 1fr)`.
  Final: `grid-template-columns: minmax(0, 1fr)`.

- `app/native-workspace.css:95` — `.project-workspace > .workspace-rail`.
  Declares `grid-column: 1`; `grid-row: 1`; `gap: 16px`.
  Final: `grid-column: 1 / -1`; `grid-row: auto`; `gap: 16px`.

- `app/native-workspace.css:111` — `.project-workspace > .pw-sidebar`, `.ds-context-sidebar`.
  Declares `grid-column: 2`; `grid-row: 1`.
  Final: `grid-column: 1 / -1`; `grid-row: 1 / -1 or 2 or auto`.

- `app/native-workspace.css:124` — `.project-workspace.has-surface > .ds-context-sidebar`.
  Declares `display: flex`; `flex-direction: column`.
  Final: `display: flex or none`; `flex-direction: column or row`.

- `app/native-workspace.css:128` — `.project-workspace.has-surface > .pw-sidebar:not(.ds-context-sidebar)`, `.has-task-list > .pw-chat`, `.has-inspector > .pw-chat`, `.has-repository > :is(.pw-sidebar, .pw-chat, .pw-context)`.
  Declares `display: none`.
  Final: `display: none`.

- `app/native-workspace.css:193` — `.pw-surface`, `.project-workspace > .pw-chat`, `.ds-work-pane`.
  Declares `grid-column: 3`; `grid-row: 1`.
  Final: `grid-column: 1 / -1`; `grid-row: 1 / 4 or 3 or auto`.

- `app/native-workspace.css:350` — `.ds-work-pane`.
  Declares `display: flex`; `flex-direction: column`.
  Final: `display: flex or none`; `flex-direction: column`.

- `app/native-workspace.css:442` — `.pw-project-hub.repository-workspace`.
  Declares `grid-column: 2/-1`; `grid-row: 1`; `display: grid`; `grid-template-columns: var(--ds-sidebar-width, 224px) minmax(0, 1fr)`.
  Final: `grid-column: 1 / -1`; `grid-row: 2 / 4`; `display: grid`; `grid-template-columns: minmax(0, 1fr)`.

- `app/native-workspace.css:570` — `.project-workspace:not(.has-inspector) > .pw-context`.
  Declares `display: none`.
  Final: `display: none`.

- `app/native-workspace.css:573` — `.project-workspace.has-inspector > .pw-context`.
  Declares `display: flex`; `grid-column: 3`; `grid-row: 1`; `align-self: stretch`.
  Final: `display: flex`; `grid-column: 1 / -1`; `grid-row: 3`; `align-self: stretch`.

- `app/native-workspace.css:854` — `.project-workspace`, `.project-workspace:is(.has-surface, .has-inspector, .has-repository)`.
  Declares `grid-template-columns: 48px minmax(0, 1fr)`.
  Final: `grid-template-columns: minmax(0, 1fr)`.

- `app/native-workspace.css:858` — `.pw-surface`, `.project-workspace > .pw-chat`, `.ds-work-pane`, `.project-workspace.has-inspector > .pw-context`.
  Declares `grid-column: 2`.
  Final: `grid-column: 1 / -1`.

- `app/native-workspace.css:864` — `.project-workspace > .pw-sidebar`, `.project-workspace.has-surface > .ds-context-sidebar`.
  Declares `display: none`.
  Final: `display: flex or none`.

- `app/native-workspace.css:876` — `.project-workspace.show-sidebar > .pw-sidebar`.
  Declares `display: flex`; `flex-direction: column`.
  Final: `display: flex`; `flex-direction: column`.

- `app/native-workspace.css:880` — `.pw-project-hub.repository-workspace`.
  Declares `grid-column: 2`; `grid-template-columns: 1fr`.
  Final: `grid-column: 1 / -1`; `grid-template-columns: minmax(0, 1fr)`.

- `app/native-workspace.css:916` — `.pw-project-hub.repository-workspace`.
  Declares `grid-template-rows: auto minmax(0, 1fr)`.
  Final: `grid-template-rows: auto minmax(0, 1fr)`.

- `app/native-workspace.css:1186` — `.project-workspace .pw-sidebar-scrim`.
  Declares `display: block`.
  Final: `display: block`.

- `app/routes/dashboard/workspace-rail.css:2` — `.workspace-rail`.
  Declares `display: flex`; `flex-direction: column`; `align-items: center`; `gap: 20px`.
  Final: `display: none`; `flex-direction: column`; `align-items: center`; `gap: 16px`.

- `app/routes/dashboard/phone-workspace.css:6` — `.phone-only`.
  Declares `display: none`.
  Final: `display: block or flex or grid or none`.

- `app/routes/dashboard/phone-workspace.css:58` — `.project-workspace[data-phone] .phone-only`.
  Declares `display: block`.
  Final: `display: block or flex or grid or none`.

- `app/routes/dashboard/phone-workspace.css:61` — `.project-workspace[data-phone] > .workspace-rail`.
  Declares `display: none`.
  Final: `display: none`.

- `app/routes/dashboard/phone-workspace.css:77` — `.project-workspace[data-phone] > *`, `.project-workspace[data-phone] > :is( .workspace-rail, .ds-sidebar-resizer, .wr-account-popover, .pw-project-dialog, .pw-control-panel, .pw-sidebar, .ds-context-sidebar )`.
  Declares `grid-column: 1 / -1`; `grid-row: auto`.
  Final: `grid-column: 1 / -1`; `grid-row: 1 or 1 / -1 or 1 / 4 or 2 or 2 / 4 or 3 or 4 or auto`.

- `app/routes/dashboard/phone-workspace.css:92` — `.project-workspace[data-phone]`, `.project-workspace[data-phone]:is(.has-surface, .has-inspector, .has-repository)`.
  Declares `display: grid`; `grid-template-columns: minmax(0, 1fr)`; `grid-template-rows: auto auto minmax(0, 1fr) auto`; `grid-auto-flow: row`; `grid-auto-columns: minmax(0, 1fr)`; `align-items: stretch`; `justify-items: stretch`.
  Final: `display: grid`; `grid-template-columns: minmax(0, 1fr)`; `grid-template-rows: auto auto minmax(0, 1fr) auto`; `grid-auto-flow: row`; `grid-auto-columns: minmax(0, 1fr)`; `align-items: stretch`; `justify-items: stretch`.

- `app/routes/dashboard/phone-workspace.css:106` — `.project-workspace[data-phone] > .compact-top-bar`.
  Declares `grid-column: 1 / -1`; `grid-row: 1`.
  Final: `grid-column: 1 / -1`; `grid-row: 1`.

- `app/routes/dashboard/phone-workspace.css:163` — `.project-workspace[data-phone] > :is(.pw-surface, .ds-task-list, .pw-chat)`.
  Declares `display: flex`; `flex-direction: column`.
  Final: `display: flex or none`; `flex-direction: column`.

- `app/routes/dashboard/phone-workspace.css:168` — `.project-workspace[data-phone] > .pw-context`.
  Declares `display: none`.
  Final: `display: flex or none`.

- `app/routes/dashboard/phone-workspace.css:171` — `.project-workspace[data-phone]:is(.has-surface, .has-repository, .has-task-list, .has-inspector) > .pw-chat`, `.project-workspace[data-phone]:is(.has-surface, .has-repository, .has-task-list) > .pw-context`.
  Declares `display: none`.
  Final: `display: none`.

- `app/routes/dashboard/phone-workspace.css:176` — `.project-workspace[data-phone].has-inspector > .pw-context`.
  Declares `display: flex`; `flex-direction: column`.
  Final: `display: flex`; `flex-direction: column`.

- `app/routes/dashboard/phone-workspace.css:181` — `.project-workspace[data-phone] > :is(.pw-surface, .ds-task-list, .pw-chat)`, `.project-workspace[data-phone].has-inspector > .pw-context`.
  Declares `grid-column: 1 / -1`; `grid-row: 3`.
  Final: `grid-column: 1 / -1`; `grid-row: 1 / 4 or 3`.

- `app/routes/dashboard/phone-workspace.css:187` — `.project-workspace[data-phone] > .workspace-tabs`.
  Declares `display: grid`; `grid-template-columns: repeat(4, minmax(0, 1fr))`; `gap: 0`; `grid-column: 1 / -1`; `grid-row: 4`.
  Final: `display: grid or none`; `grid-template-columns: repeat(4, minmax(0, 1fr))`; `gap: 0`; `grid-column: 1 / -1`; `grid-row: 4`.

- `app/routes/dashboard/phone-workspace.css:196` — `.project-workspace[data-phone] .workspace-tabs`.
  Declares `align-items: stretch`.
  Final: `align-items: stretch`.

- `app/routes/dashboard/phone-workspace.css:234` — `.project-workspace[data-phone].is-task-flow > .workspace-tabs`.
  Declares `display: none`.
  Final: `display: none`.

- `app/routes/dashboard/phone-workspace.css:237` — `.project-workspace[data-phone].has-application > .ds-context-sidebar`.
  Declares `display: none`.
  Final: `display: none`.

- `app/routes/dashboard/phone-workspace.css:240` — `.project-workspace[data-phone].has-application > .pw-surface`.
  Declares `grid-row: 1 / 4`.
  Final: `grid-row: 1 / 4`.

- `app/routes/dashboard/phone-workspace.css:275` — `.project-workspace[data-phone].has-surface:not(.has-application) > .ds-context-sidebar`.
  Declares `display: flex`; `flex-direction: row`; `grid-column: 1 / -1`; `grid-row: 2`.
  Final: `display: flex`; `flex-direction: row`; `grid-column: 1 / -1`; `grid-row: 2`.

- `app/routes/dashboard/phone-workspace.css:314` — `.project-workspace[data-phone] > .pw-sidebar:not(.ds-context-sidebar)`.
  Declares `display: none`; `grid-column: 1 / -1`; `grid-row: 1 / -1`.
  Final: `display: flex or none`; `grid-column: 1 / -1`; `grid-row: 1 / -1`.

- `app/routes/dashboard/phone-workspace.css:324` — `.project-workspace[data-phone] > .ds-sidebar-resizer`.
  Declares `display: none`.
  Final: `display: none`.

- `app/routes/dashboard/phone-workspace.css:327` — `.project-workspace[data-phone] > .pw-sidebar-scrim`.
  Declares `display: none`; `grid-column: 1 / -1`; `grid-row: 1 / -1`.
  Final: `display: block`; `grid-column: 1 / -1`; `grid-row: 1 / -1`.

- `app/routes/dashboard/phone-workspace.css:334` — `.project-workspace[data-phone].show-sidebar > .pw-sidebar-scrim`.
  Declares `display: block`.
  Final: `display: block`.

- `app/routes/dashboard/phone-workspace.css:337` — `.project-workspace[data-phone].show-sidebar:not(.has-surface, .has-repository) > .pw-sidebar:not(.ds-context-sidebar)`.
  Declares `display: flex`; `flex-direction: column`.
  Final: `display: flex`; `flex-direction: column`.

- `app/routes/dashboard/phone-workspace.css:348` — `.project-workspace[data-phone] > .pw-project-hub.repository-workspace`.
  Declares `display: grid`; `grid-template-columns: minmax(0, 1fr)`; `grid-template-rows: auto minmax(0, 1fr)`; `grid-column: 1 / -1`; `grid-row: 2 / 4`.
  Final: `display: grid`; `grid-template-columns: minmax(0, 1fr)`; `grid-template-rows: auto minmax(0, 1fr)`; `grid-column: 1 / -1`; `grid-row: 2 / 4`.

- `app/routes/dashboard/phone-workspace.css:538` — `.project-workspace[data-phone] .phone-task-segments`.
  Declares `display: flex`; `grid-column: 1 / -1`; `grid-row: 2`.
  Final: `display: flex`; `grid-column: 1 / -1`; `grid-row: 2`.

<!-- /mobile-cascade-inventory -->

### Follow-up regression coverage

`app/routes/dashboard/phone-workspace.test.mjs` reads the real CSS via already-installed PostCSS and selector parsers. It evaluates selector specificity, unlayered versus layered precedence, media conditions and source order. It checks both normal/reversed legacy order with the phone stylesheet first and last, all route states, 375/390/430/639 px, the project overlay, title/chips/rows/notices, composer placement, and the inert attribute at 640/760/1280 px. These are cascade assertions, not a browser rendering or layout engine. Existing targeted tests for navigation, resource reads, transcript grouping, parsed diffs and actual check results are rerun as well.

## Rendered review

Checked outside the sandbox against a seeded demo coordinator (the visual-audit seed, with its retired portable-site rows removed) using Playwright:

- First pass: at 390 px every dashboard page collapsed into the 52 px first grid track because the desktop grid rule in `native-workspace.css` won on stylesheet order. Corrected with the `data-phone` scope, explicit child placement and cascade tests.
- After the correction, at 390 × 844 in dark: Applications, Tasks/new task, application overview, settings and deployments, Computers, and Settings render with the compact top bar, one notice row, scrolling chips, full-width resource rows and a four-column tab bar. 14 captures, no browser errors.
- Desktop: application overview is pixel-identical to the previous release; Applications and Computers differ by under 0.2% (live sparkline and metric values).
- Not rendered: task conversation and code review on a phone (the demo seed has no tasks), 375/430 px widths, and light mode on a phone.
