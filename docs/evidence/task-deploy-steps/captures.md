# TaskDeploy: deploys and jobs as steps — parity

Board: `design/boards/TaskDeploy.html` (approved 2026-11-16, `42044c20`), `TaskDeployPhone.html`.
App: the real task page over `fixture-server.ts` (real v2 API, temporary data folder), captured with
`design/tools/capture.mjs` at 1440 and 700, light and dark (`captures/`). Pairs: `TaskDeploy-1440.png`,
`TaskDeploy-700.png` (board left, app right).

Matches: one "Worked for…" log per stretch of work; each step one line with its outcome; a failed deploy
in red, open by default to its reason and last log lines, with View logs; a live deploy linking its address;
durations and Output/View logs at the end of the row; a running step's spinner in the icon slot; replies
rendered as Markdown. Both widths and dark mode read correctly.

Differences, written back into the boards so they show what ships (owner to confirm):

1. Job text is the job's own name from the agent ("Run tests") with "Passed on SER", not "Ran tests on SER · 13 passed": deploy.local does not know a test count.
2. A failed deploy's reason is the platform's own message, not a hand-written sentence.
3. The tail does not color the error line: nothing marks which line is the error.
4. A running log reads "Working for 9m"; the board said "Working on bazzite · Opus · 9m", which the task header and panel already show.
5. Every job uses the terminal icon (the board's check from bazzite had a globe).

Fixture-only differences (not the feature): the panel and header show no pull request, and the sidebar has
no other tasks.

## iPhone

The real app in the iPhone 17 simulator (402 pt, scaled to points), fixture mode
`--v2-fixture http://127.0.0.1:5192 --v2-board TaskDeployPhone` (a simulator-only route that opens task
`tally-reset`), against the same fixture. Pair: `TaskDeployPhone-390.png` (board left, app right);
raw capture `captures/TaskDeployPhone-native.png`.

Matches: one work log, 22 pt rows with 4 pt between them, outcomes coloured by tone, the failed deploy
open to its reason, log box and View logs, the live deploy linking its address, Markdown replies. Rows
that open keep a 44 pt tap area without looking taller. The deploy glyph is SF Symbol `tray.and.arrow.up`.

Not in this capture because the fixture's task is finished: the live header and spinner, and the
Interrupted step's warning colour (both covered by Swift tests). A long outcome truncates
("Passed on baz…").
