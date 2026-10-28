# Releases integration

Merged `codex/v2-releases` (`39ad80e`) into `codex/v2-integrate-releases` with merge commit
`6a67941` (`Merge releases into v2 and unify Live rollback decisions`). Both parents are
preserved. No push, rebase, other-worktree edits or live-system changes were performed.

## Completed

- Kept all health, release and rollback event variants/imports and both sets of shared types:
  LiveApp, LiveResponse, LiveAppResponse, Project and RollbackDataLoss. Existing public types
  were not changed.
- Unified native producers on `createInboxItem(owner, item, context)` and `v2-inbox-native`.
  Context stays private. Stable IDs deduplicate creation; answers and durable rollback
  admission share the immediate transaction. Retries return 409 with the first answer.
  Advertised keep/dismiss/not-now actions require no handler. Other actions without a
  registered handler return 501 and remain waiting. Registration returns an unregister
  function which cannot accidentally remove a newer registration.
- Live now requests rollback through the release service. Never suppresses it; unrestricted
  allow starts rollback without a decision; ask creates the release service's decision with
  its project/from context. The first-hour boundary and owner scope remain enforced. Multiple
  reports deduplicate the same decision; concurrent rollback admission uses the project lock.
- Release records retain the resolved project snapshot privately. Older receipts resolve the
  project before decision creation, never in the synchronous answer handler. A pointer check
  after that lookup prevents acting on evidence from a superseded release.
- Live's release ID and activation timestamp come from current project-release pointers,
  including rollback. Older pointers fall back to Activate step timestamps. Pointer changes
  invalidate cached Live responses. No `v2-health-release` or separate producer store remains
  in active code.
- Both Live and Worker Roll back buttons answer the shared inbox decision. They use the
  advertised keep/dismiss action and show errors with a project rollback review link.
  Release/rollback events now refresh Live as well as health/inbox events.
- Updated Live and releases tests; added native producer tests. HTTP integration exercises
  authenticated failing-worker reports, inbox reads and answers, whole-project runtime
  rollback of two apps, unrestricted allow without a decision, and never without rollback.
  Additional assertions cover first-hour boundaries, context privacy, metadata after rollback,
  event variants, unregister behavior, missing handlers and first-answer-wins.
- Documented the unified API in `server/v2/README.md`. No schema changes were needed.

## Validation

- `pnpm install --frozen-lockfile`: passed; incidental tracked pnpm cache changes were restored.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with warnings, no errors.
- `pnpm format:check`: passed.
- `pnpm build`: passed.
- `node --test server/v2/*.test.ts`: **52 passed, 0 failed**.
- `node --test server/*cli*.test.ts`: **33 passed, 0 failed**.
  See [CLI output](integration/cli-tests.log).
- Final `pnpm test`: **676 tests: 659 passed, 4 failed, 13 skipped, 0 cancelled**, exit 1.
  See [full output](integration/full-suite.log). The four failures match earlier slice evidence:
  two unchanged `server/ca-profile.test.ts` assertions under system LibreSSL; unchanged
  `server/catalog-api.test.ts` Home Assistant readiness without Docker; and unchanged
  `server/legacy-preserving-update.test.ts` reading Linux `/proc/self/fd` on macOS.
- The first full run used the normal four-file concurrency and had 648 passes, the same four
  failures, 13 skips and 11 cancellations in `application-api.test.ts` after a port collision.
  The final run used a temporary Node preload to execute files serially, removing those
  cancellations. The preload also allocated ephemeral listeners only within 5180–5199 and
  refused other TCP/UDP ports. This is an isolated harness run, not an unmodified green suite.
- All database runs used temporary directories. Full-suite Docker access was disabled with
  an unavailable socket, a temporary `docker` executable returning failure, and disabled
  Docker integration opt-ins. Only fixture processes started here were stopped; no running
  coordinator, worker, service or container was stopped or reconfigured.

## Visual evidence and deliberate differences

The integration changes behavior of existing controls; it adds no screen or design-system
styles. Reviewed Live and Worker reference renders at 1440/700, their markup and button CSS.
Primary rollback buttons retain their existing placement and appearance, now as native
buttons with pending/error behavior. Production decisions use the releases service's
“Roll back” and “Keep release” wording; the existing visual fixture retains “Roll back
home-gym” and “Not now”. Error states add a link to the project's rollback review, including
when backup consent is required. Earlier layout/content differences remain documented in
[slice 2 notes](../2-live/notes.md) and [slice 4 notes](notes.md).

Fresh screenshots and browser interaction checks could not be completed: Playwright Chromium
terminated during launch with `bootstrap_check_in … Permission denied (1100)`. No alternative
browser or computer-use path was attempted. The isolated fixture on 5188 and Vite on 5189
were stopped. [Capture instructions](integration/captures.md) specify both exact URLs,
1440/700 widths and heights; [fixture entry point](integration/fixture-server.mjs) reuses
the committed Live fixture. The orchestrating session must capture, pair and inspect these
screens. Existing slice screenshots do not verify this integration's changed interactions.

## Next slice / limits

The full suite is not green for the four environment failures above, and fresh visual checks
remain blocked. All implementation items in this integration task are complete.

A first release without a prior project receipt cannot roll back; Live does not create an
unanswerable decision for it. Irreversible migrations still require explicit backup review
through the project release UI. No live Docker rollback was attempted: integration tests use
an isolated fake runtime, while the existing runtime tests exercise the graph adapter with
fake Docker transport. The existing slice 4 limits (remote placement, multi-app membership
authoring, recovery and cross-path fencing) are unchanged; see its notes before deployment.
