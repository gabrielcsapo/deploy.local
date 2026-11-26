## Mac kind: a window that looks like it belongs on macOS

A Mac board is one window: `<meta name="design-board" content="platform=mac,width=1280,height=800,schemes=light dark">`; width and height are the window's. Boards link `tokens.css`, `components.css` and `mac.css`, set `body` margin to 0 and start with `.ds-mac-desk` around one `.ds-mac-window`. The check draws it once at its own size, light and dark. Each pane is a screen: the main window, the settings window, the menu-bar extra.

- **Type is macOS.** `--text-mac-body` 13 for everything you read and click, `--text-mac-small` 11 for secondary lines, section headers, counts and the subtitle, `--text-mac-headline` 15, `--text-mac-title` 20 and `--text-mac-large` 26 for a detail pane's title. Never 16 px body, never the web or phone scale.
- **The window.** `.ds-mac-lights` (three dots) at the left of `.ds-mac-titlebar`, then the title (and one `.ds-mac-subtitle`), then toolbar items (`.ds-mac-tool`, 28 px, icons only, a search field at the right). A unified 52 px bar; no second row of tabs under it.
- **Sidebar.** `.ds-mac-sidebar` with `.ds-mac-section` headers in 11 px and `.ds-mac-sideitem`s of 28 px; icons are in the accent, the current item is a grey fill. 220 px wide. The sidebar lists places or filters, never actions.
- **Three panes, at most.** Sidebar, then a `.ds-mac-list` (320 px) or a table, then the `.ds-mac-detail`; an `.ds-mac-inspector` (260 px) is a fourth only for properties of the selection. The selected row is in the accent (`.on`, with `--on-accent` text); a window that is not frontmost shows grey lights (`.inactive`).
- **Native controls.** `.ds-mac-popup` for a choice of several, `.ds-mac-seg` for two to four, `.ds-mac-check` for on or off, `.ds-mac-search` for search, `.ds-mac-btn` for push buttons (one `.default` at most per window or sheet), `.ds-mac-slider`. 22 px tall, not 32 px; no web select, toggle switch or big rounded button.
- **Tables are dense.** `.ds-mac-table` has 24 px rows, an 11 px header, numbers right-aligned, selection in the accent. A Mac list has more rows on screen than a web list; do not copy the 52 px rows.
- **Settings.** A narrow window (about 600 wide) with `.ds-mac-tabs` (icon above label, one per pane, the current in the accent) and a `.ds-mac-form`: labels right-aligned in a 160 px column, controls left-aligned, notes in 11 px under a control. No Save button; settings apply when changed.
- **Menu-bar extra.** `.ds-mac-menubar` with one `.extra` highlighted while open, `.ds-mac-popover` (300 px) under it: a short header, rows of 28 px, a rule, then the quit row. A popover is for glancing and one or two actions, not a small app.
- **Sheets** (`.ds-mac-sheet` over `.ds-mac-dim`) attach to the window's top, 420 px wide, one task, Cancel at the left of the buttons and the `.default` at the right. A dialog that floats free is an alert, with an icon, a bold line and two buttons.
- **Light and dark** both, from tokens only. Corner radius 12 on the window, 6 on controls.

What agents get wrong for the Mac:

- A web app in a window: a 248 px sidebar with big rows, 15 px text, rounded pill buttons, a hero header.
- Controls that are too large and too round, and a toggle switch where the Mac has a checkbox.
- Putting tabs in the window instead of the toolbar, or buttons with text where an icon with a tooltip belongs.
- Colour everywhere. Mac uses grey and one accent: icons in the sidebar, selection, the checkbox when on.
- A single 1280 px pane filled with a form. The Mac shows structure: list and detail.
- Forgetting the inactive state, or drawing only light.
