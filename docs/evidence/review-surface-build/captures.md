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
