# Workspace design system

The reviewed system is implemented in the web application. `app/design-tokens.json` is the shared contract for color, metric identity, type, form sizes, spacing, motion, composition, keyboard behavior, and supported labels. Run `node scripts/build-design-tokens.mjs` after changing it; `app/design-tokens.css` is generated. `app/native-workspace.css` composes the persistent React workspace and its existing controls.

Landing, documentation, sign-in and workspace share the platform's system font (SF Pro on Apple devices, Segoe UI on Windows, the desktop UI font on Linux) and its monospace (SF Mono, falling back to the bundled JetBrains Mono), matching the native apps and the Codex app's reading comfort, quiet violet-biased neutrals and solid violet actions. All Tailwind color utilities resolve to the generated semantic tokens; there is no separate marketing or legacy operations palette. The landing page has a floating Docs / Dashboard launcher, while dashboard routes use the activity rail. Public chrome responds to client navigation and cannot remain attached to the dashboard.

Desktop uses a 52 px global rail, a resizable context sidebar (224 px default, 180–420 px bounds, preserving at least 360 px for work), and a work pane that fills the rest. Resource lists, tables, source, diffs and logs stay in the work pane. Context sidebars own the project/task tree, repository sections, application sections, settings categories and computer navigation. At phone widths below 640 px, the rail becomes one bottom tab bar and local sections become scrolling chips; Tasks uses a full-width project/task tree. Tablet and desktop composition at 640 px and above stays unchanged. A 56 px location header names the current resource and holds its immediate actions. Task conversations use one title row: folder glyph, title, small recorded status, and an end-aligned icon cluster for computer use, Changes, Activity and More. Project and computer names are in the title tooltip and More; Mark done / Reopen are confirmed menu actions. Every dashboard route uses the shared `WorkspaceTitleBar`: section glyph and title, or a quiet linked section prefix followed by the item name, then an end-aligned icon action cluster with Search commands. The narrow sidebar toggle remains first. Search opens the command palette and ⌘K remains available. No breadcrumbs or bordered Commands button. Primary actions and quiet search/filter fields belong in the body directly below the title bar, aligned with the content column. Native item pages use the principal toolbar slot rather than an extra content heading. Avoid repeated headings, descriptions and global links.

`data-appearance="plain"` supports borderless toolbar entry. Pair it with `.ds-input-shell` for an icon and input, or use it on an input inside an already bounded row. It is transparent, with no enclosing border or raised shadow; focus uses an accent underline. Default settings/form fields retain their boundaries. Touch entry is 44 px with 16 px text. Labels remain associated with inputs; errors include text, and forced colors retain visible focus.

Metric roles (`--metric-cpu`, `--metric-memory`, `--metric-traffic`, `--metric-latency`, `--metric-other`, `--metric-comparison`, `--metric-threshold`, `--metric-event`) name measurements. Health is a separate status. Row order and high CPU/memory values never change a measurement's identity color.

Repository browsing uses actual Git branch, folder, history and source endpoints, plus an owner-scoped Task source listing the project’s tasks with workspaces by title and status. Task browsing reads the live working copy, including untracked files and deleted-path placeholders, with explicit Added, Modified and Deleted labels. Changes offers a View file text link into that task and path. Remote workspaces state “Files are on <computer>; open Changes to review them”; they do not imply that uploaded diffs provide file access. The work pane has a 56 px resource header, 24 px desktop / 16 px compact inner insets, a branch/history/file-finder toolbar, latest-commit strip and a quietly bounded directory table. Name, Last commit, Updated and Size read real metadata. Directory history work is bounded to 200 entries with four concurrent reads and immutable commit/path caching. A rendered README follows the listing, with safe relative links into the same repository. History opens commit diffs; source offers syntax highlighting, line numbers, Markdown/image preview, Copy, Raw and Download when content is available. Preview remains bounded to 256 KiB; binary/large omissions stay explicit. Native source uses tabular line-number gutters, semantic-token highlighting for JS/TS/Swift/JSON/YAML/Markdown, and a wrap toggle; iPhone wraps by default and turning wrapping off enables horizontal scrolling. Native New task opens the existing composer with the project, branch or task reference, and path as context. Go to file indexes at most 10,000 committed paths, pins the selected revision, supports T and Escape, and returns focus on dismissal. Clone uses the hosted HTTPS path with account authentication. New task pins the selected commit and passes the selected path as context. Keep all resource content in the right pane and preserve reading positions per repository, branch and resource.

Task navigation starts with deploy.local and a search/notifications icon cluster, then a New task row (⌘N). Search opens inline on click or ⌘K in task navigation; the command palette remains available on other routes. Notifications filters the same real tasks to those needing an answer, approval or review. Projects are single folder rows, followed by a flat Recents list of the eight most recently updated tasks across projects. Show more exposes the full list. A project expands inline to its five newest tasks, then Show more. Expansion is device-local and changes only through a project disclosure. Selecting a task never expands a project or adds a row to its preview; expanded projects stay expanded. Search matches task titles and project names, expands matching groups temporarily and clearing it restores expansion. A running project or task has one spinner; a task needing a person has one attention glyph, which takes precedence. There are no routine status dots. Inactive rows use secondary text. Selection fill and aria-current appear once: on a visible task in an expanded project, otherwise in Recents. The duplicate Recents row uses ink only. Project disclosure chevrons appear on hover/focus for empty projects and stay visible while a project is expanded or holds tasks (a collapsed project whose tasks are all closed is otherwise indistinguishable from an empty one), rotating 90° when expanded. Children animate their height using standard motion; reduced motion is immediate. New task, projects and tasks share their fill radius and inset. Rows are navigation type, 32 px on desktop and at least 44 pt on touch, with no underlines. Project + appears on hover/focus and stays visible on touch. Recents and project tasks share selection, accessible full titles/status/age, and keyboard navigation. The phone keeps its native List with the same Projects/Recents organization. Empty workspaces and no-match states keep their existing recovery actions. Repository hubs stay under Repositories. With no task selected the work pane is the new-task composer; Changes and Checks render as tabs beneath the same persistent task title bar. The project glyph, title, status and computer/Changes/Activity/More cluster stay in place across views; Changes is pressed during review. Toggling Changes or Escape returns to conversation. Conversation stays mounted across management routes, with drafts keyed by task. Task start and continuation use the same 720 px reading/composing axis, with 24 px desktop / 16 px compact outer insets. New tasks and conversations dock the composer at the same bottom position and width. The empty space above holds a small secondary monochrome brand glyph and “What should we build in <project>?” in normal-weight display type; the project name opens the project picker. With no project, use “What should we build?”. All message inputs use “Ask, build, or follow up…”, including while queueing. An attached context tray uses the darker sidebar surface, shares the composer border and top radius, and holds the project and computer pickers. Existing tasks show plain read-only project/computer labels in the same tray. Attach, voice, model and send remain in the bottom toolbar; on phone the model-only sheet remains available and context stays above the prompt. The toolbar scrolls horizontally within the prompt at narrow widths. The prompt is a solid, quietly bordered surface with a 16 px radius and natural multiline growth; never stretch an empty textarea to fill the pane. Native uses its corresponding reading-width limit with the same alignment principle. Code review fills the right pane with separate Changes and Checks views, including actual local checks and remote checkpoint jobs. File links navigate to real per-file diff sections with independent old/new line gutters; retain Git metadata and binary/unavailable notices honestly. At normal or narrow widths review replaces the transcript while retaining it mounted; a wide native workspace may show independently scrollable conversation and review panes. F6 cycles between navigation, context and work; arrows/Home/End navigate contextual links and resource controls without intercepting text editing or console scrolling. Focus is visibly distinct from selection. Compact context traps Tab and closes with Escape.

Loading, empty and error components share a compact inline row. Recovery stays next to the affected content. Never invent networks, environment names, backup guarantees, usage quotas, capabilities, model catalogs or successful operations. Production controls continue to use backend data and real APIs; static prototype data and simulation controls are not part of the application.

Work panes respond to their own width through container queries. Application inventory uses the shared list template; measurements live on the application detail page. Deployment history uses a 260 px list beside output in a wide pane, and a compact horizontal history strip above output in a narrow pane. Issues and pull requests use the full pane while composing, and collapse their list while reading details in a narrow pane. Settings categories keep their forms mounted while switching, so unsaved values remain available.

The Changes view renders its file diffs directly rather than hiding the code inside a closed disclosure. The Checks view keeps command output expandable and locally scrollable. Review layout is active only in the task review view; switching to repository or management views cannot leave the review pane covering the new resource. Unregistered Terminal and Storage actions are omitted, and build/progress links use the registered Deployments route. Deployment-history and log loading failures expose Retry; obsolete responses from previously selected resources are ignored.

Computer inventory distinguishes deployment runtimes from task workers. The task-worker status reads the existing workspace inventory and links to Settings → Providers for the app-managed ordinary-user task worker. An online deployment runtime alone never enables the task composer. This is a real operational requirement; the UI never fabricates an available agent.

## Compact layouts (below 640 px)

Phone composition is scoped to `@media (width < 640px)` and `.project-workspace[data-phone]` in `app/routes/dashboard/phone-workspace.css`. The shell always carries the attribute; the media query alone activates the rules. The attribute increases phone selector specificity above legacy selectors, including state-specific grids and child placements, so stylesheet load order cannot restore desktop tracks. At 640 px and above the existing rail, context sidebar/drawer, tables, location headers and review presentation remain in use. Do not change the shared tokens to achieve a phone-only layout.

One bottom `nav` provides Tasks, Repositories, Applications and Computers using the rail's existing destinations, `WorkspaceIcon` glyphs and `aria-current`. It occupies its own full-width grid row with four equal `minmax(0, 1fr)` columns (the phone label “Repos” retains the full accessible name “Repositories”) and includes `env(safe-area-inset-bottom)`. Tasks opens the task list on phones. A profile button opens the existing account/provider popover, including Settings and Sign out; dismissal restores focus. Inside a task or new-task composer, hide the tab bar and reserve the safe area for the composer or review footer.

`CompactTopBar` from `@/components/ui` replaces phone breadcrumbs and command labels. Back navigation, search (opening the existing command palette), and at most one immediate action occupy a control row. The title has the full width on one line with an ellipsis and its complete text retained accessibly; the optional context row stays on one horizontally scrollable line. Task context contains the project, execution computer and real status. Application context uses the real runtime status. Keep all touch controls at least 44 × 44 px; phone inputs use the phoneBody token, above Safari's 16 px zoom threshold.

Section strips (repository sections, application sections, settings categories, filter chips) stay on one horizontally scrolling line with the `ui-scroll-strip` class: no visible scrollbar, and an edge fade on whichever side has more content (CSS scroll-driven animation; browsers without it show no fade). Never wrap a strip into several rows of chips. Without a back target the phone title row leads with the section glyph and title; global navigation is the tab bar, so it shows no sidebar toggle. On a repository the title row carries Back and the repository name, so the hub does not repeat a “Repositories” row above the section strip.

`NoticeRow` folds related notices into a native disclosure labeled “N notices”, using the most severe status tone. Expanding reveals the original message and recovery links in place. Docker connectivity notices belong to application/runtime surfaces, while default-computer placement notices belong to application creation/catalog surfaces; neither appears on unrelated settings or task pages. Preserve desktop banners. Never stack global banners above phone content.

`ResourceRow` is a full-row link with a name, secondary identity line, `StatusBadge`, one summary line, and chevron. Applications use `ListRow` with their URL and exceptional status; computers show reported inventory; deployment history shows recorded duration. Unavailable measurements remain explicit. The current application inventory has no 24-hour request count, so a zero current request rate must not become “No requests in 24 h”. Application bulk selection is behind Edit, and deletion/revocation is behind a row menu with the existing confirmation dialog. Computer rows reveal the existing inventory detail; deployment rows select actual recorded output.

Application sections (Overview, Deployments, Logs, Activity, Settings), computer sections, settings categories, and repository sections become horizontally scrolling chips. Task Chat / Changes / Checks use one three-way control. The new-task project ContextChip selects from real projects without leaving the composer. The computer `ContextChip` opens a native popover of real workers with status dots; execution context for an existing task is read-only because there is no reassignment action here. Keep provider/model controls and worker recovery links available. `CollapsibleMessage` folds user messages exceeding roughly six rendered lines, preserves the mounted content, and provides Show more / Show less; keyboard focus entering its content expands it.

Phone review uses changed-file chips with addition/removal counts computed from the available patch and links to each file section. Sticky file headers replace bordered cards. For added files, a New file chip replaces the mode and hunk rows; edits retain hunk headers, and binary/unavailable/truncated messages stay visible. Real old/new line gutters remain. Code wraps by default; the horizontal-scroll toggle restores local scrolling with an edge fade and a focusable code region. The three-way control returns to Chat; do not duplicate Back to chat in a footer. The compact verdict reports the latest result per check, keeping local coordinator checks unchanged. Only recorded successful checks/jobs can produce Passed; missing, cancelled or unavailable results cannot. Local Run check remains in Checks where the existing backend supports it; there are no invented merge or PR actions.

F6 continues cycling navigation, context and work, including phone controls. Context chips/tabs support arrows and Home/End without intercepting text input or code scrolling. Compact navigation drawers retain Tab containment and Escape dismissal. Existing global reduced-motion and forced-colors behavior remains in force; phone resource selection and focus stay distinct.

## Live reference and implementation

Open **Settings → Design system**, or search **Design system** in the command palette (`⌘K` / `Ctrl+K`). The route is `/dashboard/design-system`. It renders `app/design-tokens.json` and the shared application components directly, including metric mappings, bordered and plain inputs, focus states, recovery states, and copyable React/Tailwind recipes.

For new UI, import controls from `@/components/ui`:

```tsx
import { Button, TextField, Metric } from '@/components/ui';

<TextField label="Filter computers" appearance="plain" type="search"
  value={filter} onChange={(event) => setFilter(event.target.value)} />
<Button variant="primary" onClick={save}>Save changes</Button>
<Metric signal="cpu" label="CPU">{cpu ?? 'Unavailable'}</Metric>
```

`StatusBadge` pairs a dot with a sentence-case `label` and accepts `tone="active" | "attention" | "healthy" | "failed" | "inactive"`. Inactive uses a hollow dot. Blue active means work in progress; amber attention means a person must act; green healthy means running/online/succeeded; red failed means failure; neutral inactive means offline/not running/unavailable. Task execution and application runtime states map separately: a working task is active while a running container is healthy.

`Button` accepts native button props and `primary`, `secondary`, `quiet`, `danger`, or `link` (see Action hierarchy). It defaults to `type="button"`; set `type="submit"` for forms. `TextField` requires a label, supports native input props, `bordered` (default) or `plain` appearance, and an associated `error`. Plain fields retain an accessible hidden label. `Metric` requires a labeled signal (`cpu`, `memory`, `traffic`, `latency`, or `neutral`); provide the unit or unavailable value explicitly. Existing `LoadingState`, `ErrorBanner`, `EmptyState`, `ConfirmDialog`, and `Toggle` are re-exported from the same entry point.

Use semantic Tailwind classes for layout and presentation: `bg-bg`, `bg-bg-surface`, `bg-bg-elevated`, `text-text`, `text-text-secondary`, `border-border`, `bg-action`, `text-on-action`, and `text-metric-cpu` / `text-metric-memory` / `text-metric-traffic` / `text-metric-latency`. These are mapped in `app/theme.css` to the generated variables; never introduce a second palette in a page.

To change the system, edit `app/design-tokens.json`, run `node scripts/build-design-tokens.mjs`, update shared primitives in `app/components/ui`, and extend the live specimens. Verify the affected application views and the reference at compact and desktop widths, with keyboard focus and both system appearances; then run `pnpm typecheck` and `pnpm build`. Do not hand-edit generated CSS. This reference has no runtime save endpoint: changes ship through the normal React application build.

`StatCard` is available from the same UI entry point for analytics summaries. Pass `signal` to use the metric palette; latency percentile lines use solid p50, dashed p95 and dotted p99 patterns rather than health colors.

The context divider supports pointer dragging, Left/Right (Shift for 32 px steps), Home/End bounds and double-click reset. Width persists across routes and reloads. Compact layouts hide the divider. Phones use the navigation and composition rules below; wider compact panes retain their existing navigation arrangement.

Use `Select` from `@/components/ui` with a visible label or `aria-label`. It keeps native keyboard/type-ahead and form behavior. Its popup uses shared surface, edge, selection and focus tokens in browsers supporting customizable selects; other browsers use their operating-system picker with the same themed trigger. Do not hide it underneath a second imitation control.

Documentation and this reference ship inside the running app at `/docs` and `/dashboard/design-system`. The separate GitHub Pages application and publishing workflow have been removed.

Computer context links select a dedicated right-pane section rather than scrolling a stacked page. Sections remain mounted so enrollment drafts and expanded inventory rows survive navigation. Inventory disclosures have a visible chevron and keep native keyboard behavior.

Data dialogs use the `tableDialog` width token (880 px maximum). Tables retain their `tableMinimum` width (720 px), with horizontal scrolling confined to a named, keyboard-focusable region on compact screens. Numeric transfer totals use neutral metric color; success colors remain reserved for status.

Catalog rows expose one full-row link. Installation readiness comes from the selected live computer check; static release examples must never appear as current computer readiness. Activity labels use readable names, reserved width and truncation so an action cannot overlap its application name. Route-level fetch failures offer Reload and Open workspace recovery.

`Toggle` separates its 44 × 24 px track from the 44 px compact touch target. The track cannot shrink in a crowded row or stretch into a tall pill; selection, thumb, hover and focus use semantic tokens. Unavailable model options remain readable on the shared popover surface. Direct links into the design reference restore their target after the client view mounts.

## Spacing and motion

Full-size panes have breathing room inside them: use `size.workspaceInset` (24 px desktop), `size.compactInset` (16 px), `size.navigationRow` (40 px), `size.resourceRow` (56 px), and `size.sectionGap` (32 px). Resource text is 13 px with quiet horizontal separators. Application identity precedes status and measurements; overview context and its secondary action share one strip instead of separate stacked toolbars. Avoid cell grids, repeated bordered cards and decorative page grids. Source, diffs and logs retain dense line spacing and local scrolling.

`motion` in `app/design-tokens.json` owns duration (ms), easing, distance (px) and scale (unitless). The generator emits `--ds-motion-duration-*`, `--ds-motion-easing-*`, `--ds-motion-distance-*` and `--ds-motion-scale-*`. `app/motion.css` applies them to shared controls, switches, dialogs, popovers, native select popups, disclosures and compact context drawers. Feedback is 120 ms, state change 180 ms, overlay entry 220 ms and drawer entry 240 ms. Exit is 140 ms for surfaces that remain mounted; React dialogs that unmount close immediately so focus restoration never waits.

Use `ds-motion-enter` for a surface revealed by an action, or `motion-safe:animate-surface-enter` in Tailwind. Use `transition-colors duration-motion-fast ease-motion-standard` for new controls. Shared Button, Toggle, Select and ConfirmDialog already consume the contract. Never use `transition: all`, animate entire routes or rows, animate streamed text, or smooth sidebar resizing and scroll restoration.

The global reduced-motion preference removes animation and transitions, including portal dialogs and native picker surfaces, resets movement/press tokens, and preserves immediate state and focus. It is a root-level rule, not restricted to workspace descendants. The live **Motion** section at `/dashboard/design-system#design-motion` includes token values, replayable surface entry, disclosure and real dialog specimens, plus copyable React/Tailwind recipes.

Pane dividers stay neutral and stationary. A compact horizontal resize icon appears at the center on hover, during dragging, or with keyboard focus; only the icon has an accent focus ring. Never turn the whole divider into a colored scroll/progress track. Scrollable source, file lists and diff views use a dashed inset focus boundary, keeping focus distinct from a scrollbar.

## Shared iconography

`app/workspace-icons.json` owns product glyph geometry: a 24-point grid, 1.6-point strokes, round caps and joins. React `WorkspaceIcon` reads it directly; `node scripts/build-workspace-icons.mjs` generates native `WorkspaceGlyph.generated.swift` with scalable SwiftUI paths. Run with `--check` to detect stale native output. Do not hand-edit generated geometry or substitute SF Symbols for an existing product glyph. Platform-owned back buttons, disclosure controls and platform-specific status symbols retain native behavior.

Use `WorkspaceIcon` from `@/components/ui` on web and `WorkspaceGlyph(name: .compose, size: 18)` in SwiftUI. The native toolbar, activity rail, common search/folder/compose symbols and repository controls consume these glyphs. Give the enclosing control an accessible action label; decorative paths are hidden. Glyphs inherit text or selected-state color, and never animate independently.

`navigation` is the left sidebar toggle. `review` is the diff document for changes and tools. Keep these distinct. `sidebar` remains a compatibility glyph; new navigation controls use `navigation`. See the live specimen at `/dashboard/design-system#design-icons` for the complete set and copyable usage.

## Repository library and settings

The activity rail opens `/dashboard/repositories`, a searchable library with All repositories, Hosted here and Imported context filters. Repository rows are full-row links; names, descriptions and import sources come from the authenticated project inventory. Keep search plain inside its toolbar, display a useful no-match state with Clear filters, and preserve the search and reading position when returning from a repository. Never auto-open the first repository.

Repository workspaces use `/dashboard/repositories/:projectId`; local sections have durable suffixes (`issues`, `pulls`, `pipelines`, `deployment`, `settings`). The context sidebar has a return link to the library and section links, including Settings, rather than a repository switcher. Settings edits the saved display name and short description and shows real clone, default-branch and import/setup information. Save uses an owner-scoped, idempotent command and a settings revision; stale edits require reloading saved values. Keep drafts when switching local sections. Metadata edits must preserve Git paths, repository IDs, source configuration and running operations.

## Action hierarchy

Every surface — a header, panel, dialog, composer or empty state — offers one clear next step. Rank each action before choosing its style, and style by rank, not by importance to the code:

1. **Primary**: the action the surface exists for (Send, Connect, Create pull request, Merge, New task in an empty workspace). A solid `primary` button. At most one per surface.
2. **Secondary**: a real alternative someone may choose instead of the primary, such as Run checks beside Merge. A bounded `secondary` button, placed beside the primary. At most one, and never on its own.
3. **Tertiary**: labelled tertiary actions, including Cancel in dialogs, Show more / Show less, Mark done / Reopen, Sign in again inside a notice, Clear search and Add repository in an empty state. Underlined text with `Button variant="link"` on web and `.workspaceLink` natively. No fill, no border and no box, so it cannot compete with the primary. Destructive tertiary actions (Disconnect) use `.workspaceDangerLink` and are confirmed when they lose data.
4. **Utility actions**: use the quiet icon actions below.
5. **Repeated row actions**: the per-project +, row menus and disclosure chevrons. Icon-only, muted until hover or focus (always visible on touch), with an accessible name.

Navigation is a link or row, never a button. Do not add a button where a tertiary link or a row tap will do; if a surface seems to need two primaries, it is two surfaces. Labelled tertiary action links use quiet `secondary` text with no underline at rest; on hover or focus they turn `ink` and show a 1 px underline offset 3 px (as in the Codex app). Disabled links never underline. Content links, including links in prose, use the readable `accent` token and underline only on hover/focus. Navigation and turn summary labels never underline.

## Control heights and toolbar rows

Bordered controls that share a row share one height: `Button`, `Select` and `TextField` are `size.desktopControl` (36 px) everywhere, phones included. Drawing them at 44 px made every row look oversized. On a coarse pointer a `Button` keeps a 44 px (`size.touchControl`) target through an invisible hit area that extends past its edges, and text fields use 16 px text so iOS doesn't zoom on focus. List rows, menu rows and the terminal key bar are the places a full 44 px height stays visible. Borderless `IconButton`s keep their own 28/32/44 targets. Menu rows use `size.overlayRow` (38 px) and 44 px on touch. Native macOS controls use `WorkspaceStyle.Control.compact` (`size.compactControl`, 32 pt) for buttons and inputs alike, iOS uses `Control.touch`, and both use the `form.radius` corner; `check-native-token-parity.mjs` enforces this.

A resource toolbar is one row: the scope picker and browsing aids first, then the resource actions at the end, the primary last. When the pane is narrow, browsing aids (refresh, history, find) move into an `OverflowMenu` instead of wrapping onto more rows; the picker takes the remaining width. Keyboard shortcut hints use `<kbd className="ui-kbd">` (or Tailwind `pointer-coarse:hidden`) so they disappear on touch devices, which have no keys to press.

## Actions and iconography

Use shared icon actions for dismiss/close, collapse/expand, copy, external/open in a new window,
show in context (jump), refresh/retry, overflow (more), wrap toggles, resize affordances, back,
filter/sort in dense toolbars, and pin. Preserve native navigation and separator semantics.

Text stays for the primary action (Deploy, Merge, Open pull request, Send), destructive confirmations
(Delete, Revoke, with danger styling), dialog choices (Cancel / Confirm / Done), unfamiliar or
ambiguous actions, and inline prose links. Icon + text is allowed when a secondary label adds
meaning, such as + New task. Menu items keep their labels so choices remain recognizable.

Use `IconButton` with required `label` and `icon`, `CopyButton` for clipboard actions, and
`ActionCluster` for related actions on web. Native uses `WorkspaceIconButton` and
`WorkspaceCopyButton`. Compact targets are 28 px with 14 px glyphs; default targets are 32 px
with 16 px glyphs; touch/phone targets are 44 pt with 18 pt glyphs. Sizes come from shared tokens.
Quiet actions have no border, hover fill `hover`, pressed/selected fill `selected` and accent
glyphs, a visible focus ring, and tertiary disabled glyphs. Danger utility actions use danger
color; destructive confirmations always retain text.

Every action has an accessible name and matching tooltip (`title` on web, `.help` on Mac), with
its shortcut appended when available. Toggles expose `aria-pressed` or native selected traits
and an On/Off accessibility value. Copy swaps to a check and politely announces “Copied” for
about 1.5 seconds; a failed clipboard write exposes selectable text without claiming success.

Related actions form an end-aligned cluster with 2 px gaps. Close is rightmost; collapse directly
precedes it. Keep contextual labels in the content rather than repeating them beside each glyph.
Show all jobs is a quiet text-and-chevron row because its scope benefits from a label.
The live reference at `/dashboard/design-system#design-actions` demonstrates states and sizes;
the icon grid includes every glyph at both 14 and 16 px.

## Composers and forms

Creating or editing work never uses a stock settings form. Composers follow two references:
Linear's issue composer (a borderless title, a quiet multiline description and metadata chips inside one
bounded surface, with a single solid action) and GitHub's compare view (branch tokens with an honest
ahead/behind verdict and the real diff before anything is created). Settings and sign-in keep
bordered, labeled fields; composers are for authoring.

- **Composer surface** (`ReviewPanel`): one bounded surface per screen, `surface` fill, 1 px `line`
  border, 14 pt radius and a faint shadow. The border shifts to a soft accent while the title is
  focused. Do not stack several bordered cards; secondary content (commits, files, activity) stays on
  the canvas under `ReviewSectionHeading`.
- **Title**: `title3` semibold, plain, 1–3 lines, focused on appear. Placeholder names the record
  (“Pull request title”, “Issue title”). A pull request suggests the single commit's subject (or the
  branch name) until the person types; it never overwrites their text.
- **Description**: body text, plain, grows from 5 lines (4 on phones) and scrolls past 16; Markdown is
  noted in a dashed, unset chip rather than helper copy.
- **Metadata chips** (`ComposerChip`): capsules in one horizontally scrolling row. Set chips use a soft
  `selected` wash; unset chips are dashed outlines with secondary text (“Link a task”). Each chip opens a
  native menu; values come from real records only.
- **Branch tokens** (`BranchToken`): monospaced branch name on a `raised` 8 pt chip with a branch symbol;
  as a picker it adds an up/down chevron and opens a native menu. The compare bar reads
  “Merge [source] into [target]” and wraps the two halves on narrow widths.
- **Verdict line**: an icon + sentence from real history — “2 commits ahead of main. Can fast-forward
  merge.” (healthy), “1 ahead, 1 behind main. Rebase …” (attention), “main already contains everything on
  …” (inactive). While comparing, a small progress indicator and “Comparing …”. Failures say so.
- **Footer**: the reason the action is unavailable sits at the leading edge (“Add a title.”), then Cancel
  (quiet) and one primary action (“Create pull request”). ⌘Return submits and Escape cancels on macOS;
  on phones the primary action expands to the full width when the row cannot fit.

Native button variants mirror the web `Button`: `.workspacePrimary` (solid `action`, `onAction` text),
`.workspaceSecondary` (surface with `line` border), `.workspaceQuiet` (accent text) and
`.workspaceDanger`; tertiary actions use `.workspaceLink` / `.workspaceDangerLink` (quiet text, underlined on hover/press, no
surface). Buttons are 30 pt tall on macOS and 44 pt on touch, with a 10 pt radius, hover and
pressed states from the motion contract, and disabled colors from `hover`/`tertiary`.

## Review: tasks, pull requests and issues

Task review, pull requests and issues are one continuous flow and share components:
`ReviewDiffList`/`FilePatchView` for changed files (with +/− counts on every platform),
`PipelineRunView` for checks, merge results and pipeline runs (each job names the computer it ran on,
and a deployment row shows the application, release and failure), `ReviewTimeline` for description,
comments and the comment composer (the same prompt surface as a task), and `ReviewStateBadge` for state.

- **Header**: back link (wide layouts), `#number`, state badge, title (`title2`), then branch tokens
  `source → target` and “author opened/merged 5m ago”. Edit and Close/Reopen live in a trailing ••• menu.
- **State**: Open is attention, Merging is active, Merged is healthy, Closed is inactive, and a failed or
  unknown merge is failed. Merging appears the moment Merge is confirmed and stays until the coordinator
  records the merge, so a pull request never flashes back to Open.
- **Pull request**: Overview / Changes / Checks. Overview opens with the merge panel: check result
  (“Checks passed · Ran on macbook-pro”), mergeability and the actions — Run checks (secondary) and
  Merge into main (primary, confirmed with a native dialog that states the consequence). Mergeability
  is fast-forward, a clean merge commit when the target moved on, no new commits, or a refusal that
  names its cause: the conflicting files, or the required checks that have not passed. Merge is only
  disabled alongside that reason, never silently. After merging, the panel shows the target commit and
  the push pipeline that merge started, live, with its deployment, plus View pipeline.
- **Issue**: same header and activity; its panel lists linked tasks and offers Start task.
- **Task → pull request**: Changes shows the branch `task/<short-id>`, an inline editable title and Markdown description,
  with one primary “Publish as pull request” action. Publishing builds a commit from the recorded task
  diff in the hosted repository and opens its linked pull request. It never asks for an existing source
  branch. The project hub retains New pull request for hand-pushed branches.
- **Updates**: a linked open pull request shows its recorded state and branches. “Update pull request”
  is primary only when the workspace contains unpublished changes; otherwise it is an inactive text
  link. Each update adds a commit to the same branch and queues the existing push checks. A merged
  task shows Merged with no publish action. Empty, unavailable or truncated diffs, unready workspaces,
  and active runs or checks cannot publish; a branch that moved under the task is refused with what
  the owner can do about it — merge or revert those commits, or start a new task from its tip.
- **Return path**: pull requests opened from task Changes retain the task as their origin on web,
  macOS and iOS. Back, Cancel, Escape and dismissal return there, including after publishing; they do
  not open the project's pull request list. Offer one return path: on pushed iOS screens, the system
  back button reads “Task”; sheets on macOS and web headers use one back icon named “Back to task”.
- **Titles**: prompt-derived task titles and task-derived pull request titles use the first line,
  shorten at a complete word, omit a trailing standalone number, and append “…” when shortened.
- **Publish defaults**: derive the title from the first user message using the shared word-boundary
  helper. Preserve an edited task title unless it is a truncated prefix of that message. Prefill the
  editable description with the latest final agent summary, recorded checks and jobs, and “Task: title”.
  Workspace file links become plain repo-relative paths. Missing results say Not run. Updating an
  existing pull request preserves its description and adds an activity note with the changed file count.
- **Published tasks**: the server derives a linked pull summary from pull request records. An open pull
  shows “In review · PR #n” with the active tone in task lists, headers and From task rows; the task
  header links to that pull request. Merged tasks retain their merged lifecycle status.
- Only recorded results produce Passed, Merged or Released. Missing, cancelled or earlier-commit checks
  never read as passing.
- **In the conversation**: `#3`, `PR #3`, `pull request #3` and `issue #2` in a message (outside code)
  resolve against the project's real records (issues and pull requests share one number sequence). Each
  record gets one live `ConversationReviewCard`, under the latest message that mentions it, spanning the
  same reading column as the composer. A pull request card shows state, branches, the check result with
  the computers that ran it, mergeability and Run checks / Merge (with the same confirmation); a merged
  one shows the target commit, the push pipeline and the deployment. An issue card shows its tasks and
  Start task. Every card has Open for the dedicated view. The task's linked pull request is pinned above
  the composer as a quiet capsule (`ConversationReviewStrip`) that expands into the same card in place.
  Cards poll only while something is in motion.

## Iterating on a task

- **File links in replies**: agents link files as absolute worker paths (`/…/tasks/<taskId>/web/a.mjs:12`).
  Any link inside the task workspace maps to its repository path and line and opens Changes scrolled to
  that file, with the line marked when the diff contains it. A file outside "This turn" switches to All
  changes. A file without changes says so plainly (“README.md has no changes in this task.”) with a
  View file link to the task's working copy; a listed file without a text diff says its diff isn't
  shown. External links
  keep opening in the browser.
- **This turn / All changes**: a two-way choice above the changed files. This turn diffs the checkpoint
  the worker captured when the latest turn started against the one captured when it ended (or the live
  workspace while a local turn runs, “So far, since this turn started”). Remote computers upload the
  turn diff when the turn ends. Without real checkpoints the view shows all changes and the
  coordinator's reason (“This is the first turn, so this shows all changes.”).
- **Following**: sending or queueing a message scrolls to it and resumes following, so the reply stays
  in view as it streams. Scrolling away stops following until Jump to latest.
- **Queueing**: while a turn runs, Send queues one follow-up on the coordinator, shown above the composer
  as “Queued, sends when this turn ends” with the message and a Cancel link. Every device sees the same
  queued message. It sends automatically after a successful turn. If the turn fails or is stopped it is
  held instead: the text returns to the draft and the row says why (“Not sent because the turn was
  stopped. It’s back in your draft.”) with a Dismiss link. On the web, while text is typed during a
  turn, Stop sits beside the primary Send as the secondary action.

## Agent control requests

When an agent asks to drive the task browser or a desktop window, the request appears in the conversation above the composer, where the agent is waiting: what it will control, on which computer, that its screenshots appear in the conversation, and when the request expires. Allow is the primary action and Not now a link; for the task browser a second link, "Always allow the task browser in <project>", also turns on the repository's standing permission. While a request is pending, the task reads "Needs your approval" in the attention tone in lists and headers, ahead of review and working states.

Repository settings → Agent control holds that permission ("Always allow the task browser"). With it on, requests for the headless task browser are approved automatically and recorded as approved by the project setting; desktop (window) control always asks.

Ended control sessions keep their last frame desaturated and dimmed with the `opacity.endedFrame` token (native `endedFrameOpacity`). A centred, accessible reason and the single primary **Start again** action replace input and ownership actions; the status reads “Ended”. With no frame, use the same recovery in the empty viewer. Restart revalidates the original worker and target, takes user ownership and inspects once active to capture a fresh frame. Unavailable targets disable restart and explain why; server errors stay beneath the button for retry.

## Project workspace modal

The project sheet (Files, Issues, Pull requests, Pipelines) uses the same composition as the main window:
a 216 pt context rail on the `sidebar` color with the project identity at the top and rows matching the
task sidebar (navigation type, primary text, a secondary glyph that turns accent when selected, a 7 pt
`selected` fill, 30 pt rows on macOS). The work pane opens with a 56 pt location header: back (when
inside a record or composer), the section or composer title, one `.workspacePrimary` create action and a
toolbar-style close button. There is no bottom button bar and no stock `Done`/prominent toolbar button.

## Token literal guard

`pnpm lint` runs `scripts/check-design-literals.mjs` and `scripts/check-native-token-parity.mjs`. Product CSS/TS/TSX cannot contain local pixel font sizes, arbitrary Tailwind pixel type sizes, numeric RGB colors or hex colors. The only file exemption is generated `app/design-tokens.css`. Edit the JSON contract and regenerate it instead. Existing `font` shorthand and inline `fontSize` literals are checked too.

Typography utilities (`text-display`, `text-title`, `text-section`, `text-body`, `text-conversation`, `text-meta`, `text-caption`, `text-navigation`) map directly to the shared roles. Standard Tailwind type utilities also resolve to those roles. Source, diff and log content uses `type.code` (12 px), with log zoom calculated relative to that token; public landing/docs displays may use `type.hero` (64 px). Ordinary labels never fall below caption (11 px). Forms reference the type roles, including phoneBody (17 px) for touch entry.

Action uses a saturated fill with white onAction; selected/accentSoft stay soft. Disabled buttons use hover and tertiary tokens with full opacity. `actionHover` is separate from the readable `accentHover` used for links. Native mirrors the ladder, action and five statuses in `WorkspaceStyle.swift`; the parity manifest names every checked mapping, including legacy aliases. DeployUI fonts use Dynamic Type styles with weights and monospaced designs retained.

## Attachments and media

The composer keeps Send as its single solid action. Attach is a quiet paperclip icon in the toolbar,
with an accessible name; removing draft media is an icon action. Paste, drop and media pickers
upload immediately. Removable thumbnails stay above the text, and drafts retain uploaded attachment
ids until sent. Uploads show byte progress and a Cancel upload icon action; failures stay visible. Never imply media was sent before it
has an attachment id.

Sent images use small, authenticated thumbnails in the conversation. Agent media stays with its run;
computer-use frames form a disclosure labeled with the actual screenshot count after run activity.
Retain at most one frame per action and the newest 50 per session. Opening media presents a modal
with every image and video in the task, in transcript order, across runs. Mac and iPad use an overlay inside
the workspace window, never a separate window or Space. Web uses a modal dialog with a dimmed
backdrop (`shadow` with `opacity.overlay`). iPhone uses a large system sheet with the native
swipe-down dismissal gesture. Preserve normal transcript scrolling and restore keyboard and
accessibility focus to the opening thumbnail when dismissed.

Keep the header visible while media zooms or pans: “3 of 5”, caption/name, then quiet Markup (when
available for an image), Share/Download and Close icon actions. Close is always last. Centre fitted
media between the header and filmstrip. Large touch-size Previous/Next icons sit at the horizontal
edges, vertically centred, and disable at the ends. Left/Right and Home/End navigate; Escape closes.
Touch paging and Mac horizontal trackpad gestures navigate at fit scale. Pinch, double-click/tap and
wheel zoom reset on selection; leaving a video pauses its player. Keep the selected thumbnail visible
in the horizontally scrolling filmstrip, highlight it with accent and selection semantics, and allow
click/tap to jump. Hide the strip for a single item. Label media “Image 3 of 5: caption” (or “Video”),
and give every control an accessible name. Backdrop clicks and the close action dismiss the modal.
Use the shared enter duration/easing/scale for overlay entry; reduced motion removes animation.
Missing media stays explicitly unavailable without preventing navigation or dismissal.

The viewer header (beside Share on iPhone) and every composer image chip offer a quiet
“Mark up” action. The editor has pen, arrow, rectangle and text-label tools, undo/redo and clear.
Use accent, attention and failed palette tokens, and the Fine/Medium/Broad markup width tokens.
iPhone pen input uses PencilKit; Mac and web use pointer-driven geometry. Marks use normalized
image coordinates and export at the oriented source image's native pixel dimensions, independent
of display size or screen scale. Text labels are placed by tapping or dragging on the image.

“Attach to message” is the editor's single solid primary action; Cancel stays text; recognizable utilities use quiet icon actions.
Flatten to PNG and upload through authenticated task attachments with source `user` and caption
“Marked-up <original name>”. Add the uploaded image to that task's saved composer draft, dismiss
the editor and viewer, and focus the message field. Keep the original image and any other draft
chips. Cancel leaves the draft unchanged; upload errors preserve marks for retry. The iPhone
message field keeps its normal one-to-six-line growth below attachment chips.

Use shared palette, spacing and typography tokens. Media endpoints always require account or scoped
run authentication; do not create public image URLs. Native images use the authenticated DeployCore
cache, partitioned by coordinator, account and credential. Images accept content-sniffed PNG, JPEG,
GIF and WebP up to 20 MB each. Thumbnails currently serve original bytes for client downscaling.
Task media defaults to a 200 MB budget, configurable with `DEPLOY_TASK_MEDIA_LIMIT_BYTES`; exceeding
it returns a clear error. Compatible providers receive images when `DEPLOY_MODEL_SUPPORTS_IMAGES=1`;
otherwise they receive an explicit note that they cannot read the attached images.

Videos use a poster tile with a play glyph and an actual duration badge when known. Generate posters
on the client from authenticated media, using the first frame or a frame near 0.1 seconds. Opening a
video uses the existing media viewer with inline playback controls, previous/next, caption and
file download/share. Keep media in its run and preserve transcript scrolling. Computer-use disclosures
count screenshots separately and identify recordings.

Content-sniffed MP4/MOV and WebM videos default to a 200 MB file cap, configurable with
`DEPLOY_VIDEO_LIMIT_BYTES`. The task media budget still applies. MP4 duration comes from `mvhd` when
available; otherwise duration is unknown until a client can read it. Upload raw bytes directly to disk;
never base64-encode videos or load a picker video into Data. Native Photos accepts images and videos;
file import, web input, paste and drop accept video files. Downloads save files rather than image data.
Video playback uses authenticated, same-origin Range requests (including seeks); native AVURLAsset
receives the account headers. A provider receives a text note naming the video and duration and stating
that it cannot view video directly.

Browser computer-use recording is opt-in with `record: true`. Record at 1280 × 800 in the worker temp
directory, close and finalize after at most ten minutes, and attach as “Computer use recording” with
source `computer-use`. Upload failures emit an attachment error event without failing the session.
Simulator recordings use `xcrun simctl io <device> recordVideo --codec=h264 out.mp4`, stopped with SIGINT,
then `deploy_attach`. Playwright flows use context `recordVideo`, close the context, then `deploy_attach`.
Encoding happens on workers; the coordinator does not require ffmpeg.

## Right task split

Computer, Changes and Activity share one right split on web and Mac/iPad. Title-bar toggles select the corresponding tab, show pressed only for that tab, and close it when pressed again. Switching tabs does not change the layout. One separator resizes the split from 320–720 px/pt with device-local width, keyboard arrows and accessible adjustment. The web separator also supports Home/End and double-click reset. The open tab is remembered per task on the device. Existing Activity open/closed and width preferences migrate; legacy collapsed means closed.

Escape and the header Close action dismiss the split and return focus to its opening toggle. Web tabs support arrow keys and Home/End. Changes contains the existing Changes/Checks subviews, scopes, file navigation, check and publish/merge actions. Expand uses the conversation width; Collapse returns to the split. Computer retains approvals, session controls, view-only and ended recovery, and slower polling while hidden. A new live session or pending approval selects Computer. The draggable Mac viewer is retired; its expand control opens a separate viewer sheet.

Below 1100 px on web, or when the native conversation area is narrower than 900 pt, the split covers the conversation at full width with a header close/back action. The underlying transcript stays mounted. Phone retains its Changes/Checks navigation and Activity/Computer sheets. Opening, closing and tab selection use standard/fast motion tokens; reduced motion is immediate. Transcript resize anchoring preserves the reading position. The floating task card fades away whenever any split tab is open.

## Composer context and access

Existing tasks keep the read-only project and computer tray. After the computer, attention-tone chips show **Can deploy** only for an online computer with the Deploy role ready, and **Screen access** only with the screen role ready and input permission on. Unknown, offline, paused, disabled and setup-needed roles never produce a chip. Each chip includes an icon, a one-sentence tooltip and navigation to that computer's detail page. Data uses the existing computer inventory and task-worker permissions.

The first eligible tray on a device shows an **Agent access is on** notice above the composer. Close and **Don't show again** persist dismissal on the device. **Learn more** opens Architecture → Roles and computer access. These explain actual capabilities without bypassing approvals. New-task pickers remain unchanged. Web specimens show the same split tabs, live inventory-derived chips and notice using signed-in data.

## Task Activity

Phone task navigation is Chat / Changes / Checks. A compact running/failing status pill in the composer toolbar, before the model picker, opens Activity in a full-height web sheet or an iOS sheet with medium/large detents. Keep touch targets at least 44 pt, wrap logs on phones and prevent horizontal page overflow.

Latest (default), All attempts and Failed filters share one job model. Check identity is computer plus optional label, otherwise whitespace-normalized command. Only the latest attempt decides the verdict; earlier failures remain under “Passed after N failures”. Queued and running work is active. Order Now, Needs attention, then turns newest first with jobs chronological inside each turn; unassociated jobs go under Other. Successful turns begin collapsed. Summaries lead with nonzero outcomes, followed by jobs and computers, with singular/plural agreement.

Job rows use one shaped status glyph and the words Passed, Failed, Running, Queued or Cancelled. Use a short intent label or command summary, computer, duration and relative time. A second line is reserved for an error, live output, waiting reason or retry history. Never print Exit 0. Expanded rows have a full command, Copy controls, a bounded 280 px log, Wrap, checkpoint/turn metadata and Show in conversation. Active rows expose Cancel. Checks is a compact latest-per-check verdict grouped by computer, linking to this history. Turn disclosures link back to the corresponding Activity scope. Conversation navigation highlights the run's message, respecting reduced motion.

Hide empty Sources and Q&A, discard directory-only sources, and use one collapsed Read N files disclosure with dimmed directories and emphasized basenames. Raw events is a collapsed disclosure with Copy JSON. Announce completion/status transitions politely, never progress ticks. Job accessible names include intent, computer, status and duration; their useful second line is the description. Metadata uses the metadata token or larger.

## Conversation chrome and task card

The transcript and composer keep their existing centered reading axis. User messages use `selected`
(accent-soft) with readable ink, aligned right. Inline code uses a quiet hover wash without a border.
The Send tooltip carries “⌘ Return to send”; there is no shortcut footer. Existing approval requests
stay above the composer; no permission state is inferred.

Turn disclosures read “Worked for 2m 8s ›” from the recorded run `createdAt` to terminal `updatedAt`,
with a live “Working for …” while active. Unknown/invalid timestamps omit duration. Actual job and
computer totals follow, in the failed tone when the latest check attempts fail. A hairline separates
the summary from the reply. Expanding retains commands, edits, tools, progress and job details.

An assistant reply ends with Copy and More icon actions. More contains the recorded agent context,
Copy link to message and the timestamp; the action row also exposes the timestamp on hover. Message
links identify both task and message. The context remains read-only and opens only on request.

The Task card appears when the conversation pane leaves at least 240 px
on either side of its 720 px column (1200 px pane). Its width is min(260 px, margin − 24 px). Mac/iPad use the same margin calculation with
native reading width. The card never changes or overlaps the text/composer width, and disappears whenever the right split is open.

It follows Codex's context card. The surface is `raised` with a 16 px radius, a 60 % `line` border and the
`--ds-shadow-card` elevation (`cardElevation` on Mac/iPad). That elevation sits one step below the composer:
a 1 px contact shadow plus a soft ambient shadow, and in dark mode a 1 px top-edge highlight, because
shadows barely read on a dark canvas. The header is the project name in secondary type with a ⋯ menu
(Show activity, Show sources, Collapse card). Rows are 32 px, full ink at medium weight, highlight on
hover, and are grouped by hairlines:

- Changes (recorded patch +/− counts, truncation explicit) and Activity (running/failing/passed);
- Running now: up to three actual queued/running jobs as terminal rows with computer and live time;
- Sources: the first three by file name or host/path, then a quiet View all with the total;
- Deployed: the recorded deployment host.

Missing diffs say Unavailable; empty Running now, Sources and Deployed sections are omitted. Collapse to
one icon is remembered and animated. The card fades/slides with the fast motion token; reduced motion is
immediate.
When the card is hidden and Activity is closed, a compact status pill sits in the composer toolbar immediately before the model picker. It shows only real running/failing counts and disappears when all checks pass. The full Activity
rail opens from the card or toolbar; Sources opens and scrolls to its file disclosure.

The live Conversation hierarchy specimens on `/dashboard/design-system#design-workspace-chrome`
read the signed-in workspace; they do not fabricate task statuses, counts, jobs or files.

## Phase 1 consistency

The shared title bar applies to tasks, repositories, applications, computers, settings, the design-system reference and their existing detail routes. Primary actions and filters stay in the body; rail navigation, list templates, Activity and review retain their behavior within the right split.

Pull requests have one compact linked transcript event. An open pull also has its live review bar above the composer; checks or conflicts keep that surface available. Merged and closed pulls have no composer bar. Event labels are “Opened #<number> <title>”, “Merged #<number> <title> into <target> · <short commit>”, or “Closed #<number> <title>”. Target and commit appear only when recorded. Native keeps issues as their existing actionable cards. Deployment messages render one event with the deploy glyph, “Deployed <application>”, a status only when it is not running, and accessible icon links for the URL and logs. The task card retains its Deployed row. No new server state is derived from presentation.

User bubbles retain right alignment and their radius, with normal ink on accentSoft/selected. The dark selected surface is a lighter, less saturated violet-neutral; web and native palette parity covers both appearances. The contrast regression test verifies normal ink at WCAG AA (at least 4.5:1) in both themes. Live title bar, prompt, tray, PR/deployment event and bubble specimens use the signed-in workspace at `/dashboard/design-system#design-workspace-chrome`.

## Shared list-page template

Applications, Computers, Repositories and Settings use `ListPageHeader` below the shared title bar. Place the single primary action first, with an optional plain, labeled filter. Settings categories remain mounted while hidden so forms preserve drafts. Use `ListGroup` headings and `PropertyRow` for labels on the left and real values or controls on the right.

`ListRow` uses the resourceRow height token (56 px, above the 52 px minimum), a leading workspace glyph, navigation type title, and one line of secondary text. The full row navigates using a real link. Its sibling `ActionCluster` keeps interactive controls out of that link. Actions appear on hover and keyboard focus and stay visible on touch; the `OverflowMenu` trigger is a labeled More `IconButton`. Destructive actions live inside the menu and retain their confirmation. Selection, focus, and utility hit targets remain separate.

Applications show URL and exceptional runtime status, with Open in a new window as an icon action. Metrics remain on the application detail page. Edit reveals the real bulk restart/delete controls; the default list has no checkbox column. Computers show platform and online state plus one role summary, excluding Coordinator from the count: All roles ready, a ready count with named setup/paused roles, or Offline. Coordinator stays a quiet chip. Select a computer to see the existing role controls, permissions, runtime applications and jobs. Repositories show description, imported remote host or Hosted on deploy.local; inventory rows never expose filesystem paths or remote credentials.

On Mac the activity rail navigates Tasks, Repositories and Computers. Each destination has its own sidebar list, with New repository or Connect a computer at the top and 32 pt navigation rows. Selecting a repository opens ProjectHubView in the main pane; selecting a computer opens its roles and permissions there. The title bar reflects the section/item. Applications is omitted until native application inventory is available. Back/forward remains task history and returns to Tasks. Popovers are for pickers and account information, never section lists.

The live List pages specimen in `/dashboard/design-system` uses these same components with links to the real reference sections.

## Sidebar details, loading and turn navigation

Pinned sits above Projects and Recents. Pin/Unpin and Mark done are sibling icon actions beside
selection, exposed on hover or keyboard focus and always visible on touch. They replace the trailing
signal in a reserved slot, keeping titles and rows still. Running tasks retain their signal until the
actions appear; Mark done is disabled with an explanation until active work stops. A successful close
shows “Marked done · Undo” for five seconds; Undo reopens using a fresh task revision. iPhone uses
leading Pin/Unpin and trailing Mark done swipe actions. Pin preferences use the existing web account
prefix and native coordinator/account UserDefaults keys; no server preference is written.

Pinned tasks leave Recents but remain in their project. The Recents disclosure is keyboard operable
and saved per device. Projects with no task updated within the last 30 days use tertiary ink; hover,
focus and selection restore ink. Task rows are 32 px on desktop and at least 44 pt on touch. Section
headings use 16 px above and 4 px below, with the same 8 px inset in all three sections.

`Skeleton` (web) and `WorkspaceSkeleton` (SwiftUI) are the shared loading primitives. Their variants
are rows (five 52 px blocks), sidebar, conversation (three alternating message shapes), and web detail.
Use only when the requested data has never loaded: sidebar, resource lists, application detail,
repository hub, Changes and Activity. Retain cached content while refreshing. Placeholders contain
no invented statuses or counts; a single accessible loading label replaces their decorative blocks.
The Feedback specimen at `/dashboard/design-system` includes row, sidebar and conversation variants.

The turn minimap overlays the left transcript margin, without changing the reading/composer axis or
covering the right split. It requires at least three user turns and overflowing content. It is hidden
on narrow panes and iPhone. Every tick names its turn and first-line prompt excerpt (up to 60
characters); hover/focus previews the excerpt. Arrow keys move within one keyboard stop and Enter
jumps to the prompt. Visible prompts use secondary ink, others tertiary. Web uses IntersectionObserver
and ResizeObserver; native uses scroll-target visibility on macOS 15/iOS 18 and the existing top-anchor
signal on older systems. Turns are extracted with the transcript snapshot, never on scroll.

Motion tokens in `app/design-tokens.json`:

| Token             | Value                         | Use                                                   |
| ----------------- | ----------------------------- | ----------------------------------------------------- |
| duration.instant  | 0 ms                          | Reduced-motion overrides                              |
| duration.fast     | 120 ms                        | Hover/press, title actions, task card and split entry |
| duration.standard | 180 ms                        | Disclosures, sidebar expansion and native turn jumps  |
| duration.enter    | 220 ms                        | Dialogs, popovers and split layout                    |
| duration.exit     | 140 ms                        | Mounted surface exits                                 |
| duration.drawer   | 240 ms                        | Compact navigation drawer                             |
| duration.spin     | 1000 ms                       | Running glyphs                                        |
| duration.shimmer  | 1600 ms                       | Gentle skeleton shimmer                               |
| easing.standard   | cubic-bezier(0.2, 0, 0, 1)    | Interactive state changes                             |
| easing.enter      | cubic-bezier(0.16, 1, 0.3, 1) | Overlay entry                                         |
| easing.exit       | cubic-bezier(0.4, 0, 1, 1)    | Surface exit                                          |
| easing.linear     | linear                        | Continuous loading/running indicators                 |

Native `WorkspaceStyle.Motion` matches fast, standard and shimmer. Reduced motion removes transitions,
turn-scroll animation and shimmer; sidebar running indicators become static. Web smooth turn jumps
use browser-native scrolling, with instant scrolling under reduced motion. The motion lint guard
covers workspace CSS, shared controls and the native sidebar, title bar, split, composer and minimap.
