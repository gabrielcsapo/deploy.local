# deploy.local

deploy.local runs your apps and your coding agents on computers you own. This is the system every screen follows: the web dashboard, the Mac and iPhone apps, and the agents you create.

Version 2 holds deploy.local to the restraint of [hob](https://github.com/FrigadeHQ/hob) (MIT): few type sizes, neutral greys, one near-black action, almost no chrome. deploy.local violet stays as the brand. Version 2.1 keeps that restraint and adds what daily use showed was missing: depth (three grounds and a raised shadow), kind marks that say what a decision is at a glance, and a 28 px title for top-level pages. Tokens started from `app/design-tokens.json` on main (`0d96f82`) and the rules in `docs/design-system.md`. **This is a proposal; the app still ships v1.**

## Content fundamentals

- **Name real things.** A project, a computer, a check, "Merge and release". Never invent environments, quotas or success messages. Unknown reads "Unavailable", never zero or healthy.
- **Sentence case, short.** "Waiting on you", "Update from main". Every message input says "Ask, build, or follow up…".
- **Say it once.** The header names the thing; no page heading repeats it, no description restates it.
- **Agents speak plainly.** Their steps fold into "Worked for 3m". Prose is for what they found. A card appears only when a person decides.

## Visual foundations

- **Type: Hanken Grotesk, five sizes in the app.** `meta` 12 (times, hints, secondary lines) · `ui` 13 (rows, steps, buttons) · `body` 15 (your messages, the composer, card titles) · `title` 22 (detail pages, dialogs, the empty-state question) · `display` 28 (`.dl-display`: the title of a top-level page, such as Waiting on you, Projects, Live, Computers or Settings, and the new-task greeting; once per screen). Agent replies read at `reply` 16/26. Nothing in the app is larger than 28. Phone follows what the iPhone app draws, and `tokens.json` (group Phone) lists it: `phone-large` 28 (a tab's large title), `phone-sheet-title` 22 (a sheet or detail header), 17 for the top bar title (600), rows and prose, `phone-value` 15 (a row's value, and a mono first line), `phone-meta` 13 (secondary lines, group labels, notes), `phone-status` 11 (the label beside a status dot) and `phone-tab` 10 (tab bar labels only, as iOS draws them). Nothing else on a phone board.
- **Group labels read as labels.** A label over a group of rows (`.dl-group-label`, the sidebar's section labels, panel and list-group heads) is 13 (12 in the sidebar) at weight 600 in `ink-soft`, with a quiet count beside it in `muted` at 400: "Review designs 6". Never uppercase, never in a pill.
- **Color: light first, quiet greys.** `ink`, `ink-soft`, `muted` for three levels of text (all ≥4.5:1 on every ground). `action` is near-black in light and near-white in dark: one per pane, for the next decision (a list and the item open beside it are two panes). `accent` violet is the brand mark, links and the active project; it never fills a button. A matching dark theme ships in the same tokens.
- **Three grounds.** `sidebar` (lowest: the sidebar, code and log wells, the review canvas) → `paper` (the page) → `surface` (raised: list groups, cards, the composer, panels, dialogs, menus). Each step is visible in both themes; dark separates them by lightness (#111013 → #18171b → #24222a) rather than by lines alone.
- **Depth.** Hairlines (`line`) first. Raised surfaces on the page add `shadow-raised` with their border, never instead of it: `.dl-group`, `.dl-stat`, `.dl-approval`, `.dl-composer`, the risk card in Waiting on you (`.dl-asks-risk`), the starting cards on New task (`.dl-start`) and review crops. In dark, `shadow-raised` is a faint top highlight and a short shadow. `shadow-sm` is for the selected segment, switch knobs and small floating chips; `shadow-lg` for menus, popovers, the review tool bar and the new-task composer (`.dl-composer.hero`, with `shadow-raised`); `shadow-xl` for dialogs.
- **Kind marks.** Where items of different kinds share a list, a 30 px `.dl-tile` (36 px `.lg` in a detail header) with a line icon says what kind of decision each one is. Five kinds, each a tint and an ink token: `kind-risk` (rollback, release, anything hard to undo on a running app), `kind-design` (a design to review), `kind-proposal` (a feature, fix, improvement, update or archive an agent prepared), `kind-learning` (something an agent learned and asks to keep), `kind-question` (an agent's question in a task). They are used in Waiting on you and where those items show in context; nowhere else. `.dl-tile.brand` (accent-soft and accent) marks the first starting point on New task. A kind mark is never a filled pill, never carries a count and never replaces a status glyph.
- **Status is a glyph.** Spinner (`active`) for running work, a check (`success`) when ready. Apps and computers get a 6 px dot with a label. No colored badges: kind marks are the only tint, and only as tiles.
- **One inbox.** The attention glyph means "you must decide" and appears only on items in Waiting on you, or on that same item where it shows in context (a card on Live, a merge card on a pull request). Answering it in either place answers both. Agents, Live and projects never show it; they show state with a dot, such as Live's "1 failing".
- **Shape:** `radius-control` 8 for buttons, fields and rows · `radius-card` 12 for cards and lists · `radius-dialog` 16 · `radius-composer` 18 for the prompt and your message bubble.
- **Icons:** line icons at 1.75 stroke, 16 px in the UI, 14 px in steps, 18 px on cards. Never emoji.
- **No** gradients, glows, uppercase captions, counts in pills, left-border cards or boxed every-field forms.

## Layout

- **One sidebar** (256 px): New task and the places at the top (Live always shows a summary: "7 running", or a red dot and "1 failing"); then Waiting on you, Agents, and tasks grouped by date (Today and earlier days) or by project; the account and Settings at the foot. It is the inbox.
- **The sidebar is quiet until there is something to show.** A section appears with its first item: no heading over nothing, no "0", no sentence explaining an empty list. Waiting on you comes first under the places and is absent when nothing waits. Agents are one line each (avatar, name, time); with no agents the section is one row, New agent. An empty Today has no heading. Controls that do nothing yet are left out, not shown disabled.
- **Main pane:** a 48 px header (title, a muted subtitle, end-aligned icon actions). A page inside a list starts its header with a breadcrumb back to that list (Projects, then the project), so the way back is on the page. Conversations and the composer share a 768 px column. Pages (projects, computers, settings) use a 960 px column; a top-level page's title is `display` 28, a page inside it (a project, a computer) uses `title` 22.
- **Right panel** (320 px, hairline left edge) for what an agent is tracking or a pull request's merge status. It folds away below 1180 px.
- **Narrow windows:** below 900 px secondary lists fold; below 820 px the sidebar hides behind a menu button; below 600 px insets drop to 16 px and text steps up to 17.
- **Phone:** large title, rounded groups of 17 px rows, a bottom tab bar (Work, Projects, Live, Computers, Settings), 44 px targets.

## Components and instances

- A part that repeats across boards is one component in `components/library.json` and an instance on each board (`data-component`, with its settings in `data-props`). Approving a change to the component redraws every instance.
- The Sidebar is the first: every board holds an instance. Do not copy its markup into a board; place it and choose its settings. A test fails on a copy or on an instance out of step with the library.
- A component’s settings are names in lowercase with hyphens. A setting with choices becomes a class on the component; a text setting fills a `{{name}}` place in its markup. The component’s own styles show, hide and select from those classes.
- One fixture: an instance may add a little of its own (a decision, the task on screen), never a different cast.

## Lists

- Content that is a list of settings, rules, steps, records or people uses labelled groups (`.dl-ph-label` + `.dl-ph-group`) and `.dl-ph-row` rows of at least 52 px, or 64 px with a second line. Use 16 px side margins and horizontal row padding, and about 20 px between groups. Phone primary text is 17 px; secondary text is 13 px. SettingsPhone retains its approved typography and spacing.
- Use a 30 px `.dl-tile` (8 px radius) or an agent avatar when items differ in kind; a kind mark (`.dl-tile.k-*`) when they differ in the kind of decision. A right-aligned `.dl-ph-value` is 15 px and muted, never 13 px ink-soft. Show a muted `.dl-chev` when a row opens something. Let long labels wrap rather than hiding meaningful words.
- A group holds about 3–7 rows. Longer or repeated structures become **summary rows that open a detail**: one row per item with its summary, not every field of every item inline. Never stack a matrix (items × options) on a phone.
- Explanations go in the group footnote (`.dl-ph-note`), not between rows. A row’s second line briefly describes that item; shared guidance belongs below the group.
- Web uses the same rules with `.dl-group` / `.dl-item` at its sizes, composed inside `.dl-list`, with `.dl-list-note` for footnotes. No dense tables for settings-like content; tables are only for real tabular data.
- Web and iOS must use the shared list components. Native `V2SettingsGroup` / `V2SettingsRow` already implement the Settings pattern; keep group spacing, row height, tiles, values, disclosure and footnotes in parity across clients.

## Rows inside a row, files and commands

The design-system board `DesignSystemRows` shows them in light and dark, on web and iPhone. Specimen text is placeholder; take real names from the product and fixtures.

- **Rows inside a row** (`.dl-nest` on web, `.dl-ph-nest` on phone): what a row holds, such as the files a pipeline job kept, sits directly after that row in the same group. It indents to the row's text (44 px web, 46 px phone, after a 16 or 18 px glyph) on a hairline from the glyph; the separator falls after the last nested row. Nested rows (`.dl-nest-row`, `.dl-ph-nest-row`) are 32 px on web and 44 px on phone. Never a box or a second card inside the group, and never nest twice. When the job gave its declared files a caption (`caption:` beside `path:` in the pipeline file, such as “Browser screenshots”), the caption heads that path's rows: `.dl-nest-caption` (12/16, 600, ink-soft) on web, `.dl-ph-nest-caption` (13/18) on phone. Files without a caption come first, with no heading.

  ```html
  <div class="dl-item">…job…</div>
  <div class="dl-nest">
    <div class="dl-nest-row dl-file">…</div>
    <div class="dl-nest-caption">Caption from the job</div>
    <div class="dl-nest-row dl-file">…</div>
  </div>
  ```

- **File row** (`.dl-file` on a `.dl-nest-row`, `.dl-ph-nest-row` or `.dl-item`): the name in mono (`.dl-file-name`), the size (`.dl-file-size`) and a quiet Download (`.dl-btn.quiet` on web, a 44 px `.dl-ph-btn` download icon on phone). Put the folder and the file in two spans to truncate in the middle and keep the file name; one span truncates at the end. Give the full path as `title`. A file that was not kept is `.dl-file.missing`: the name muted and its reason (`.dl-file-why`) in place of size and Download. A file that matched but was refused shows its real path ("Unsupported file type"); only a pattern that matched nothing shows the pattern ("No files matched").

  ```html
  <div class="dl-nest-row dl-file">
    <span class="dl-file-name" title="path/to/folder/file-name.ext"
      ><span>path/to/folder/</span><span>file-name.ext</span></span
    ><span class="dl-file-size">00 KB</span
    ><button type="button" class="dl-btn quiet">Download</button>
  </div>
  <div class="dl-nest-row dl-file missing">
    <span class="dl-file-name"><span>path/to/*.ext</span></span
    ><span class="dl-file-why">No files matched</span>
  </div>
  ```

- **A command as the second line** (`.dl-cmd` on the second span of `.dl-item`, `.dl-setting` or `.dl-ph-row`): mono (12 web, 13 phone) and it wraps rather than truncating, so the whole command reads. The glyph, state and actions stay with the first line.

  ```html
  <span class="dl-t"
    ><span>Job name</span><span class="dl-cmd">command --option value path/to/input.ext</span></span
  >
  ```

- **A mono first line on phone** (`.dl-mono` on the first span of a `.dl-ph-row`): for a row whose name is code, such as a package and its version. It is 15/22, which reads at the weight of the row's 17 px text; never set a local size.

  ```html
  <span class="dl-t"
    ><span class="dl-mono">package-name 0.0.0</span><span>Secondary line</span></span
  >
  ```

- **Phone status** (`.dl-ph-status`): an 18 px slot leading a phone row that holds the web's own status glyphs, so state reads the same on both: passed `.dl-ok` (success), failed `.dl-fail` (danger), running `.dl-run` (active), skipped `.dl-skip` (muted, a circle with a dash). Stroke 2, with the state as `aria-label`.

  ```html
  <div class="dl-ph-row">
    <span class="dl-ph-status"
      ><svg class="dl-fail" width="18" height="18" … aria-label="Failed">…</svg></span
    ><span class="dl-t">…</span>
  </div>
  ```

## Phone screens

How the iPhone app (native/Apple, `V2*` views) is built, for phone boards. Where the app has no answer, it says not decided; ask rather than invent.

- **Tab roots.** Work, Projects, Live, Computers and Settings are the tab bar (`.dl-tabbar`), which takes the sidebar's place; a phone has no sidebar. A root opens with its 28 px large title (`.dl-ph-large`) and no back. Search and New message live only on Work: search at the top left opens full screen, the compose icon at the top right opens the composer as a sheet. Waiting on you opens from Work as a sheet.
- **Pushed details.** Inside a tab, tapping a row pushes a screen: Projects → a project → Releases → a release, or → an app. The tab bar stays. The top bar (`.dl-ph-top`) has back on the left and an inline 17 px title, with nothing on the right. The title names what the screen shows: the item ("home-gym", "Release 7f3b2d4", the app's name), or for a list, the list with its owner ("home-gym releases", "Pull requests"). A project's page also repeats its name as the large title.
- **Sheets.** Tasks and agent conversations, a decision, Packages and a package's versions, Ship, Backups and Artifacts open as sheets over the tab bar (`.dl-ph-sheet` with `.dl-ph-sheet-top`): the title in the middle and Done at the right, or ✕ when creating something (New agent). Inside a sheet, rows push further screens as above.
- **List and detail.** The app has no split view and no switcher: where the web shows a list beside a detail, the phone list is its own screen and each row pushes the detail. The detail never embeds the list.
- **Height and scroll.** A phone board is 390 × 844 (`.dl-phone`); never grow it. Content scrolls in `.dl-ph-body`, under the top bar and above the tab bar, with no scroll bar. Draw the first screenful in order and let the rest run under the tab bar; the body scrolls when the board is opened.
- **Header.** A detail's top bar names it, so the content starts with its state: the app page's first line is a status and its facts ("Healthy · Web app · part of home-gym · 9c3e1fa"), `.dl-ph-head` with `.dl-ph-head-meta`. Add `.dl-ph-head-title` (22) only when the bar does not already name the item. A release opens with a summary row in a group instead.
- **Actions.** A screen's actions are full-width buttons (44 high, 17 px) after its content, the last thing in the scroll, primary first (`.dl-ph-actions`): "Roll back to 81be0d2…" ends Releases, "Ask for a fix" ends a failed release. Pushed details put no action in the top bar. A bar pinned above the tab bar is not decided; the app does not do it.
- **From web to phone.** A button that opens something (Log, Versions) becomes a row that opens its screen, with `.dl-chev`. A status word becomes the state at the row's end (`.dl-status`: a dot and a short label, as the app's `V2Status`), or a status glyph leading a run's row (`.dl-ph-status`). A kind glyph stays a `.dl-tile` (a package stays a package tile). A link to a web detail goes to that detail's phone board: Package → PackageVersionsPhone. Tabs inside a web page (Overview, Requests, Settings) become rows on the item's phone screen that push each part; a tab strip on phone is not decided.

  ```html
  <div class="dl-phone">
    <header class="dl-ph-top">
      …back… <span class="dl-t">home-gym releases</span><span style="width:44px"></span>
    </header>
    <div class="dl-ph-body">
      …groups…
      <div class="dl-ph-actions">
        <button class="dl-btn secondary">Roll back to 81be0d2…</button>
      </div>
    </div>
    <nav class="dl-tabbar">…</nav>
  </div>
  ```

## Components

Button, Sidebar, Work log, Approval card, Messages, Composer, List group, Settings rows, Rows inside a row, File row, Row with a command, Status, Phone status, Phone row with a mono first line, Phone sheet top bar, Phone detail header, Phone actions, Dialog, Phone. Each card shows its markup; class names live in `components/bundle.css`.

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

At 1440 the viewer labels Before and After side by side at equal scale, with a 280 px pins tray on the right; at 700 and iPhone it toggles. At 700 pins remain below, reached by a “2 pins ↓” chip beside the screen name. Show changes outlines both revisions. iPhone web previews are crops with pan/zoom, never full desktop screenshots shrunk to fit. The footer places Next unseen beside progress, then decisions. Round two shows Your pins directly below the summary: three roomy numbered rows with text, screen, Addressed/Still open and a one-line reply. Changed since your review · 3 follows, then a collapsed list of unchanged screens. Only unresolved pins count toward Ask for N changes. Main changes elsewhere update automatically; only same-screen conflicts replace decisions with Ask to update / Close. The review itself is `.dl-rv`: one bar, a list of what changed, and the real design filling the rest, with notes placed on it. See the `review-what-changed` canvas note. The HTML boards are static fixtures; their canvas notes specify persistence and navigation for implementation after approval.

## Waiting on you

`.dl-asks` groups what waits by what you must do, in this order, each group appearing with its first item: **Decide now** (risky or blocking decisions on a running app, such as a rollback), **Review designs**, **Proposals**, **Answer** (questions in a task). Group labels carry a quiet count. A Decide now item is a raised card (`.dl-asks-risk`) with both choices inline. Every other item is one `.dl-asks-row`: kind mark, a title that says the change in words (not a board or branch name), one line of context (project · who asked · age · screens), and one action (Review, Answer). The proposal-slot limit is a footnote under Proposals (`.dl-asks-note`), never a box above the list. From 1180 px the list is 460 px and the open item shows beside it (`.dl-asks-detail`): for a design, Before and After crops of the main changed screens (`.dl-asks-pair`, crops drawn at their own size), the rest summed up as one row ("11 more screens"), then Approve design and Ask for changes in a footer. Narrower, the list is the page and an item opens as its own page (`.dl-asks-page`) with Waiting on you as the way back.

## New task, nothing yet

The composer is the hero (`.dl-composer.hero`). Under it, the starting points are cards (`.dl-starts`): Add a project first, with the brand tile and the primary button; Install an app beside it with a neutral tile and a secondary button; Add another computer as a quiet row below (`.dl-start-quiet`), since it is optional.

## Reviewing a design

Review is a mode of the editor, not a separate surface. Reviewing a proposal opens the Design editor on its branch with the editor's own anatomy, and changes only what a reviewer needs:

- **Left panel:** the editor's, with a small way back at its top named after where you came from ("‹ Waiting on you"). The branch line reads "design/… · in review". Pages and Layers keep their changed and new dots, so the left panel is how you move around, as when editing.
- **Review strip:** the strip above the canvas that says "1 design waiting on you · Review" while editing becomes the proposal's title · from its proposer · progress ("3 of 13 seen", or "Loading 3 of 13 screens" while stills arrive), with Before / After / Wipe at its right.
- **Canvas and tool bar:** boards in place; the editor's floating tool bar in its usual place and style, with ‹ 3 of 13 › stepping added at its left. Comment is the active tool; the drawing tools stay, since it is the same tool.
- **Right panel:** the same panel and tab row, with a Review tab before Edit and Comments, selected in review. It holds What changed (every changed screen with Changed or New, a seen tick and its pins, "3 of 13 seen") and Notes. Edit and Comments are one click away and never open on their own; selecting a board keeps Review selected. The top row's Propose becomes Ask for changes and Approve design (the one primary).
- **Narrow (below 1180 px):** the left panel folds behind its show button in the review strip; the right panel stays a side panel on its Review tab. There is no bottom sheet.
- **Loading:** the same frame; boards appear in place as blurred low-resolution stills and sharpen as their renders arrive.

## The Design page's editor

Boards of the Design page place the `design-editor` component instead of drawing the editor: load `deploy-local/components/editor.css` after the bundle, put the instance inside `.dz-ed`, and put only what is on the canvas (boards, selection, pins, the ask box) in `.dz-ed-stage` beside it. Its settings choose the mode (editing or reviewing), the selected page and layer, the layer rows, the tool, the right panel (Edit, a text layer, Comments with the app's “Comment on X…” form, review notes), the branch, the task working on it and the banner. DesignCanvas is the example to start from. Below 820 px the panels fold, the narrow bar shows and the canvas zooms out to fit.
