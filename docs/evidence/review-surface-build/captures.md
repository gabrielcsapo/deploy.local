# Retired review-surface capture fixture

The review now opens on the real Design canvas. Use [the review-canvas fixture and commands](../review-canvas/captures.md) for current evidence against `DesignReviewCanvas` and `DesignReviewCanvasApproved`.

The old server, web capture runner, smoke runner and dependent simulator capture runner have been removed. They depended on the removed standalone review screen and are not valid current capture commands. `fixture.client.tsx` remains because `../resolve-conflicts/fixture-server.ts` still imports it.

Historical evidence: on 2026-11-09 the old fixture produced iPhone 13 / iOS 26.5 captures of the cover, viewer, approval warning, point note, saved drawing, pending approval, new screen and second round under `output/review-surface/`. These ignored artifacts are historical, not verification of the current canvas. The point-note image was obscured by the first-use keyboard tutorial. Native gesture, accessibility and physical-device checks were not performed.
