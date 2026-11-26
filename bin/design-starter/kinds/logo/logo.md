## Logo kind: a mark that holds up small

A logo board is a square artboard: `<meta name="design-board" content="platform=logo,width=1024,height=1024,schemes=light dark">`. Boards link `tokens.css`, `components.css` and `logo.css`; the body starts with `.ds-logo-artboard`. A board carries no `<style>`: `logo.css` sets the page's margin and ground. The check draws one sheet: the mark at 512, 128, 64, 32 and 16 px on a light and a dark ground, so small-size legibility is judged from it. App-only notes do not apply.

- **Build the mark in SVG from simple shapes.** Circles, rectangles, rounded rectangles and straight or arc paths on a 64 × 64 grid (`viewBox="0 0 64 64"`), no raster images, no text in the mark, no filters. Round numbers for every coordinate; a mark that needs a decimal is too complicated.
- **One or two colours, from tokens.** `.a` fills with `currentColor` (the ink), `.b` with `--accent`. Never a literal colour in the SVG. The accent is the product's `--brand`; if the product has no colour yet, the mark is one colour.
- **Legible at 16 px.** The smallest shape is at least 2 units of 64 (1 px at 16); gaps between shapes the same. Look at the 16 px strip before anything else. If detail disappears there, remove it from the mark.
- **A small cut for 16, 24 and 32 px.** Do not just scale the mark down: draw a second cut in the same SVG. `<g class="full">` is the mark with its detail (shapes down to one unit of 64, for 48 px and up); `<g class="small">` is the same mark simplified: nothing under two units, gaps and counters wider, hairlines and the fine detail dropped, the key shape slightly heavier. `.s32`, `.s24`, `.s16` (or `.small-cut`) show the small cut; larger sizes show the full one. Look at the 16 px strip against the 512 px mark: they must read as the same mark.
- **Wordmark aligned to the mark, optically.** In a lockup the wordmark's capital height is centred on the mark's centre, not its line box (which carries room for descenders): `.ds-logo-lockup .ds-logo-word` uses `text-box: trim-both cap alphabetic`, so `align-items: center` does it. The mark is capital height plus a third, so it overshoots the capitals equally above and below; the gap is a quarter of the mark's width, and a stacked lockup centres on the same axis. A round mark may be a few percent larger than a square one to look the same size.
- **Fixed-ground tiles.** A sheet shows the mark on the grounds it will meet, and those do not follow the scheme being drawn: `.ds-logo-tile.on-light` with `data-theme="light"`, `.ds-logo-tile.on-dark` with `data-theme="dark"` and `.ds-logo-tile.reversed` with `data-theme="light"` (the near-black primary ground, one colour mark) look the same in the light and the dark render. Only the artboard around them follows the scheme. A tile that flips in dark is not showing the on-light version any more.
- **Works on light and dark.** Light uses `.ds-logo-mark` (ink and accent); dark gets the same classes, and the tokens flip. On a coloured or photographic ground use `.reversed` (one colour, `--on-primary` on `--primary`).
- **One-colour version is not optional.** `.mono` makes both colours the ink; the shapes still read, because the second colour is never the only thing separating two shapes. Check it.
- **No gradients, shadows, bevels or glows** unless the owner asks. A mark is flat.
- **Clear space is a quarter of the mark** on every side (`.ds-logo-artboard.guides` draws it, with the mark's box inside). Nothing enters it; no other logo, no text, no edge.
- **Lockups.** `.ds-logo-lockup` (mark left, wordmark right, 32 px apart) and `.stacked` (mark above, centred). The wordmark is the product's name in the system font, semibold, tight tracking (-3%); the mark is the height of its capital letters plus one third. Set it as text while designing; outlined paths belong in the final artwork, not the starter.
- **Sizes.** The mark alone never below 16 px; the lockup never below 96 px wide. The artboard is square even when the lockup is not: centre it.

- **Sample content and product facts.** A logo sheet has almost no sample content; the one place is the sample line a lockup is shown beside ("Tuesday market stall sign"), drawn real with no flag. The product's name, tagline, founding year or any figure is a product fact: the brief's, or a plausible value flagged with `data-question`, or left off (a tagline is optional). With no name given the wordmark says what the brief calls the product. Worked example: "Fernway" is the brief's; "Since 1987" is a fact and carries the flag. A reviewer lists each unflagged fact as a `[fact]` finding.

What agents get wrong for logos:

- Scaling one mark down to 16 px instead of drawing the small cut.
- A wordmark centred by line box, so it sits low or high beside the mark.
- Light and dark "tiles" that quietly swap in the dark render, so both renders show the same ground twice.

- Making an illustration: many shapes, a gradient, an outline plus shadow. It is gone at 16 px.
- A mark that needs its second colour: in one colour it becomes a blob.
- Letters in the mark drawn as text, which falls back to another font on someone else's machine.
- Different colours for the dark version. Dark is the same mark on a dark ground, or the reversed one.
- Putting the mark with a UI around it (a phone, a browser tab, a shadow). The artboard is the mark and nothing else.
