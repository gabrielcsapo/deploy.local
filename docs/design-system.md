# Workspace design system

The reviewed system is implemented in the web application. `app/design-tokens.json` is the shared contract for color, metric identity, type, form sizes, spacing, composition, keyboard behavior, and supported labels. Run `node scripts/build-design-tokens.mjs` after changing it; `app/design-tokens.css` is generated. `app/native-workspace.css` composes the persistent React workspace and its existing controls.

Landing, documentation, sign-in and workspace share Manrope, JetBrains Mono, plum neutrals and lavender actions. All Tailwind color utilities resolve to the generated semantic tokens; there is no separate marketing or legacy operations palette. The landing page has a floating Docs / Dashboard launcher, while dashboard routes use the activity rail. Public chrome responds to client navigation and cannot remain attached to the dashboard.

Desktop uses a 52 px global rail, a resizable context sidebar (224 px default, 180–420 px bounds, preserving at least 360 px for work), and a work pane that fills the rest. Resource lists, tables, source, diffs and logs stay in the work pane. Context sidebars own project/repository selection, application sections, settings categories and computer navigation. Compact panes retain the rail and open task/management context in a drawer; repository context condenses above its viewer. Avoid repeated headings, descriptions and global links.

`data-appearance="plain"` supports borderless toolbar entry. Pair it with `.ds-input-shell` for an icon and input, or use it on an input inside an already bounded row. It is transparent, with no enclosing border or raised shadow; focus uses an accent underline. Default settings/form fields retain their boundaries. Touch entry is 44 px with 16 px text. Labels remain associated with inputs; errors include text, and forced colors retain visible focus.

Metric roles (`--metric-cpu`, `--metric-memory`, `--metric-traffic`, `--metric-latency`, `--metric-other`, `--metric-comparison`, `--metric-threshold`, `--metric-event`) name measurements. Health is a separate status. Row order and high CPU/memory values never change a measurement's identity color.

Repository browsing uses the actual Git branch, folder and source endpoints. The Name, Last commit, Updated and Size columns read real metadata. Metadata history work is bounded to 200 entries per directory, four concurrent reads, and cached by immutable commit/path; large listings remain complete and missing metadata reads “—”. Source has line numbers and local scrolling. Branch selection, upstream fetch and setup retry remain working controls.

Tasks appear in a right-pane table. Conversation stays mounted across management routes, with drafts keyed by task. Code review fills the right pane with actual changes and recorded checks, including existing Run check behavior. F6 cycles between navigation, context and work; arrows/Home/End navigate contextual links and resource controls without intercepting text editing or console scrolling. Focus is visibly distinct from selection. Compact context traps Tab and closes with Escape.

Loading, empty and error components share a compact inline row. Recovery stays next to the affected content. Never invent networks, environment names, backup guarantees, usage quotas, capabilities, model catalogs or successful operations. Production controls continue to use backend data and real APIs; static prototype data and simulation controls are not part of the application.

Work panes respond to their own width through container queries. Application tables progressively condense secondary metric columns; the application detail retains the measurements. Deployment history uses a 260 px list beside output in a wide pane, and a compact horizontal history strip above output in a narrow pane. Issues and pull requests use the full pane while composing, and collapse their list while reading details in a narrow pane. Settings categories keep their forms mounted while switching, so unsaved values remain available.

Code review renders an always-visible diff region rather than hiding the content of a closed disclosure. Its layout is active only in the task review view; switching to repository or management views cannot leave the review pane covering the new resource. Unregistered Terminal and Storage actions are omitted, and build/progress links use the registered Deployments route. Deployment-history and log loading failures expose Retry; obsolete responses from previously selected resources are ignored.

Computer inventory distinguishes deployment runtimes from task workers. The task-worker status reads the existing workspace inventory and includes the supported ordinary-user worker setup command. An online deployment runtime alone never enables the task composer. This is a real operational requirement; the UI never fabricates an available agent.

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

`Button` accepts native button props and `primary`, `secondary`, `quiet`, or `danger`. It defaults to `type="button"`; set `type="submit"` for forms. `TextField` requires a label, supports native input props, `bordered` (default) or `plain` appearance, and an associated `error`. Plain fields retain an accessible hidden label. `Metric` requires a labeled signal (`cpu`, `memory`, `traffic`, `latency`, or `neutral`); provide the unit or unavailable value explicitly. Existing `LoadingState`, `ErrorBanner`, `EmptyState`, `ConfirmDialog`, and `Toggle` are re-exported from the same entry point.

Use semantic Tailwind classes for layout and presentation: `bg-bg`, `bg-bg-surface`, `bg-bg-elevated`, `text-text`, `text-text-secondary`, `border-border`, `bg-action`, `text-on-action`, and `text-metric-cpu` / `text-metric-memory` / `text-metric-traffic` / `text-metric-latency`. These are mapped in `app/theme.css` to the generated variables; never introduce a second palette in a page.

To change the system, edit `app/design-tokens.json`, run `node scripts/build-design-tokens.mjs`, update shared primitives in `app/components/ui`, and extend the live specimens. Verify the affected application views and the reference at compact and desktop widths, with keyboard focus and both system appearances; then run `pnpm typecheck` and `pnpm build`. Do not hand-edit generated CSS. This reference has no runtime save endpoint: changes ship through the normal React application build.

`StatCard` is available from the same UI entry point for analytics summaries. Pass `signal` to use the metric palette; latency percentile lines use solid p50, dashed p95 and dotted p99 patterns rather than health colors.

The context divider supports pointer dragging, Left/Right (Shift for 32 px steps), Home/End bounds and double-click reset. Width persists across routes and reloads. Compact layouts retain their existing navigation arrangement and hide the divider.

Use `Select` from `@/components/ui` with a visible label or `aria-label`. It keeps native keyboard/type-ahead and form behavior. Its popup uses shared surface, edge, selection and focus tokens in browsers supporting customizable selects; other browsers use their operating-system picker with the same themed trigger. Do not hide it underneath a second imitation control.

Documentation and this reference ship inside the running app at `/docs` and `/dashboard/design-system`. The separate GitHub Pages application and publishing workflow have been removed.

Computer context links select a dedicated right-pane section rather than scrolling a stacked page. Sections remain mounted so enrollment drafts and expanded inventory rows survive navigation. Inventory disclosures have a visible chevron and keep native keyboard behavior.

Data dialogs use the `tableDialog` width token (880 px maximum). Tables retain their `tableMinimum` width (720 px), with horizontal scrolling confined to a named, keyboard-focusable region on compact screens. Numeric transfer totals use neutral metric color; success colors remain reserved for status.

Catalog rows expose one full-row link. Installation readiness comes from the selected live computer check; static release examples must never appear as current computer readiness. Activity labels use readable names, reserved width and truncation so an action cannot overlap its application name. Route-level fetch failures offer Reload and Open workspace recovery.

`Toggle` separates its 44 × 24 px track from the 44 px compact touch target. The track cannot shrink in a crowded row or stretch into a tall pill; selection, thumb, hover and focus use semantic tokens. Unavailable model options remain readable on the shared popover surface. Direct links into the design reference restore their target after the client view mounts.
