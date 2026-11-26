## Slides kind: a deck for a room

A slide is one board: `<meta name="design-board" content="platform=slide,width=1920,height=1080,schemes=light">`. Boards link `tokens.css`, `components.css` and `slides.css`; the body's first element is `.ds-slide` plus a layout class. The deck's order is the canvas `order` (or the boards' titles). The check draws each slide once at its own size.

- **One idea per slide.** If a slide needs two sentences of explanation, it is two slides. The speaker says the rest; it goes in `<aside data-notes>`, which is never drawn.
- **Five layouts, then three blocks.** `.ds-slide.title`, `.statement`, `.list`, `.picture`, `.two`; a slide that shows a figure uses `.number` (one big number), `.ds-slide-bars` (a bar chart) or `.ds-slide-table`. Pick the layout for the idea; do not invent a sixth.
- **Projection type.** `--text-slide-body` 36 (never less than 32), `--text-slide-lede` 44, `--text-slide-heading` 64, `--text-slide-title` 88, `--text-slide-display` 112 (a statement), `--text-slide-number` 160 (one number). `--text-slide-footer` 28 is only for the footer and the eyebrow. Never use the app scale (13, 15, 22) on a slide; it cannot be read from the back of a room.
- **Few words.** A title is at most eight words, a list has three to five items of one line each, a statement is one sentence. No paragraphs, no bullets inside bullets, no text on a picture.
- **Footer on every slide but the title.** `.ds-slide-foot` with the deck's name at the left and the slide number at the right; both are set, not guessed.
- **Builds.** Mark what appears later with `data-step="1"`, `"2"`… (hidden by `visibility`, so nothing moves). Draw the slide with everything visible; to show one step, put `data-step-at="N"` on the slide as an extra board or in review.
- **Light.** Slides are drawn light only: high contrast, one accent for the eyebrow and the one bar or number that matters, never a colour per item.
- **Margins.** 120 px on every side; nothing in the bottom 168 px but the footer; the picture layout is the only one that goes to the edge.

What agents get wrong for slides:

- Web-page type: 15 px text on a 1920 slide.
- A slide as a dashboard: four charts, a table and a paragraph. One figure per slide.
- Filling the slide. Empty space is the design; a statement slide has one sentence and nothing else.
- Bullets that are full sentences, or a list of eight things.
- Putting the speaker's script on the slide instead of in the notes.
- Colours per series in a chart. One grey for all bars and the accent for the one that is the point.
