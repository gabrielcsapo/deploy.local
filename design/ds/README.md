# deploy.local

deploy.local runs your apps and your coding agents on computers you own. This is the system every screen follows: the web dashboard, the Mac and iPhone apps, and the agents you create.

Version 2 holds deploy.local to the restraint of [hob](https://github.com/FrigadeHQ/hob) (MIT): four type sizes, neutral greys, one near-black action, almost no chrome. deploy.local violet stays as the brand. Tokens started from `app/design-tokens.json` on main (`0d96f82`) and the rules in `docs/design-system.md`. **This is a proposal; the app still ships v1.**

## Content fundamentals

- **Name real things.** A project, a computer, a check, "Merge and release". Never invent environments, quotas or success messages. Unknown reads "Unavailable", never zero or healthy.
- **Sentence case, short.** "Waiting on you", "Update from main". Every message input says "Ask, build, or follow up…".
- **Say it once.** The header names the thing; no page heading repeats it, no description restates it.
- **Agents speak plainly.** Their steps fold into "Worked for 3m". Prose is for what they found. A card appears only when a person decides.

## Visual foundations

- **Type: Hanken Grotesk, four sizes in the app.** `meta` 12 (labels, times) · `ui` 13 (rows, steps, buttons) · `body` 15 (your messages, the composer, card titles) · `title` 22 (screen titles, the empty-state question). Agent replies read at `reply` 16/26. Nothing in the app is larger than 22. Phone: 17 for rows and prose, 13 for secondary lines.
- **Color: light first, quiet greys.** `paper` → `sidebar` → `surface` step up. `ink`, `ink-soft`, `muted` for three levels of text (all ≥4.5:1 on every ground). `action` is near-black: one per screen, for the next decision. `accent` violet is the brand mark, links and the active project; it never fills a button. A matching dark theme ships in the same tokens.
- **Status is a glyph.** Spinner (`active`) for running work, a check (`success`) when ready. Apps and computers get a 6 px dot with a label. No colored badges.
- **One inbox.** The attention glyph means "you must decide" and appears only on items in Waiting on you, or on that same item where it shows in context (a card on Live, a merge card on a pull request). Answering it in either place answers both. Agents, Live and projects never show it; they show state with a dot, such as Live's "1 failing".
- **Shape:** `radius-control` 8 for buttons, fields and rows · `radius-card` 12 for cards and lists · `radius-dialog` 16 · `radius-composer` 18 for the prompt and your message bubble.
- **Depth:** hairlines (`line`) first; `shadow-sm` only under the composer and approval cards, `shadow-lg`/`shadow-xl` for menus and dialogs.
- **Icons:** line icons at 1.75 stroke, 16 px in the UI, 14 px in steps, 18 px on cards. Never emoji.
- **No** gradients, glows, uppercase captions, counts in pills, left-border cards or boxed every-field forms.

## Layout

- **One sidebar** (256 px): New task, Projects, Live, Computers at the top (Live always shows a summary: "7 running", or a red dot and "1 failing"); then Agents, Waiting on you, Today and earlier days; the account and Settings at the foot. It is the inbox.
- **Main pane:** a 48 px header (title, a muted subtitle, end-aligned icon actions). Conversations and the composer share a 768 px column. Pages (projects, computers, settings) use a 960 px column with a 22 px title.
- **Right panel** (320 px, hairline left edge) for what an agent is tracking or a pull request's merge status. It folds away below 1180 px.
- **Narrow windows:** below 900 px secondary lists fold; below 820 px the sidebar hides behind a menu button; below 600 px insets drop to 16 px and text steps up to 17.
- **Phone:** large title, rounded groups of 17 px rows, a bottom tab bar (Work, Projects, Live, Computers, Settings), 44 px targets.

## Lists

- Content that is a list of settings, rules, steps, records or people uses labelled groups (`.dl-ph-label` + `.dl-ph-group`) and `.dl-ph-row` rows of at least 52 px, or 64 px with a second line. Use 16 px side margins and horizontal row padding, and about 20 px between groups. Phone primary text is 17 px; secondary text is 13 px. SettingsPhone retains its approved typography and spacing.
- Use a 30 px `.dl-tile` (8 px radius) or an agent avatar when items differ in kind. A right-aligned `.dl-ph-value` is 15 px and muted, never 13 px ink-soft. Show a muted `.dl-chev` when a row opens something. Let long labels wrap rather than hiding meaningful words.
- A group holds about 3–7 rows. Longer or repeated structures become **summary rows that open a detail**: one row per item with its summary, not every field of every item inline. Never stack a matrix (items × options) on a phone.
- Explanations go in the group footnote (`.dl-ph-note`), not between rows. A row’s second line briefly describes that item; shared guidance belongs below the group.
- Web uses the same rules with `.dl-group` / `.dl-item` at its sizes, composed inside `.dl-list`, with `.dl-list-note` for footnotes. No dense tables for settings-like content; tables are only for real tabular data.
- Web and iOS must use the shared list components. Native `V2SettingsGroup` / `V2SettingsRow` already implement the Settings pattern; keep group spacing, row height, tiles, values, disclosure and footnotes in parity across clients.

## Components

Button, Sidebar, Work log, Approval card, Messages, Composer, List group, Settings rows, Status, Dialog, Phone. Each card shows its markup; class names live in `components/bundle.css`.

## States and trust moments

- **Empty** (`.dl-empty`): say what the place is for and offer one action ("No projects yet", New project).
- **Loading** (`.dl-skel`): skeleton rows in the real layout, never a page spinner. After 10 s, say what is slow.
- **Error** (`.dl-banner.warning` / `.danger`, `.dl-field.invalid` + `.dl-field-error`): what happened, what deploy.local is already doing, and one thing you can do. Warning while it retries or works around it; danger when something failed. Raw errors belong in Logs.
- **After a decision** (`.dl-approval.answered`): the card stays in the conversation as a dashed record with who answered, when and where. The work that follows reports back in the same conversation, and every answer is listed under Waiting on you, Answered.
- **Agent rules:** one summary row per agent opens its rules. Never show a permission matrix or stack every agent’s rules on a phone.
- **An agent at the controls** (`.dl-control`): while an agent uses a screen, a dark bar stays on top with the agent, the app, the elapsed time, Pause and Stop. Screen use is asked per task, for one app at a time (`.dl-scope`).

## Build rules for v2

- **Clients render the same events.** The server sends each conversation as typed events (decision card, work log, task link, answer, report). The web app, the desktop shell and the iPhone app render those events; none writes its own summary. A client may fold events, but never drops a decision card.
- **A noun appears only once it exists.** Tabs and sections for pull requests, issues, apps and releases show up with the first one. A one-app project is its own app page.
- **Teach a word where it first happens.** Task, pull request and release are explained once, in place, then never again.
- **Shipping is yours to start.** A task never asks to ship; Ship… sits in the task header, its panel and its info sheet. Only agents acting on a running app (like Ops watcher’s rollback) bring a decision to you.
- **Previews are screenshots you ask for.** They come from where the app runs: a browser for web apps, Simulator for iPhone apps, the window for Mac apps. No preview runs unless you ask.
- **Agents answer in chat.** Looks after items name what, where, when and what they bring. Scheduled work starts after confirmation. Within size, capacity and action rules, agents prepare pull requests or design reviews; features, larger work and archive ask first. Visible changes require approved design before code. Past days fold into one line.

## Consuming this system on a Design canvas

Load, after the canvas `support.js` line: `ds/deploy-local/tokens.css`, then `ds/deploy-local/components/bundle.css`, and Hanken Grotesk from Google Fonts in the artboard's `<helmet>`. Desktop screens use `.dl-app` as a fluid root (`expand: "fill"`) so they reflow with the window; phone screens use a fixed 390 × 844 `.dl-phone`. There is no script bundle: components are markup plus these classes.

## Not synced

No font files (Hanken Grotesk loads from Google Fonts). The live React components in `@/components/ui` are not bundled; cards are static renditions.

## Timing waterfalls

Performance boards optionally load `deploy-local/components/waterfall.css` after the bundle. The shared `.dl-waterfall` composes `.dl-bar` and existing web/phone rows. Each server phase starts at the previous typical phase's end, with a same-color lighter p95 extension on route summaries only. Browser milestones start at navigation and use a separate seconds axis. Single requests have no percentile extension. Axes and rows share 16 px insets; short phases retain exact duration labels and a minimum 1 px mark. Wrapping `.dl-waterfall-legend` keys use the existing light/dark tokens: route match `--accent`, data loading `--success`, page render `--warning`, streaming `--active`; browser milestones use `--ink-soft`. Light extensions use the phase color at 30% opacity, matching existing semantic tint usage. No categorical palette exists in the system. Slowest requests uses `--space-6` above its heading; waterfall notes have `--space-4` card padding. The same file selects static request fixture fragments and their app context; it adds no product behavior.

## Project care boards

`.dl-care` composes the existing sections, groups, agent rows and approval cards. It wraps evidence and care lines instead of truncating them, keeps a 768 px reading column, and gives phone reviews a scrollable body with decisions in `.dl-care-footer`. Use existing color, spacing and touch-size tokens. Stage and proposal-kind labels are plain text.

## Shared agent layouts

AgentSettings / AgentInfoPhone and AgentCareDetails / AgentCareDetailsPhone use the same details layout: page on web, sheet on iPhone. In order: avatar with Change avatar, Shuffle and colors; Name; editable What it does; What it’s learned (lesson, source, edit disclosure and a group footnote); Looks after list; Stopped suggestions only when there are saved stopped suggestions; What it may use; Approvals summary; Delete. Stopped suggestions uses the existing group and row components, with the finding, project and “Allow this suggestion again”; omit the entire section when empty. Code reviewer has one; Release notes writer has none.

AgentRoutine and AgentBeatProjects use the same item editor: dialog on web, sheet on iPhone. Fields are What, Where (All Active / All Active and Maintained / Chosen projects), When (Every week / Every day / On each change, day and time, On SER's clock), then Brings (A pull request / A design review / A question / A message), followed by Confirm item / Cancel. Chosen projects reveals a checklist with stage and access notes. Every day omits Day; On each change omits Day and Time. Confirmation saves without running immediately. Receipts offer an inline primary Confirm and Edit; the confirmed receipt reads “Confirmed · first check <day> <time> · Edit”.

## Design review

`.dl-review` composes the existing Settings lists, buttons, segments and avatars with crop tiles and a comparison viewer. The grid uses three equal columns at 1440, two at 700, and two on iPhone (390), with 200 px image boxes on web and 180 px on phone. Crops never enlarge native board pixels; include about 48 px of context and whole elements, fitting the complete crop without cutting text. Changed tiles show the largest changed area of After at readable scale, outlined with the same native-coordinate rectangle used by Show changes; scattered edits add “+2 more”. New and Removed crop the screen top at the same scale. Captions give a human screen name, small state tag when needed, then seen/pin state. Group by actual canvas page and board order, with one quiet total below the proposer summary.

At 1440 the viewer labels Before and After side by side at equal scale, with a 280 px pins tray on the right; at 700 and iPhone it toggles. At 700 pins remain below, reached by a “2 pins ↓” chip beside the screen name. Show changes outlines both revisions. iPhone web previews are crops with pan/zoom, never full desktop screenshots shrunk to fit. The footer places Next unseen beside progress, then decisions. Round two shows Your pins directly below the summary: three roomy numbered rows with text, screen, Addressed/Still open and a one-line reply. Changed since your review · 3 follows, then a collapsed list of unchanged screens. Only unresolved pins count toward Ask for N changes. Main changes elsewhere update automatically; only same-screen conflicts replace decisions with Ask to update / Close. The HTML boards are static fixtures; their canvas notes specify persistence and navigation for implementation after approval.
