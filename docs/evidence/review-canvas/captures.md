# Canvas review capture fixture

Run from the repository root with dependencies already installed:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5190 node --import tsx docs/evidence/review-canvas/fixture-server.ts
```

This mounts the real `V2Layout` and Design page, including `CanvasReview` and `BuildDesign`, through the existing fixture router adapter. API responses, frame HTML, cached change geometry and seed records are isolated in a new temporary directory printed at startup. It uses no production API, credentials, database, Git operations, mDNS, Docker, workers, approval timers, renderer or external requests. Only loopback HTTP is opened. Stop with Ctrl-C to remove the temporary directory. All mutations except a valid, revision-checked frame tick return 405. Unknown API routes return 404 instead of falling through to a coordinator. The page signs in as fixture user Gabriel; CSP and the runner block remote resources.

The proposal is **Keep the gutter at every width**, from **Designer**, on **design/welcome-gutter**, in **deploy.local**. Get started contains Welcome, Welcome, narrow (720), Sign in (390), New project, Install an app, First task, Empty state art and the gutter sticky note. Other pages are Ask and build, Projects and apps, Agents and trust and Mac app chrome. Welcome, Welcome, narrow and Install an app have changed areas; Welcome alone is initially ticked.

Each reset starts fresh and redirects to `/dashboard/design?review=…&page=section-start`. Run captures **one at a time**: the state is shared by all clients. The approved runner opens the Build destination menu without starting a build. Conflict opens the decision dialog without resolving it. Frame captures use the app's Shift+1 (Zoom to page) shortcut. Notes-only keeps the app's automatic focus on the changed sticky note. Loading keeps the review response pending until disconnected or reset, so the skeleton is stable.

| State            | Reset URL                                              | What to inspect                                                                                                                                        |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| review           | http://127.0.0.1:5190/__fixture?state=review           | Waiting, 1 of 3 approved, changed areas and Before / After                                                                                             |
| approved         | http://127.0.0.1:5190/__fixture?state=approved         | Landed as 4f05991, not built, active proposer task; runner opens Build menu                                                                            |
| approved-person  | http://127.0.0.1:5190/__fixture?state=approved-person  | Gabriel proposed it, no proposer task; Build has no arrow                                                                                              |
| building         | http://127.0.0.1:5190/__fixture?state=building         | Recorded build, bar links to “Keep the gutter at every width is building it”; no Build action                                                          |
| conflict         | http://127.0.0.1:5190/__fixture?state=conflict         | Welcome changed on main too; 0 of 1 resolved                                                                                                           |
| notes-only       | http://127.0.0.1:5190/__fixture?state=notes-only       | Changed sticky note, no changed frames or approval checkboxes                                                                                          |
| loading          | http://127.0.0.1:5190/__fixture?state=loading          | Review title and decisions skeletons                                                                                                                   |
| not-landed       | http://127.0.0.1:5190/__fixture?state=not-landed       | Approval hit main's change while landing: Did not reach main, Ask Designer to update, Choose what to keep (opens Changed on main too; captured closed) |
| no-one           | http://127.0.0.1:5190/__fixture?state=no-one           | Gabriel's proposal, 1 note kept, nobody is working on it; Start a task                                                                                 |
| terminal         | http://127.0.0.1:5190/__fixture?state=terminal         | 1 note sent to a terminal on MacBook Pro; no button                                                                                                    |
| approved-removed | http://127.0.0.1:5190/__fixture?state=approved-removed | Landed as 4f05991 with its branch removed: left panel reads main · branch removed; Build menu open                                                     |

Run every capture in an environment with Playwright Chromium available. Output is `output/review-canvas/<state>-<width>.png`, always 900 px tall at device scale 1. Each command logs the real redirected URL and fails on page errors, HTTP errors or remote requests.

```sh
node docs/evidence/review-canvas/capture.mjs review 1440
node docs/evidence/review-canvas/capture.mjs review 700
node docs/evidence/review-canvas/capture.mjs approved 1440
node docs/evidence/review-canvas/capture.mjs approved 700
node docs/evidence/review-canvas/capture.mjs approved-person 1440
node docs/evidence/review-canvas/capture.mjs approved-person 700
node docs/evidence/review-canvas/capture.mjs building 1440
node docs/evidence/review-canvas/capture.mjs building 700
node docs/evidence/review-canvas/capture.mjs conflict 1440
node docs/evidence/review-canvas/capture.mjs conflict 700
node docs/evidence/review-canvas/capture.mjs notes-only 1440
node docs/evidence/review-canvas/capture.mjs notes-only 700
node docs/evidence/review-canvas/capture.mjs loading 1440
node docs/evidence/review-canvas/capture.mjs loading 700
node docs/evidence/review-canvas/capture.mjs not-landed 1440
node docs/evidence/review-canvas/capture.mjs not-landed 700
node docs/evidence/review-canvas/capture.mjs no-one 1440
node docs/evidence/review-canvas/capture.mjs no-one 700
node docs/evidence/review-canvas/capture.mjs terminal 1440
node docs/evidence/review-canvas/capture.mjs terminal 700
node docs/evidence/review-canvas/capture.mjs approved-removed 1440
node docs/evidence/review-canvas/capture.mjs approved-removed 700
```

The four later states pair with DesignReviewCanvasNotLanded, DesignReviewCanvasNoOne, DesignReviewCanvasTerminal and DesignReviewCanvasApproved, for example `uv run --no-project --python 3.13 --with pillow python design/tools/pair.py output/review-canvas/no-one-pair-1440.png output/design/DesignReviewCanvasNoOne-1440.png output/review-canvas/no-one-1440.png`.

`PORT` can select another port in the Parity range 5180–5199; use the same value for server and runner.

For board parity, render the approved references from main and pair them with the two primary states:

```sh
node design/tools/render.mjs --main DesignReviewCanvas
node design/tools/render.mjs --main DesignReviewCanvasApproved
python3 design/tools/pair.py output/review-canvas/review-pair-1440.png output/design-main/DesignReviewCanvas-1440.png output/review-canvas/review-1440.png
python3 design/tools/pair.py output/review-canvas/review-pair-700.png output/design-main/DesignReviewCanvas-700.png output/review-canvas/review-700.png
python3 design/tools/pair.py output/review-canvas/approved-pair-1440.png output/design-main/DesignReviewCanvasApproved-1440.png output/review-canvas/approved-1440.png
python3 design/tools/pair.py output/review-canvas/approved-pair-700.png output/design-main/DesignReviewCanvasApproved-700.png output/review-canvas/approved-700.png
```

Browser-free verification (does not start a server or browser):

```sh
node --import tsx docs/evidence/review-canvas/fixture-server.ts --check
node --check docs/evidence/review-canvas/capture.mjs
```

The in-process check exercises all eleven resets, redirects, review/design/inbox/account JSON, Before/After frame assets, change rectangles, loading cancellation, persisted/idempotent ticks, reset, rejection of stale ticks and ticks on answered proposals, blocked mutations, and Vite compilation of the fixture entry, real layout, Design page, CanvasReview and BuildDesign.

Verified here: the in-process check, repository TypeScript check, targeted lint and runner syntax check pass. A startup attempt reached the loopback listener, but this sandbox rejected binding `127.0.0.1:5190` with `EPERM`; HTTP listening could not be verified.

Limitations: no browser was launched in the authoring environment, so screenshots, click selectors and visual parity still need the orchestrator's run. The frame contents use the reference board's Welcome markup and its illustrative placeholders, not a second implementation of the review UI. Before HTML and change rectangles are synthetic fixtures, not a real Git diff or browser measurement. Empty state art is an unchanged HTML/SVG frame because the current canvas data model represents frames and notes; it will carry the product's frame label. Only the five named pages are seeded (the illustrative “9 more” pages are omitted). Zoom, responsive layout, inspector copy, fonts and frame labels come from the real app and should be reported as parity gaps if they differ; the fixture does not override product CSS or view state to hide them. Build, approve, changes and conflict mutations are intentionally disabled; this is capture evidence, not an end-to-end landing/build test. No product code or `design/` files changed.
