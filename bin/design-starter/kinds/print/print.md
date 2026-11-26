## Print kind: a card you hold

A print board is one face of a printed piece: `<meta name="design-board" content="platform=print,size=85x55mm,bleed=3mm,safe=4mm,schemes=light">`. `size` is the trim (the finished piece), `bleed` is how far ink runs past the cut, `safe` is how far inside the cut text must stay. Boards link `tokens.css`, `components.css` and `print.css`. The check draws the trim at 8 px per millimetre and puts the bleed, trim and safe guides around it. A board carries no `<style>`: `print.css` sets the page's margin and ground.

- **The face is the box.** Put `.ds-print-face` first in the body with `style="--print-w:85mm;--print-h:55mm;--print-bleed:3mm;--print-safe:4mm"` repeating the meta. It is trim plus bleed on each side, so the board is exactly what goes to the printer. Change the numbers in both places or neither.
- **Bleed, trim, safe.** A ground or picture that reaches the cut edge goes in `.ds-print-bleed` (it fills the whole face, bleed included). Text and the mark go in `.ds-print-safe`, which is inset by the bleed plus the safe margin. Nothing that matters sits in the bleed or outside the safe area.
- **Front and back are two boards**, named so they sort together (`CardFront`, `CardBack`). For a proof sheet showing both, one board with `.ds-print-pair` holding two faces, its meta size the sheet's.
- **Type in points.** `--text-print-fine` 6 (legal lines, never below 6), `small` 7 (contact lines), `body` 8.5, `name` 11, `title` 16, `display` 26. All are pt: a business card's name is 9 to 11 pt, a postcard's headline 16 to 26 pt. Never px, never the web scale.
- **Length in millimetres.** Gaps, rules and marks are `mm`. A hairline is 0.25 pt, not 1 px.
- **Light only, few inks.** The paper is `--surface`; text is `--ink`. A solid ground is `.ground-ink`, `.ground-brand` or `.ground-quiet` **on the face itself** (`<div class="ds-print-face ground-brand">`), never on a child: the class also sets the text colour, so a ground on a child leaves dark text on the accent. Never two grounds on one face, and a card has at most the ink, one grey and the accent. A big ground costs a flood of ink and a fragile edge; use it on one side only.
- **To the printer.** `deploy design export --pdf --marks` writes each face at trim plus bleed with a 5 mm slug and crop marks; plain `--pdf` is the proof without them.
- **Wordmark** at one place and one size (`.ds-print-wordmark`), the mark from the logo kind or a plain SVG shape.
- **A back fills its face.** A card or postcard back is `.ds-print-face.ds-print-back`: `.ds-print-back-message` takes the left side's full height (the message, then a `.ds-print-lines` block to write on, then the wordmark at the foot) and `.ds-print-back-side` the right: the stamp box at the top, `.ds-print-address.ruled` below it, lowest 15 mm free for the barcode. Content that starts top-left and stops half way down, leaving the rest of the face empty, is wrong; a back is a composition, so every region has something or a rule in it. A business card's back is the wordmark centred on a ground, or one useful line with the same care.
- **Postcards have a stamp box and an address block.** `.ds-print-stamp` at the top right of the back, 20 by 24 mm, empty; `.ds-print-address` with three to five lines at the right half, on rules. The left half is the message. Keep the lower 15 mm of an address side free for the post's barcode.

- **Sample content and product facts.** Words a person wrote (the message on a postcard, a name on a greeting card) are sample content: draw them real and specific ("The lake was warm. Back on Friday. - Ines"). A card's own details (names, roles, phone numbers, addresses, prices, dates, claims) are product facts: the brief's, or a plausible value flagged with `data-question` (`name@example.com` style addresses are fine as flagged values), or left off. Never "Name Surname" or "Street and number" on its own: that is a wireframe. Worked example: the postcard message is sample; "Open daily 7 am to 3 pm" is a fact and carries the flag. A reviewer lists each unflagged fact as a `[fact]` finding, and filler as one too.

What agents get wrong for print:

- A ground class on the `.ds-print-bleed` child: the face's text colour does not follow.
- A back with the message top-left and nothing else, the rest of the card empty.

- Designing a screen: px sizes, shadows, rounded buttons, hover states. Paper has none of them.
- Text 2 mm from the cut edge. The safe area is there because trimming moves by a millimetre or two.
- Forgetting the bleed: a ground that stops at the trim line leaves a white sliver on the finished card.
- Type below 6 pt, or light grey text that vanishes in print. Print greys darker than the screen ones.
- Too much on a business card. Name, role, two or three contact lines, the wordmark: that is all.
- Putting the front and the back in one board at trim size, or drawing one face with the other's content.
