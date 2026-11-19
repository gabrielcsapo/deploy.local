# Task panes: parity with the approved boards

Boards: TaskBrowser, TaskBrowserYours, TaskChangesPane, TaskChecksPane (approved 2026-11-19, on main as 405fe408).

Each `<Board>-<width>.png` here is the board on the left and the built page on the right, at 1440 and 700. The captures are in `captures/`.

## How to reproduce

1. Start Vite with `DEPLOY_MDNS_ADDRESS=127.0.0.1 DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5186 ./node_modules/.bin/vite --host 127.0.0.1 --port 5187 --strictPort`.
2. Start the fixture with `DEPLOY_MDNS_ADDRESS=127.0.0.1 ./node_modules/.bin/tsx docs/evidence/task-panes/fixture-server.ts`.
3. Open `http://127.0.0.1:5186/dashboard/tasks/tally-reset/browser`.

The fixture is the real v2 and workspace API over a temporary data folder. It includes a stand-in for bazzite's worker that acknowledges control changes and answers each step with a picture, so Take over, the address, Back, Forward, clicks, typing, scrolling and Give back all go through the real control API.

Capture with `node design/tools/capture.mjs <url> <out> 1440,700 900 --storage deploy-v2-first-task-seen=yes --storage deploy-control-client=parity-client-0001`. For TaskBrowserYours, first POST `/api/tasks/tally-reset/controls/takeover` with `clientId: parity-client-0001`.

## Checked by hand in the in-app browser (fixture log)

- **Take over:** the bar changes to "You have the browser · … is waiting", the address becomes editable, and Back, Forward and Reload are enabled.
- **Address:** typing `tally.local/settings` and pressing Enter sends `navigate https://tally.local/settings`.
- **Back:** sends `back`, and the address returns to `https://tally.local/`.
- **Clicks:** a click on the picture sends `click` in page pixels (the Reset button was (696, 515)).
- **Typing:** keys typed while a step runs wait their turn and are merged into one `text` step ("hello").
- **Keys and scrolling:** Enter sends `press Enter`, and the wheel sends `scroll`.
- **Give back:** returns the browser to the agent.
- **Changes pane:** the first file is open and the others are closed. Open full view goes to `/changes/full`, the earlier wide view.
- **Checks pane:** shows the existing checks list.
- **At 700 px:** a chosen pane fills the window. Task details is off by default and not shown as pressed.

## Differences from the boards

1. **The ⋯ button in the browser pane's header is not built.** The board shows "Browser options", but there are no options to put in it yet. It needs the owner's call: drop it from the board, or name the options.
2. **The picture is the worker's 1280×800 frame, scaled to the pane's width.** The board draws the page reflowed to fit the pane. At 1440 the pane is about 590 px wide, so text in the picture is about half size. Matching the board would mean resizing the worker's viewport to the pane.
3. **Fixture data, not the design:** the status line uses the page's existing summary ("Working · On its first checkpoint"), the agent name comes from the task (the fixture has none, so it reads "The agent"), and the Checks pane shows the fixture's checks. The existing disabled "Run again" stays on the Checks pane while checks aren't running.
4. **Design button:** tasks that changed the design keep a Design button, the layers icon, next to the pane buttons. It opens the existing design review in the main column. The boards show a task without design changes, so it's not drawn.
5. **No browser yet:** the Browser button appears only once the task has a browser session. Opening `/browser` without one shows "When the agent opens the task browser, you can watch it here." No board draws this state.
6. **Browser closed:** when the session has ended, the pane keeps the last picture and says the browser closed (with the reason). The canvas note describes this, but no board draws it.
