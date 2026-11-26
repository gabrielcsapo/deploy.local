# Design system

The starting design system for this project: `tokens.css` (every colour, size and space), `components.css` (the icon, nothing else shared), the kind's own stylesheet beside them and `library.json` (each component's markup, to place on a board). The boards in `design/boards/` load them and nothing else. The starting board in `design/boards/` and the examples in `examples/` show them together; their text is placeholder.

Change the system here, on a branch, like any design. A board that needs something the system lacks gets it added here first, not as CSS on one board.

## Rules for every kind

- **Restraint.** Neutral greys, one accent, hairlines before shadows. No gradients, glows, uppercase labels, coloured pills, decorative fonts or extra accent colours.
- **Tokens only.** Every colour, size and space comes from `tokens.css` or the kind's stylesheet; never a literal colour or an off-scale size on a board.
- **Ask, don't invent.** Anything the brief does not say (a figure, a date, a time, a name, a claim, a rule nobody has decided) is not made up. Either write an honest placeholder that still reads as finished copy ("the year's total", "to be confirmed") or put `data-question="…"` on the layer that shows it. See "Invented figures" below.
- **Keep layer IDs** when you rebuild something, and name new ones for what they are.

## Invented figures

Agents invent specific numbers because a layout looks emptier without them. A figure, date, time, name or claim that is not in the brief is one of these, in this order of preference:

1. Left out, with the layout working without it.
2. An honest placeholder that reads as finished copy: "the total", "this year", "to be confirmed", "name on the card".
3. A sample value that is obviously illustrative (`00`, `Name Surname`, `Item one`) with `data-question="What is the real figure?"` on the layer.

Never a plausible-looking specific (64 plots, 1,840 kg, $9,800, 4:00 to 4:45, a named person) with nothing marking it. A critic lists every one it finds as a `[fact]` finding.

## Token names

- **Colour** (light, dark and `prefers-color-scheme`): `--brand` (the one to change), `--accent`, `--on-accent`, `--bg`, `--bg-sunken`, `--surface`, `--ink`, `--ink-secondary`, `--ink-tertiary`, `--line`, `--line-strong`, `--fill`, `--fill-strong`, `--primary`, `--on-primary`, `--success`, `--warning`, `--danger`, `--knob`, `--scrim`, and `--shadow-*`.
- **Space** `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 20, `--space-6` 24, `--space-8` 32, `--space-12` 48. **Corners** `--radius-sm` 6, `--radius-control` 8, `--radius-card` 12, `--radius-sheet` 16, `--radius-full`. `--font-sans` is the system font, `--font-mono` for code.
