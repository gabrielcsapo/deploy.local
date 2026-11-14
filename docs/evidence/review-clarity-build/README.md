# Design review implementation: server and web

Implements the approved review-clarity boards from `886961ae` in `codex/review-clarity-build`. Changes are uncommitted. No files in `native/` or `design/` were changed. No server, browser, Xcode, deployment, push or release was started.

## Board behavior implemented

- **DesignToReview:** global/project-scoped proposals with plain titles, proposer identity/avatar, time, counts and conflicts. With no waiting proposal, resume the last usable project design; otherwise show projects with designs. No `projects[0]` fallback. The existing sidebar count continues to count waiting design items.
- **DesignCanvas:** waiting-review banner, opening the proposal or the project’s review list.
- **DesignReview:** proposer summary, totals, canvas-page groups in canvas/board order, native-aspect crops, New/Removed/Conflict tags, seen state and pin counts. Web grid uses three columns at 1440 and two at 700, with 200 px image boxes. Crops never enlarge beyond native pixels, include 48 px context, and expand to whole intersecting text/controls.
- **DesignReviewViewer:** one screen; Previous/Next and arrow keys; Escape closes the pin editor, then returns to the grid; screen counter; 1440/700 viewport switch (phone boards retain their native width); labelled equal-scale Before/After at wide windows, revision toggle at 700; Show changes on both revisions. New/Removed show one revision. Pins use native board coordinates, support save/edit/delete, and appear in a 280 px tray at wide windows or below the preview at 700. The grid stays mounted to preserve its scroll position; chosen width survives returning to it.
- **DesignReviewNote:** saved-pin notice and All pins list; canvas notes open complete Before/After prose, with changed lines optionally highlighted. Notes never increment the screen count.
- **DesignReviewRound2:** previous requests and proposer replies above the changed screens, Addressed/Still open, collapsed unchanged screens, previous-proposal comparison, seen reset only for revised screens, and only unresolved pins sent again.
- **Decisions:** all unresolved pins affect the primary action and count, across every screen. No-pin Ask for changes opens general feedback. Loading, failed preview reads and main checks disable decisions. Seen never gates approval. Approval retains the existing server merge path and keeps comments. Conflicts are rechecked during the answer transaction; approval uses a compare-and-swap update of the exact main commit checked.
- The task Design tab, chat card and Waiting on you entry use the same review. Slider/onion-skin controls and generated layer-diff prose no longer appear in the review flow.

## Interpretation of the approved notes

The notes explicitly supersede grouping by change type and a blanket stale rule: web groups by actual canvas page/order, and unrelated main edits do not invalidate a proposal. The wire payload retains `stale`, meaning a conflict with main, while the UI names the conflicting screens and offers Close / Ask to update.

The API permits an optional summary and returns `null` for historical proposals. Following the review correction, the UI uses the approved canvas note's quiet fallback: “No summary. Ask [proposer name] to add one”. It does not invent summary prose.

## API for the iPhone pass

Shared types live in `shared/v2/contracts.ts`: `DesignReviewSummary`, `DesignReview`, `DesignReviewScreen`, `DesignReviewPreview`, `DesignReviewPin`, `DesignReviewChange`, `DesignRect`.

All endpoints use existing owner authentication. `{project}` and `{item}` must be URL encoded. The project API prefix below is `/api/projects/{project}/design`.

| Method and route                                                     | Input / result                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/design/reviews?project={optionalProject}`                  | `{ proposals: DesignReviewSummary[] }`, waiting only, newest first. Includes title, nullable summary, project ID/name, branch, proposer `{id,name,avatar}`, createdAt, counts `{screens,changed,new,removed}`, stale, conflicts.                                                                                                                         |
| `GET /api/design/projects`                                           | Existing project list with board counts, plus nullable description. Filter `boards > 0` for usable designs.                                                                                                                                                                                                                                              |
| `POST {prefix}/propose`                                              | `{ref? ,task?,title?,summary?,changeWords?}`. Title maximum 200 characters, summary 4000. `changeWords` maps board filename → layer ID → proposer words (maximum 500 characters each). Returns `{item}`. Proposing the same branch/commit remains idempotent.                                                                                            |
| `GET {prefix}/review?item={item}`                                    | `DesignReview`, metadata only. Summary fields plus inbox item, legacy nullable task, before/after/main revisions, updatedWithMainAt, round, previousItemId, ordered boards, page groups, full note prose, pins.                                                                                                                                          |
| `GET {prefix}/review?item={item}&previews=all`                       | Same payload, adding `boards[].previews[width]` for every supported viewport. This does Chromium rendering and can take longer.                                                                                                                                                                                                                          |
| `GET {prefix}/review/preview?item={item}&board={file}&width={width}` | Progressive equivalent for one screen/width: `{width,height,before,after,areas,crop}`. Before/After are authenticated PNG URLs or null. `areas` contain `{layer,words,before,after}` where rectangles are `{x,y,w,h}` in native CSS pixels. `crop` uses the same coordinates. Both revisions render at the same viewport width and height.               |
| `POST {prefix}/review/seen`                                          | `{item,board,revision}`; revision must equal the proposal’s `after`. Returns `{seen:true}`. Persisted once per owner/proposal revision/screen, independent of width. Call only when the viewer preview is ready and visible; web waits one continuous foreground second.                                                                                 |
| `POST {prefix}/review/pins`                                          | `{item,board,width,revision,x,y,text}`. Optional `noteId` targets a canvas note instead of a screen. Coordinates are native pixels; revision must be this screen’s before or after. Returns `{pins}`.                                                                                                                                                    |
| `PATCH {prefix}/review/pins`                                         | `{item,id,text?,resolved?}`. Owners may edit or reopen addressed pins. Returns `{pins}`.                                                                                                                                                                                                                                                                 |
| `DELETE {prefix}/review/pins`                                        | JSON body `{item,id}`. Returns `{pins}`. Numbers are not reused.                                                                                                                                                                                                                                                                                         |
| `POST /api/inbox/{item}/answer`                                      | Existing `{actionId,on,note?}`, with `on: "iphone"` for the next pass. Actions: `approve`, `changes`, `update`. `changes` sends all current unresolved pins plus optional general feedback, once per answer. `update` requests rebase/update/re-proposal and is allowed only for conflicting proposals. A failed conflict check leaves the item waiting. |

Screens include `status` (`changed`, `new`, `removed`), `widths`, page ID/title, `changes` (plain element/proposer words), `seen`, `changedSinceReview`, `conflict`, and per-screen `before`/`after`. Use those per-screen revisions: unchanged historical screens can retain an older baseline. The `groups` array is authoritative for web page order. The old `added`, `removed`, `lines`, `index`, `count`, `notes` fields remain available; `lines` now contain plain words, not diff descriptions.

Pins contain `{id,number,board,noteId,width,revision,x,y,text,author,resolved,reply,createdAt}`. Their original location/revision and owner request survive a re-proposal. Looking at a pin does not resolve it. For round two, use `changedSinceReview` for the changed-screen sequence, keep other screens accessible in a disclosure/grid, and retain their `seen` values.

`deploy_design` action `propose` accepts the same title, summary and changeWords. Action `resolve` accepts `{commentId, reply?, resolved?}`; `resolved: false` records a still-open reply. Board comments return `position`, `number`, and `reply`. Task feedback is queued behind an active run; if a follow-up is already queued, the review feedback is appended rather than replacing it. Manually proposed branches without a task retain feedback/comments as a review record.

## Files changed

- `server/v2/design.ts`: review metadata, conflict checks, rendering geometry, summaries, pins, seen state, rounds and decisions.
- `server/v2/design.test.ts`: existing route tests updated and new review coverage; optional in-process transport and browser skip for restricted runners.
- `server/workspace/design-tool-schema.ts`: proposer summary/title/words and pin replies.
- `shared/v2/contracts.ts`: shared client contract.
- `shared/v2/design-review.ts`: widths, names, native-coordinate crops, areas and Next unseen.
- `app/routes/dashboard/v2/design/page.client.tsx`: landing routing, last usable project and banner.
- `app/routes/dashboard/v2/design/ToReview.tsx`: proposal/project landing.
- `app/routes/dashboard/v2/design/ItemReview.tsx`: grid, viewer, notes, pins, rounds and decisions.
- `app/routes/dashboard/v2/design/ReviewPreviews.tsx`: progressive authenticated preview loading/crops.
- `app/routes/dashboard/v2/design/Review.tsx`: task and chat review entry points, no legacy comparison controls.
- `app/routes/dashboard/v2/design/review.css`: approved responsive layouts using semantic tokens.
- `app/routes/dashboard/v2/design/review-model.ts` and `.test.ts`: navigation/count helpers and tests.
- `app/routes/dashboard/v2/inbox/InboxDecision.tsx`: design decisions open the complete review.
- This report.

## Validation and remaining gaps

- `npx tsc --noEmit -p .`: passed.
- Full requested web suite: **289 passed**.
- Server design suite through the in-process transport: **30 passed, 1 Chromium test skipped**.
- Design literal, motion and native token-parity checks: passed. `git diff --check`: passed. Targeted lint has no errors (existing and local name-shadow warnings remain).
- The normal server test command failed at `listen EPERM` before running tests. `DEPLOY_TEST_NO_LISTEN=1` runs the same route handlers through an in-process request/response transport. `DEPLOY_TEST_NO_BROWSER=1` skips the existing Chromium test. Geometry tests inject measured rectangles instead of launching a browser.
- `pnpm lint:design` could not bootstrap its pinned pnpm version because registry access failed. Its three underlying Node scripts run directly and pass. No package-manager bypass setting or lockfile was changed.
- **Visual parity is unverified:** no Chromium rendering, screenshots, 1440/700 app captures, desktop-shell run, or production build was performed. Those remain with the owner as requested. The runtime preview renderer requires the coordinator’s existing Chromium installation.
- **Layer-diff limitation:** changed-area outlines come from identified HTML layer changes. A stylesheet/library-only change with no changed board HTML does not synthesize screen rectangles. Existing non-board proposal approval behavior remains; this needs a separate rendering-diff pass for complete style-only review coverage.
- **Naming:** screen captions use real canvas titles, with filename words as a fallback. Existing long/descriptive canvas titles can be longer than the short fixture captions; they wrap rather than being truncated or replaced with invented copy.
- **Historical pin inspection:** original positions/revisions remain available through the API and comments. Round-two pins align with the previous-proposal Before view; there is no additional revision-history selector for pins older than that comparison.
- No Swift checks were run because this pass does not change native code.

## Corrections after capture review (2026-11-04)

Compared the supplied 1440/700 grid and viewer captures with the rendered DesignReview and DesignReviewViewer boards. Corrected all six reported differences:

- Preview areas now drop containers covering at least 80% of the viewport, omit unmeasured layers, and repeatedly union overlapping, nested or within-8px regions. Each union retains the first area's words and separate Before/After geometry. A sole container yields no areas or area words. Progressive and all-preview payloads share this result, including iPhone consumers; crops, outlines and “+N more” use it.
- Opening or stepping to a screen scrolls the shared stage to its first region with 48px context, accounting for rendered scale and the compact viewer's scroll container. Before/After retain one offset. The hint and revision captions stay together in a sticky stage header.
- Numeric pin/change/screen labels use singular for one, including loading, round-two, conflict, chat-card and pin-jump counts.
- Pin rows use content height and 12px padding; requests and screen names wrap fully instead of truncating above empty space.
- Missing summaries use the approved fallback, and Previous/Next follow the screen counter on the left.
- Preserved the existing uncommitted work, fixture and original captures; no `native/` or design-board edits. The fixture received only a type correction: the API handler returns `void`, so response completion is checked directly.

Validation: TypeScript passed; 303 web tests passed; 31 server design tests passed through `DEPLOY_TEST_NO_LISTEN=1`, with the existing Chromium test skipped via `DEPLOY_TEST_NO_BROWSER=1`. Added server coverage for transitive unions, nested layers, exact 8px gaps, 9px separation, revision geometry, added/removed regions, root-only suppression and 390/700/1440 payloads. Design/motion/native-parity checks and `git diff --check` passed. Production web build passed. Fresh rendered verification remains blocked: sandbox Chromium startup fails at macOS `bootstrap_check_in` with Permission denied, and the browser access host is unavailable. Original supplied captures remain unchanged; no new visual-parity claim is made.
