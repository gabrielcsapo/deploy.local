# Review surface capture fixture

Run from the repository root. Dependencies and Playwright Chromium must be installed (`pnpm install --frozen-lockfile`, then `pnpm exec playwright install chromium` if needed).

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5180 node --import tsx docs/evidence/review-surface-build/fixture-server.ts
```

The server binds to 127.0.0.1:5180. It prints its temporary data directory and creates its own synthetic Git repository and database there. It does not read the owner's data, use credentials, contact origin, or launch a task agent. Stop it with Ctrl-C. The temporary directory is kept for inspection.

The default proposal has 28 screens in four change rows: 23 repeated header changes (four different old labels), three link-target changes that look the same, one changed phone screen, and one new phone screen. The chrome and boards use the repository's design system. Header fixture content uses Arial to make native-width pixel comparison deterministic; review chrome uses the application font. Phone content comes from the approved phone examples.

Each URL below **resets the shared fixture** and redirects to the real route. Open one state at a time. The capture runner performs the UI actions needed to open popovers, mark areas, change widths, or set Overlay/Wipe to 50%; opening the URL alone only seeds the state. Each capture is 900 px tall and writes `output/review-surface/<state>-<width>.png`. Approved starts a real 30-second countdown on every reset, so capture promptly. Loading delays the review response by 20 seconds; conflict injects the stale/conflict response. Conflict landing and restart recovery are covered separately by server tests.

| Board/state              | Exact reset URL                                                | Command at 1440 px                                                                  | Command at 700 px                                                                  |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| DesignReview             | http://127.0.0.1:5180/__fixture?state=DesignReview             | `node docs/evidence/review-surface-build/capture.mjs DesignReview 1440`             | `node docs/evidence/review-surface-build/capture.mjs DesignReview 700`             |
| DesignReview#loading     | http://127.0.0.1:5180/__fixture?state=loading                  | `node docs/evidence/review-surface-build/capture.mjs loading 1440`                  | `node docs/evidence/review-surface-build/capture.mjs loading 700`                  |
| DesignReview#conflict    | http://127.0.0.1:5180/__fixture?state=conflict                 | `node docs/evidence/review-surface-build/capture.mjs conflict 1440`                 | `node docs/evidence/review-surface-build/capture.mjs conflict 700`                 |
| DesignReviewViewer       | http://127.0.0.1:5180/__fixture?state=DesignReviewViewer       | `node docs/evidence/review-surface-build/capture.mjs DesignReviewViewer 1440`       | `node docs/evidence/review-surface-build/capture.mjs DesignReviewViewer 700`       |
| DesignReviewDiff         | http://127.0.0.1:5180/__fixture?state=DesignReviewDiff         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewDiff 1440`         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewDiff 700`         |
| DesignReviewWipe         | http://127.0.0.1:5180/__fixture?state=DesignReviewWipe         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewWipe 1440`         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewWipe 700`         |
| DesignReviewDiffSeveral  | http://127.0.0.1:5180/__fixture?state=DesignReviewDiffSeveral  | `node docs/evidence/review-surface-build/capture.mjs DesignReviewDiffSeveral 1440`  | `node docs/evidence/review-surface-build/capture.mjs DesignReviewDiffSeveral 700`  |
| DesignReviewRegion       | http://127.0.0.1:5180/__fixture?state=DesignReviewRegion       | `node docs/evidence/review-surface-build/capture.mjs DesignReviewRegion 1440`       | `node docs/evidence/review-surface-build/capture.mjs DesignReviewRegion 700`       |
| DesignReviewDraw         | http://127.0.0.1:5180/__fixture?state=DesignReviewDraw         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewDraw 1440`         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewDraw 700`         |
| DesignReviewWidth        | http://127.0.0.1:5180/__fixture?state=DesignReviewWidth        | `node docs/evidence/review-surface-build/capture.mjs DesignReviewWidth 1440`        | `node docs/evidence/review-surface-build/capture.mjs DesignReviewWidth 700`        |
| DesignReviewNew          | http://127.0.0.1:5180/__fixture?state=DesignReviewNew          | `node docs/evidence/review-surface-build/capture.mjs DesignReviewNew 1440`          | `node docs/evidence/review-surface-build/capture.mjs DesignReviewNew 700`          |
| DesignReviewNote         | http://127.0.0.1:5180/__fixture?state=DesignReviewNote         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewNote 1440`         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewNote 700`         |
| DesignReviewSent         | http://127.0.0.1:5180/__fixture?state=DesignReviewSent         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewSent 1440`         | `node docs/evidence/review-surface-build/capture.mjs DesignReviewSent 700`         |
| DesignReviewRound2       | http://127.0.0.1:5180/__fixture?state=DesignReviewRound2       | `node docs/evidence/review-surface-build/capture.mjs DesignReviewRound2 1440`       | `node docs/evidence/review-surface-build/capture.mjs DesignReviewRound2 700`       |
| DesignReviewApproveCheck | http://127.0.0.1:5180/__fixture?state=DesignReviewApproveCheck | `node docs/evidence/review-surface-build/capture.mjs DesignReviewApproveCheck 1440` | `node docs/evidence/review-surface-build/capture.mjs DesignReviewApproveCheck 700` |
| DesignReviewApproved     | http://127.0.0.1:5180/__fixture?state=DesignReviewApproved     | `node docs/evidence/review-surface-build/capture.mjs DesignReviewApproved 1440`     | `node docs/evidence/review-surface-build/capture.mjs DesignReviewApproved 700`     |
| DesignPropose            | http://127.0.0.1:5180/__fixture?state=DesignPropose            | `node docs/evidence/review-surface-build/capture.mjs DesignPropose 1440`            | `node docs/evidence/review-surface-build/capture.mjs DesignPropose 700`            |
| DesignToReview           | http://127.0.0.1:5180/__fixture?state=DesignToReview           | `node docs/evidence/review-surface-build/capture.mjs DesignToReview 1440`           | `node docs/evidence/review-surface-build/capture.mjs DesignToReview 700`           |
| Embedded                 | http://127.0.0.1:5180/__fixture?state=Embedded                 | `node docs/evidence/review-surface-build/capture.mjs Embedded 1440`                 | `node docs/evidence/review-surface-build/capture.mjs Embedded 700`                 |
| Mac                      | http://127.0.0.1:5180/__fixture?state=Mac                      | `node docs/evidence/review-surface-build/capture.mjs Mac 1440`                      | `node docs/evidence/review-surface-build/capture.mjs Mac 700`                      |

`DesignReviewDiffSeveral` uses a real additional revision with two separate changed regions. `DesignReviewRound2` has proposal lineage and an addressed note. `DesignToReview` seeds the three Approved statuses. `Embedded` mounts the actual review component inside a 700 px panel. `Mac` applies the desktop Mac class in a browser; it does not simulate native window dragging or traffic lights. The Width capture uses keyboard increments to select 810 px at 1440 and 520 px at 700; pointer dragging supports single-pixel widths.

Run the interaction checks while this fixture server is running:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 node docs/evidence/review-surface-build/smoke.mjs
```

The smoke test checks the real API and UI for grouped progress, point/area/drawing notes, arbitrary width, required proposal fields, sending notes, the approval warning, delayed approval and Undo, remembered Wipe, narrow layout, a native-width new phone screen, and Escape navigation.

For board references and a side-by-side comparison:

```sh
node design/tools/render.mjs DesignReview
python3 design/tools/pair.py output/review-surface/DesignReview-pair-1440.png output/design/DesignReview-1440.png output/review-surface/DesignReview-1440.png
python3 design/tools/pair.py output/review-surface/DesignReview-pair-700.png output/design/DesignReview-700.png output/review-surface/DesignReview-700.png
```

The reset URL is stable; the redirected inbox item ID is derived from temporary Git commits and changes on each server launch. The runner logs the exact redirected URL and any page errors for each capture. A Chromium launch failure should be resolved by installing Chromium in the capturing environment; the fixture can still be opened manually in a browser.

## iPhone review (part 2)

Build the simulator app from this worktree; the fixture connection is enabled only in Debug Simulator builds. No sign-in or credentials are needed. The fixture uses an isolated native cache per launch and never reads the normal device cache.

```sh
xcodegen generate --spec native/Apple/project.yml
xcodebuild -project native/Apple/Deploy.xcodeproj -scheme DeployIOS -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath native/Apple/DerivedData build
# Create once, or use an existing disposable iPhone 13 simulator (390 × 844 points).
xcrun simctl create 'Review Surface Build' com.apple.CoreSimulator.SimDeviceType.iPhone-13 com.apple.CoreSimulator.SimRuntime.iOS-26-5
xcrun simctl boot <udid>
xcrun simctl install <udid> native/Apple/DerivedData/Build/Products/Debug-iphonesimulator/Deploy.app
node docs/evidence/review-surface-build/capture-phone.mjs <udid> DesignReviewPhone
node docs/evidence/review-surface-build/capture-phone.mjs <udid> DesignReviewViewerPhone
node docs/evidence/review-surface-build/capture-phone.mjs <udid> DesignReviewApproveCheckPhone
```

Keep the fixture server above running on **5180**. The capture runner resets it, launches the app with `--v2-fixture http://127.0.0.1:5180 --v2-board <Board>`, waits for the app to finish loading its previews, then captures. The optional third argument is an additional settling delay in seconds (default 2, maximum 45). A failed preview or no readiness signal within 120 seconds fails the capture. `/__fixture/native-status` reports the simulator readiness signal; it exists only on this fixture server. Native captures are `output/review-surface/<Board>-runtime.png` at device pixel resolution and `<Board>-390.png` scaled to the approved point size.

**Run one capture at a time**, including web captures. Every reset changes the fixture shared by all clients. If preview loads time out on a cold run, retry after the server has rendered the PNGs. Do not treat a loading cover as a finished viewer capture.

| Native state      | Runner board                    | What the fixture opens                                                               |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| Cover             | `DesignReviewPhone`             | Proposal, four grouped change rows, Start review and See all screens                 |
| One change        | `DesignReviewViewerPhone`       | First repeated header change, native-width PNG, outlines and comparison controls     |
| Unsent-note check | `DesignReviewApproveCheckPhone` | Seeded unsent pin and approval sheet; Send note and Approve anyway call the real API |
| Pending approval  | `DesignReviewApprovedPhone`     | Real 30-second delayed approval; use Undo before the deadline                        |
| Round two         | `DesignReviewRound2Phone`       | Addressed note, proposer reply, changed and unchanged screens                        |
| New screen        | `DesignReviewNewPhone`          | The new project phone board with the existing no-Before state                        |
| All screens       | `DesignReviewGridPhone`         | Existing grid, with row-based seen progress                                          |
| Finish            | `DesignReviewDecidePhone`       | Existing decision page with row-based progress                                       |
| Hold              | `DesignReviewHoldPhone`         | Full Before preview                                                                  |
| Point note        | `DesignReviewPinPhone`          | Point-note sheet at the visible crop center                                          |
| Drawing           | `DesignReviewDrawPhone`         | Existing drawing mode with a synthetic stroke                                        |
| Drawing comment   | `DesignReviewDrawCommentPhone`  | Existing comment sheet with that stroke and draft text                               |
| Saved drawing     | `DesignReviewDrawSavedPhone`    | Saves the synthetic drawing through the real pin API; allow extra settling time      |

The fixture's proposal has no changed canvas notes. `DesignReviewNotePhone` therefore cannot reproduce the separate legacy canvas-note page with this proposal; its native implementation is retained. Use a synthetic proposal with a changed `design/canvas.json` note to inspect that state. The current fixture does not reproduce the avatar chooser or agent screens from the older New/Draw/Grid/Round2 examples: it uses the real synthetic project proposal instead.

For gesture checks, launch the viewer, choose Pin and tap the header, or choose Area and drag a rectangle. Enter a note and Add; inspect its marker/area on the image. Pin/Area save `layer` and fractional `offset` using the smallest rendered layer containing the anchor, otherwise native x/y; Area also saves its native rectangle. Draw retains its existing strokes and comment sheet. Scrub Old to New, choose Wipe, relaunch, and verify Wipe persists. At 1:1 the web PNG pans; pinch zooms, and horizontal swiping at the initial crop advances screens. Verify those gestures on a device before release; the automated native tests exercise state/transport, not physical multi-touch.

Approve from the More menu with a saved open note to check the warning. Send note sends the notes; Approve anyway starts the real delay. Undo restores waiting. The countdown is server-derived, refreshes once per second, and never substitutes a local landing deadline.

For the bounded web description, use `http://127.0.0.1:5180/__fixture?state=DesignReviewWords` and `node docs/evidence/review-surface-build/capture.mjs DesignReviewWords 1440` (also 700). This distinct fixture proposal omits the authored phone `changeWords`, so the computed long-change description is exercised without altering the normal authored-copy fixture.

### Verified in this build

On 2026-11-09, an iPhone 13 simulator running iOS 26.5 produced the cover, one-change viewer, approval warning, point-note sheet, saved drawing, pending approval with Undo, new-screen and second-round captures above. The three new boards have side-by-side files `DesignReviewPhone-pair.png`, `DesignReviewViewerPhone-pair.png` and `DesignReviewApproveCheckPhone-pair.png` in `output/review-surface/` (reference left, implementation right). PNGs are ignored local artifacts.

The point-note capture is partially covered by the simulator's first-use keyboard tutorial, so it is not clean parity evidence. The saved-drawing capture did save a note through the real API. The pending-approval capture shows the server countdown and Undo; Undo's state/transport behavior is covered by native tests, not a physical tap in that capture. Native touch gestures, VoiceOver, Dynamic Type and a physical device were not manually exercised.

Differences visible in the inspected captures: iOS 26's system navigation buttons, slider thumb and floating sheet differ from the flat HTML fixtures; native text uses the app's system font. Screen content, timestamps, note positions and progress come from this synthetic project proposal. The web PNG is displayed at its actual 1440-pixel width on a 390-point page, so its repository column is farther right than in the illustrative board crop. The first header is Project 1 / 1 of 28, not Repository sync / 22 of 28. The fixture adds an icon, so the computed text says “and an icon.” These are not claims of pixel-perfect parity.
