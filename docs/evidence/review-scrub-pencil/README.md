# iPhone review: Compare scrubs Before and After, and a pencil draws a comment

Verified in an iOS 27 simulator in fixture mode against the real review API (docs/evidence/review-clarity-build/fixture-server.ts), and on web at 1440 against the same fixture.

- `00-viewer.png`: the viewer toolbar: Compare, pencil, Show changes, 390, "Long-press to pin", "Seen · 0 pins".
- `01-compare.png`, `02-compare-scrubbed.png`: Compare puts a full-height divider over the screen with Before and After labels. Dragging anywhere moved the divider from the middle to the right and stayed on 1 of 18 (no paging). The Design row reads "1 to review · 168 boards" Before and "1 waiting on you" After. Done leaves compare mode.
- `03-draw.png`: Draw a comment: one finger draws in the accent colour; Undo and Next enable after the first stroke.
- `04-comment.png`: Next opens the comment sheet: thumbnail, "Drawing · Pin 1", "What should change?", Add disabled until text.
- `05-saved.png`: Add saved the pin (POST /review/pins 200). The strokes stay with numbered pin 1; "Seen · 1 pin".
- `06-web.png`: the web review shows the same strokes, read-only, on the After side with pin 1 and "Ask for 1 change".

Fixed while verifying: the saved line read "Ask for 1 changes".

Proposing a design now draws its screens in the background at 2× and 3×, one at a time: the fixture had 50 previews ready about 40 s after proposing, before the review was opened.

Gaps against the boards: Done and Cancel use the system tint (blue) where the boards draw them in ink.
