## Logo kind: a mark that holds up small

A logo board is a square artboard: `<meta name="design-board" content="platform=logo,width=1024,height=1024,schemes=light dark">`. Boards link `tokens.css`, `components.css` and `logo.css`; the body starts with `.ds-logo-artboard`. The check draws one sheet: the mark at 512, 128, 64, 32 and 16 px on a light and a dark ground, so small-size legibility is judged from it. App-only notes do not apply.

- **Build the mark in SVG from simple shapes.** Circles, rectangles, rounded rectangles and straight or arc paths on a 64 × 64 grid (`viewBox="0 0 64 64"`), no raster images, no text in the mark, no filters. Round numbers for every coordinate; a mark that needs a decimal is too complicated.
- **One or two colours, from tokens.** `.a` fills with `currentColor` (the ink), `.b` with `--accent`. Never a literal colour in the SVG. The accent is the product's `--brand`; if the product has no colour yet, the mark is one colour.
- **Legible at 16 px.** The smallest shape is at least 2 units of 64 (1 px at 16); gaps between shapes the same. Look at the 16 px strip before anything else. If detail disappears there, remove it from the mark.
- **Works on light and dark.** Light uses `.ds-logo-mark` (ink and accent); dark gets the same classes, and the tokens flip. On a coloured or photographic ground use `.reversed` (one colour, `--on-primary` on `--primary`).
- **One-colour version is not optional.** `.mono` makes both colours the ink; the shapes still read, because the second colour is never the only thing separating two shapes. Check it.
- **No gradients, shadows, bevels or glows** unless the owner asks. A mark is flat.
- **Clear space is a quarter of the mark** on every side (`.ds-logo-artboard.guides` draws it, with the mark's box inside). Nothing enters it; no other logo, no text, no edge.
- **Lockups.** `.ds-logo-lockup` (mark left, wordmark right, 32 px apart) and `.stacked` (mark above, centred). The wordmark is the product's name in the system font, semibold, tight tracking (-3%); the mark is the height of its capital letters plus one third. Set it as text while designing; outlined paths belong in the final artwork, not the starter.
- **Sizes.** The mark alone never below 16 px; the lockup never below 96 px wide. The artboard is square even when the lockup is not: centre it.

What agents get wrong for logos:

- Making an illustration: many shapes, a gradient, an outline plus shadow. It is gone at 16 px.
- A mark that needs its second colour: in one colour it becomes a blob.
- Letters in the mark drawn as text, which falls back to another font on someone else's machine.
- Different colours for the dark version. Dark is the same mark on a dark ground, or the reversed one.
- Putting the mark with a UI around it (a phone, a browser tab, a shadow). The artboard is the mark and nothing else.
