## Slides kind: a deck for a room

A slide is one board: `<meta name="design-board" content="platform=slide,width=1920,height=1080,schemes=light">`. Boards link `tokens.css`, `components.css` and `slides.css`; the body's first element is `.ds-slide` plus a layout class. The deck's order is the canvas `order` (or the boards' titles). The check draws each slide once at its own size. A board carries no `<style>`: `slides.css` sets the page's margin and ground.

- **One idea per slide.** If a slide needs two sentences of explanation, it is two slides. The speaker says the rest; it goes in `<aside data-notes>`, which is never drawn.
- **Layouts, then blocks.** `.ds-slide.title`, `.statement`, `.list`, `.picture`, `.two`, `.closing`; a slide that shows a figure uses `.number` (one big number), `.figures` (two to four numbers), `.ds-slide-bars` (a bar chart) or `.ds-slide-table`. Pick the layout for the idea; do not invent another.
- **Figures: when and how.** One number is `.number`. Two to four numbers that belong together ("a year in numbers", before and after, this and that) are `.figures`: a heading, then `.ds-slide-figures` with `.n2`, `.n3` or `.n4` on the row and one `.ds-slide-figure` each, a `.value` and a `.label` that says what it counts. The value shrinks with the count (160, 112, 88 px) so every figure stays on one line; `.focus` puts the accent on the one the speaker is making the point about. Five or more figures are a table, or two slides. The values are the brief's; with none, draw plausible values and flag the figures (see below). Each figure has a value (160 px at three), a label of a few words, and optionally one `.context` line under it ("up from last year") so three figures fill the slide's width and height.
- **The closing slide.** The last slide is `.ds-slide.closing`, not a lone "Thank you" on empty space: the closing line bottom-left as on the title slide, and above it a ruled `.ds-slide-next` row of two to four ways to carry on (where the deck lives, who to ask, what happens next). Each has a short label and a value that is a link, a name or a next step the brief gives; with none, keep the row to what is true ("The deck is shared after the talk") or `data-question` it. No footer, like the title.
- **Projection type.** `--text-slide-body` 36 (never less than 32), `--text-slide-lede` 44, `--text-slide-heading` 64, `--text-slide-title` 88, `--text-slide-display` 112 (a statement), `--text-slide-number` 160 (one number). `--text-slide-footer` 28 is only for the footer and the eyebrow. Never use the app scale (13, 15, 22) on a slide; it cannot be read from the back of a room.
- **Few words.** A title is at most eight words, a list has three to five items of one line each, a statement is one sentence. No paragraphs, no bullets inside bullets, no text on a picture.
- **Footer on every slide but the title.** `.ds-slide-foot` with the deck's name at the left and the slide number at the right; both are set, not guessed.
- **Builds.** Mark what appears later with `data-step="1"`, `"2"`… (hidden by `visibility`, so nothing moves). Draw the slide with everything visible; to show one step, put `data-step-at="N"` on the slide as an extra board or in review.
- **Light.** Slides are drawn light only: high contrast, one accent for the eyebrow and the one bar or number that matters, never a colour per item.
- **Margins.** 120 px on every side; nothing in the bottom 168 px but the footer; the picture layout is the only one that goes to the edge.

- **Sample content and product facts.** Sample user content (a member's quote, a photo caption, a speaker's example) is drawn real and specific: "The tomatoes came in three weeks early." A product fact (a total, a date, a price, a claim) that the brief doesn't give is left out, or drawn as a plausible value and flagged with `data-question` ("Are these the real figures?"). A figures slide is judged at its real size, so it shows plausibly shaped values (`1,240 kg`, `38 families`, `12 weeks`) with the flag, never `00` or "to be confirmed". Worked example: the caption "First picking, May" is sample; "1,240 kg harvested" is a fact, so it carries the flag. A reviewer lists each unflagged fact as a `[fact]` finding, and filler (`00`, "Item one") as one too.

What agents get wrong for slides:

- Figures nobody flagged (a year in numbers with numbers nobody gave), or the opposite: a figures slide of `00` that reads as empty.
- A closing slide that is one line of thanks in the middle of white.

- Web-page type: 15 px text on a 1920 slide.
- A slide as a dashboard: four charts, a table and a paragraph. One figure per slide.
- Filling the slide. Empty space is the design; a statement slide has one sentence and nothing else.
- Bullets that are full sentences, or a list of eight things.
- Putting the speaker's script on the slide instead of in the notes.
- Colours per series in a chart. One grey for all bars and the accent for the one that is the point.
