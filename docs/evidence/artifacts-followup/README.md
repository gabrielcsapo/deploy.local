# Artifacts follow-up: reviewing a document, and what nobody had checked

Boards: design branch `design/document-review` (ArtifactDocumentReview, ArtifactDocumentReviewBefore, ArtifactDocumentReviewNew, ArtifactDocumentReviewPhone, ArtifactDocumentReviewNewPhone, ArtifactDocumentNewPhone). Each `<Board>-<width>.png` here puts the board (left) beside the running app (right). Raw web captures are in `captures/`, dark-mode screens and keyboard checks in `dark/`, simulator screens (iPhone 17, iOS 27) in `iphone/`.

The app ran from this branch: the built server (`node dist/server.js`) over a temporary data directory with `DEPLOY_MDNS_ADDRESS=127.0.0.1`, Vite for the UI on 127.0.0.1:5180, and three projects (deploy.local carrying this repository's `design/`, forma, home-gym), two agents (Researcher, Designer) and three tasks. Everything was stopped and the data directory deleted afterwards. Sidebar data the fixture does not answer (Live, computers, tasks list) shows as unavailable; that is the harness.

## Differences from the boards

- **ArtifactDocumentReviewNew (web and iPhone):** the fixture's new document is in home-gym, so its line reads home-gym, and it was proposed by the owner, so it is from You. The board shows deploy.local and Researcher.
- **ArtifactDocumentReviewNewPhone:** iOS dims the whole Before and After control when it is turned off; the board was changed to match.
- **Decided states** (approving with its 30-second undo, Approved · on main, Sent to …) are the design review's, unchanged, and not drawn for a document. A document has no Build.
- **iPhone:** deciding lands at once (no undo window) and closes the review; the list it came from shows the result. Not drawn.
- **Task Design tab:** a task that changes an artifact design shows that design's boards and opens its review or canvas with the existing tab. A task that changes a document gets the tab only once the document is proposed, and it opens the document's review. No board changed for this.

## Defects found and fixed while checking

- Editing a document not on main put a dot beside every block (all differ from an empty main). No block is marked now.
- An approved document's review broke the check icon onto its own line, and its line counted no changes instead of saying on main.
- Hiding or showing a canvas panel from the keyboard dropped focus to the page; it now moves to the toggle that undoes it.
- On iPhone, your own document proposal read from An agent; it reads from You.

## Not checked, and why

- **Electron desktop app:** built (`pnpm build` in `desktop/`) and launched against the fixture, but it could not be driven. Playwright's Electron launcher timed out connecting, and with `--remote-debugging-port` the main process opened the DevTools port but never answered `/json`; Electron logged `sandbox_extension_issue_file_to_process failed … Operation not permitted`. Taking over the window through screen control was declined, and a screen capture from the shell came back black (no screen-recording permission). The gallery, creating a design and a document in the desktop app are unverified.
- The dark segmented control (Before / After) marks the chosen side only by a slightly lighter fill and text; that is the design system's `dl-seg` in dark mode everywhere, not changed here.
