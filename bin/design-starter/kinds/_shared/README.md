# Design system

The starting design system for this project: `tokens.css` (every colour, size and space), `components.css` (the icon, nothing else shared), the kind's own stylesheet beside them and `library.json` (each component's markup, to place on a board). The boards in `design/boards/` load them and nothing else. The starting board in `design/boards/` and the examples in `examples/` show them together; their text is a stand-in for this product's own content. The starting board is named for the project: replace its words, rename it if you like, and keep it on the canvas.

Change the system here, on a branch, like any design. A board that needs something the system lacks gets it added here first, not as CSS on one board.

## Rules for every kind

- **Restraint.** Neutral greys, one accent, hairlines before shadows. No gradients, glows, uppercase labels, coloured pills, decorative fonts or extra accent colours.
- **Tokens only.** Every colour, size and space comes from `tokens.css` or the kind's stylesheet; never a literal colour or an off-scale size on a board.
- **Sample content is drawn real; product facts are not made up.** Sample user content is what a person using the product would type or make (note titles and text, folder names, a contact in a list, a photo caption, a level's room number, a recipe): draw it realistic, specific and plausible, in the brief's language and setting, with no `data-question`; never "Item one", "Note title one", "Lorem" or "00". Product facts are what the product or organisation does or decides (features, settings and defaults, shortcuts, policies, prices, opening hours, dates, contact details, statistics, claims such as "free delivery" or "loved by 2,000 families"): if the brief doesn't give one, leave it out with the layout working without it, or draw a value that reads as finished copy and put `data-question` on that layer. Figures in a report, slide or handbook (totals, budget lines, timetables) are product facts: draw the layout at its real density with a plausibly shaped value ("1,240 kg", "Mon 4:00–4:45 pm") flagged with `data-question`, never "00" or "to be confirmed". Word the question as a check ("Are these the real totals?"), not "How many?" or "How long?".
- **No `<style>` on a board.** The kind's stylesheet sets the page's margin and ground; a board links the stylesheets and carries only markup (a document's `@page` words are the one exception).
- **Keep layer IDs** when you rebuild something, and name new ones for what they are.

## Sample content and product facts

A layout looks emptier without specifics, so agents fill it with filler or with made-up facts. Both are wrong, in opposite ways.

- **Filler is a wireframe.** "Item one", "Note title one", "Lorem", "00", "To be confirmed" in every cell. Judges score a board of filler as a sketch. Sample user content (what someone using the product would type or make) is drawn real: a title like "Soup for the week", a folder like "Tax 2025", a contact like "Marta Lindqvist", a level like "Room 14: the flooded cellar".
- **Made-up facts are claims.** A product fact (a feature, a default, a price, opening hours, a date, a statistic, "free delivery") that the brief doesn't give is either left out with the layout working without it, or drawn as finished-looking copy with `data-question` on its layer, so the owner sees it is an open question.
- **Report, slide and handbook figures are facts too**, but a layout is judged at its real density: write a plausibly shaped value ("1,240 kg", "Mon 4:00–4:45 pm") with `data-question="Are these the real totals?"` rather than "00". Word it as a check, not "How many?" or "How long?", which the check reads as "this layer must state no value".

A critic lists each unflagged product fact as a `[fact]` finding, and wireframe filler as one too. It does not flag realistic sample user content.

## Token names

- **Colour** (light, dark and `prefers-color-scheme`): `--brand` (the one to change), `--accent`, `--on-accent`, `--bg`, `--bg-sunken`, `--surface`, `--ink`, `--ink-secondary`, `--ink-tertiary`, `--line`, `--line-strong`, `--fill`, `--fill-strong`, `--primary`, `--on-primary`, `--success`, `--warning`, `--danger`, `--knob`, `--scrim`, and `--shadow-*`.
- **Space** `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 20, `--space-6` 24, `--space-8` 32, `--space-12` 48. **Corners** `--radius-sm` 6, `--radius-control` 8, `--radius-card` 12, `--radius-sheet` 16, `--radius-full`. `--font-sans` is the system font, `--font-mono` for code.
