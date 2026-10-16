# Workspace design system

The reviewed system is implemented in the web application. `app/design-tokens.json` is the shared contract for color, metric identity, type, form sizes, spacing, composition, keyboard behavior, and supported labels. Run `node scripts/build-design-tokens.mjs` after changing it; `app/design-tokens.css` is generated. `app/native-workspace.css` composes the persistent React workspace and its existing controls.

Desktop uses a 52 px global rail, a 224 px context sidebar, and a work pane that fills the rest. Resource lists, tables, source, diffs and logs stay in the work pane. Context sidebars own project/repository selection, application sections, settings categories and computer navigation. Compact panes retain the rail and open task/management context in a drawer; repository context condenses above its viewer. Avoid repeated headings, descriptions and global links.

`data-appearance="plain"` supports borderless toolbar entry. Pair it with `.ds-input-shell` for an icon and input, or use it on an input inside an already bounded row. It is transparent, with no enclosing border or raised shadow; focus uses an accent underline. Default settings/form fields retain their boundaries. Touch entry is 44 px with 16 px text. Labels remain associated with inputs; errors include text, and forced colors retain visible focus.

Metric roles (`--metric-cpu`, `--metric-memory`, `--metric-traffic`, `--metric-latency`, `--metric-other`, `--metric-comparison`, `--metric-threshold`, `--metric-event`) name measurements. Health is a separate status. Row order and high CPU/memory values never change a measurement's identity color.

Repository browsing uses the actual Git branch, folder and source endpoints. The Name, Last commit, Updated and Size columns read real metadata. Metadata history work is bounded to 200 entries per directory, four concurrent reads, and cached by immutable commit/path; large listings remain complete and missing metadata reads “—”. Source has line numbers and local scrolling. Branch selection, upstream fetch and setup retry remain working controls.

Tasks appear in a right-pane table. Conversation stays mounted across management routes, with drafts keyed by task. Code review fills the right pane with actual changes and recorded checks, including existing Run check behavior. F6 cycles between navigation, context and work; arrows/Home/End navigate contextual links and resource controls without intercepting text editing or console scrolling. Focus is visibly distinct from selection. Compact context traps Tab and closes with Escape.

Loading, empty and error components share a compact inline row. Recovery stays next to the affected content. Never invent networks, environment names, backup guarantees, usage quotas, capabilities, model catalogs or successful operations. Production controls continue to use backend data and real APIs; static prototype data and simulation controls are not part of the application.
