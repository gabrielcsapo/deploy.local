## Doc kind: a page to read, then print

A doc board is a reading page: `<meta name="design-board" content="platform=doc,page=a4,schemes=light dark">` (`page=letter` for US letter). Boards link `tokens.css`, `components.css` and `doc.css`, and the body's first element is `.ds-doc`. The check draws it at 700 and 390 wide, plus the printed pages at the page size. Long content scrolls; the board's height is measured, never set.

- **One column.** `.ds-doc-page` is a single column of about 66 characters (`--size-doc-measure`). No sidebar, no second column, no cards of cards. A doc is read top to bottom.
- **Type is the doc scale.** `--text-doc-h1` 40 (the title, once), `--text-doc-h2` 28, `--text-doc-h3` 20, `--text-doc-lede` 21 (one intro paragraph), `--text-doc-body` 17 with 28 leading, `--text-doc-meta` 13 (captions, running header, table heads), `--text-doc-code` 15. In print these become points (11 pt body) by themselves; never write a size by hand.
- **Headings are real.** `h1` once, then `h2` and `h3` in order, as elements, not styled paragraphs. A heading is never the last line of a page: `break-after: avoid` is already set, so keep it that way.
- **Tables are `.ds-doc-table`.** A header row in `thead`, one hairline between rows, no zebra stripes, no cell borders, numbers right-aligned with `.num`. Put `data-label="Column name"` on every `td` after the first: under 560 px the table turns into labelled rows, which is what makes it readable at 390. Never a table wider than the screen, never scrolled sideways.
- **Callouts are `.ds-doc-callout`**, with `.warn` or `.danger` only when it is a warning. At most one or two per page; a page of callouts has none.
- **Figures** are `.ds-doc-figure` with a `figcaption`: a caption says what to see, not "Figure 1".
- **Running header and footer.** `.ds-doc-head` (document name, section) and `.ds-doc-foot` (date, page) sit at the top and bottom on screen and repeat on every printed page. Put them first and last in the body.
- **Pages.** `.ds-doc-pagebreak` forces a new printed page where the content needs one (a chapter start). It is invisible on screen. Margins, page size and orphan/widow rules come from `doc.css`'s `@page` and `@media print`; do not add your own.
- **Light for print.** Screen is light and dark; the printed pages are always light.

- **No invented facts in a document.** Names, dates, versions, hours, percentages, quantities, defaults and prices in the text and tables are the brief's. A value it did not give is written as an honest placeholder that reads as finished ("Hours to be confirmed", "Date of the last update") with `data-question` on the table or paragraph that holds it, or left out. A document of plausible specifics (64 plots, 1,840 kg, $9,800, 4:00 to 4:45) looks real and is wrong; a reviewer lists each unflagged one as a `[fact]` finding.

What agents get wrong for docs:

- Filling tables and schedules with believable numbers and times nobody supplied.

- Building a web page with a sidebar, a hero and cards. A doc has none of them.
- Letting the line run the full width of a wide screen. Past about 70 characters it stops being readable.
- A table that needs sideways scrolling at 390, or a table made of `div`s.
- Headings picked for their size instead of their level; two `h1`s; a heading with nothing under it.
- Page numbers and the running header drawn as part of the content, so they appear once, not on each page.
- Decorative colour. The only colours are ink, greys, the accent on links, and warning or danger in a callout.
