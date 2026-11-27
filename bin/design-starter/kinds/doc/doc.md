## Doc kind: a page to read, then print

A doc board is a reading page: `<meta name="design-board" content="platform=doc,page=a4,schemes=light dark">` (`page=letter` for US letter). Boards link `tokens.css`, `components.css` and `doc.css`, and the body's first element is `.ds-doc`. The check draws it at 700 and 390 wide, plus the printed pages at the page size. Long content scrolls; the board's height is measured, never set (the head carries no `height=`; `deploy design check --fix` measures the board and writes it into the head and canvas.json together, and keeps them in step). A board carries no `<style>`: `doc.css` sets the page's margin and ground; the one thing in a `<style>` is the `@page` running header below.

- **One column.** `.ds-doc-page` is a single column of about 66 characters (`--size-doc-measure`). No sidebar, no second column, no cards of cards. A doc is read top to bottom.
- **Type is the doc scale.** `--text-doc-h1` 40 (the title, once), `--text-doc-h2` 28, `--text-doc-h3` 20, `--text-doc-lede` 21 (one intro paragraph), `--text-doc-body` 17 with 28 leading, `--text-doc-meta` 13 (captions, running header, table heads), `--text-doc-code` 15. In print these become points (11 pt body) by themselves; never write a size by hand.
- **Headings are real.** `h1` once, then `h2` and `h3` in order, as elements, not styled paragraphs. A heading is never the last line of a page: `break-after: avoid` is already set, so keep it that way.
- **Tables are `.ds-doc-table`.** A header row in `thead`, one hairline between rows, no zebra stripes, no cell borders, numbers right-aligned with `.num`. Put `data-label="Column name"` on every `td` after the first: under 560 px the table turns into labelled rows, which is what makes it readable at 390. Never a table wider than the screen, never scrolled sideways.
- **Callouts are `.ds-doc-callout`**, with `.warn` or `.danger` only when it is a warning. At most one or two per page; a page of callouts has none.
- **Figures** are `.ds-doc-figure` with a `figcaption`: a caption says what to see, not "Figure 1".
- **Running header and footer.** On screen, `.ds-doc-head` (document name, section) and `.ds-doc-foot` (date, and whatever else belongs at the foot; no page number, since a screen has no pages) are quiet bars, first and last in the body. On paper they are printed in the page's margin on every page, from a `<style>` in the board's head that gives the same words: `@page { @top-left { content: "Document name" } @top-right { content: "Section" } @bottom-left { content: "Date" } }`. The page number (`3 of 8`) is printed by `doc.css`; never draw one by hand. Keep the two in step: the words in the bars and in `@page` are the same.
- **Pages.** `.ds-doc-pagebreak` forces a new printed page where the content needs one (a chapter start). It is invisible on screen. Margins, page size and orphan/widow rules come from `doc.css`'s `@page` and `@media print`; do not add your own.
- **Light for print.** Screen is light and dark; the printed pages are always light.

- **Sample content and product facts.** Text a person wrote (a procedure's steps, a worked example, a sample command, a quote) is drawn real and specific, with no flag. A product fact (a name, date, version, hours, percentage, quantity, default, price) that the brief did not give is left out, or drawn as a plausible value and flagged with `data-question` on the table or paragraph that holds it ("Are these the real hours?"). A timetable or budget is judged at its real density: write `Mon 4:00–4:45 pm` and `1,240 kg` with the flag, not "to be confirmed" in every row. Worked example: "Return borrowed tools to the shed after use" is sample; "Shed open Tuesdays 4:00–6:00 pm" is a fact and carries the flag. A reviewer lists each unflagged fact as a `[fact]` finding, and filler ("Item one", "To be confirmed" everywhere) as one too.

What agents get wrong for docs:

- Filling tables and schedules with believable numbers and times nobody flagged, or with "to be confirmed" in every cell so the table cannot be judged.

- Building a web page with a sidebar, a hero and cards. A doc has none of them.
- Letting the line run the full width of a wide screen. Past about 70 characters it stops being readable.
- A table that needs sideways scrolling at 390, or a table made of `div`s.
- Headings picked for their size instead of their level; two `h1`s; a heading with nothing under it.
- Page numbers and the running header drawn as part of the content, so they appear once, not on each page.
- Decorative colour. The only colours are ink, greys, the accent on links, and warning or danger in a callout.
