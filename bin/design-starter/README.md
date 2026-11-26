# Design system

The starting design system for this project: `tokens.css` (every colour, size and space), `components.css` (the `ds-` classes) and `library.json` (each component's markup, to place on a board). The boards in `design/boards/` load the two stylesheets and nothing else. The three `Example*` boards show them together; their text is placeholder.

Change the system here, on a branch, like any design. A screen that needs something the system lacks gets it added here first, not as CSS on one board.

## Rules

- **Restraint.** Neutral greys, one accent, one near-black primary button, hairlines before shadows. No gradients, glows, uppercase labels, coloured pills, decorative fonts or extra accent colours.
- **One accent.** `--brand` in `tokens.css` is the product's colour; dark mode derives its own from it. It marks links, the current tab and a choice that is on. It never fills a button and never colours text that is not one of those.
- **One primary action per view.** The near-black `.ds-btn.primary` is the next thing to do. Everything else is secondary or quiet.
- **Type: few sizes, the system font.**
  - Web: 28 `--text-display` (a top-level page's title, once), 22 `--text-title` (a page inside one, a dialog), 15 `--text-body` (row names, reading), 13 `--text-ui` (secondary lines, buttons, controls), 12 `--text-meta` (counts, hints, footnotes).
  - iPhone: 34 `--text-phone-large` (a tab's large title), 22 `--text-phone-title` (an empty state's title), 17 `--text-phone-body` (rows, fields, the bar's title and buttons), 15 `--text-phone-subhead` (a status at a row's end), 13 `--text-phone-footnote` (secondary lines, group labels, footnotes, segmented controls), 10 `--text-phone-tab` (tab bar labels only).
  - Nothing else, no other font, nothing larger than 34.
- **Roomy lists.** Things that are lists are rows in groups: 52 px rows on the web (`.ds-row`), 44 px or taller on iPhone (`.ds-ph-row`), a name and at most one secondary line, the value right-aligned, a chevron when the row opens something. A label above the group, a footnote below it. Long lists become summary rows that open a detail.
- **Dark mode always.** Every board is drawn in light and dark (`schemes=light dark`). Use tokens only, never a literal colour, and both themes stay at 4.5:1 or better for text.
- **Spacing and corners from the scales.** `--space-1` … `--space-12` (4, 8, 12, 16, 20, 24, 32, 48) and `--radius-sm` 6, `--radius-control` 8, `--radius-card` 12, `--radius-sheet` 16.
- **Ask, don't invent.** A product rule nobody has decided (how long something is kept, who may do what, what a number means) gets `data-question="…"` on the layer that shows it. The layer still reads as finished copy, saying only what is true today.
- **Placeholder is placeholder.** Text in the examples and the library ("Item name", "Secondary line", "00") is a stand-in. Take real names, numbers and states from the product.

## Web layout

- Boards are 1440 wide and must also work at 700: `<meta name="design-board" content="width=1440,height=900,platform=web,schemes=light dark">`.
- `.ds-app`: a 248 px sidebar with the product's places, and the main pane. Below 820 px the sidebar folds into `.ds-topbar` with a menu button.
- `.ds-page` is a 960 px column: `.ds-page-head` (title, one line of facts, the primary action), then the page's sections. Nothing scrolls sideways at 700.

## iPhone conventions

Phone boards are one screen: `<meta name="design-board" content="width=390,height=844,platform=phone,schemes=light dark">`. A phone screen is an iPhone app, never the web page made narrow.

- **Three kinds of screen.**
  - _Tab roots_ are the app's top-level places, in `.ds-tabbar` at the foot (three to five tabs). A root has a 34 px `.ds-large-title` and no back. Its one action (Add, Search) is an icon at the right of `.ds-navbar`.
  - _Pushed details_ open from a row. `.ds-navbar` holds back (a chevron and the previous screen's name), a short title, and at most one action at the right. The tab bar stays.
  - _Sheets_ create or edit one thing (`.ds-sheet` over the screen, with `.ds-grab`). Cancel is at the left of its bar and the confirm action (Add, Done, Save) at the right, in the accent, dimmed until the sheet is complete. No big button at the bottom of a sheet, and no back link.
- **The bar holds a short title.** A few words that fit on one line; the item's long name goes first in the content.
- **Inset grouped lists.** `.ds-ph-label` over a `.ds-ph-group` of `.ds-ph-row`s on the grey ground, `.ds-ph-note` under the group. Separators start at the row's text.
- **Native controls only.** A choice of a few is `.ds-ph-seg`; a choice of more is a menu row (`.ds-menu-value` with up-down arrows); a count is the `.ds-ph-stepper`; a date is a `.ds-ph-pill` at the row's end; on or off is `.ds-ph-switch`; ticking off or picking several is a round `.ds-ph-tick`; typing is a borderless `.ds-ph-input` filling a row. Never a web select, date field, bordered text box or square checkbox.
- **The frame never grows.** 390 × 844, always. Content scrolls in `.ds-scroll`, under the bar and above the tab bar; rows are never hidden behind the tab bar or the frame made taller to fit them. Draw the first screenful in order and let the rest run under the tab bar.
- **Actions.** A screen's action is in the bar, or an accent `.ds-ph-row.action` in the list (`.destructive` for delete, in its own group at the end). A full-width `.ds-ph-btn` is for a screen whose only purpose is one action, such as an empty state or a sign-in, not for forms.

## Files

| File             | What it is                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`     | Colour (light, dark and `prefers-color-scheme`), `--text-*` and `--leading-*`, `--space-*`, `--radius-*`, `--size-*`, the font stacks. `--brand` is the product's accent.                             |
| `components.css` | The `ds-` classes, built only from tokens.                                                                                                                                                            |
| `library.json`   | Each component: `id`, `name`, `group`, `platform` (web, phone or both), when to use it, and its markup with `{{settings}}`. Markup is a fragment: a row goes inside its group, a group inside a page. |

## Token names

- **Colour** (light, dark and `prefers-color-scheme`): `--brand` (the one to change), `--accent`, `--on-accent`, `--bg` (the page), `--bg-sunken` (sidebar, phone ground), `--surface` (groups, sheets, dialogs), `--ink`, `--ink-secondary`, `--ink-tertiary`, `--line`, `--line-strong`, `--fill`, `--fill-strong`, `--control-on`, `--primary`, `--on-primary`, `--focus`, `--success`, `--warning`, `--danger`, `--knob`, `--scrim`, and `--shadow-raised`, `--shadow-control`, `--shadow-float`, `--shadow-dialog`.
- **Type**: `--text-meta` 12, `--text-ui` 13, `--text-body` 15, `--text-title` 22, `--text-display` 28; `--text-phone-tab` 10, `--text-phone-footnote` 13, `--text-phone-subhead` 15, `--text-phone-body` 17, `--text-phone-title` 22, `--text-phone-large` 34; each with its `--leading-*`. `--font-sans` is the system font, `--font-mono` for code.
- **Space** `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 20, `--space-6` 24, `--space-8` 32, `--space-12` 48. **Corners** `--radius-sm` 6, `--radius-control` 8, `--radius-card` 12, `--radius-sheet` 16, `--radius-full`. **Sizes** `--size-control` 32, `--size-row` 52, `--size-touch` 44, `--size-sidebar` 248, `--size-page` 960, `--size-icon` 16.
