# Slice 11, part 1 · Public site

Branch: `codex/v2-public`. Read the implementation brief, design-system rules, earlier slice
notes, and the Landing, LandingPhone, Changelog, AppNotFound and AppUnavailable markup and PNGs.
No design sources, docs routes, global styles, root layout, shared sidebar, schema, or other
worktrees were changed. No running install, worker, app or container was altered.

## Implemented

- `/about` renders the Landing product page: hero, exact install command with clipboard success
  and failure feedback, real Live screenshots, three pillars, computer roles, device descriptions,
  source/docs/sign-in navigation, and footer. Phone navigation uses a native disclosure menu.
  Hanken Grotesk is bundled locally, with its OFL license. All styling lives in this slice.
- Changelog still imports `CHANGELOG.md?raw` at build time. It handles linked and plain release
  headers, integration notes, wrapped bullets and `-`/`*` lists. Dated releases sort newest first;
  undated integration entries retain their source position. Features become New; bug fixes,
  performance, security and reverts become Fixed. Internal chores are omitted. Historical entries
  have source-keyed plain-language edits; new entries get conventional-prefix/markdown cleanup.
  Source release/commit links remain available, and only HTTP(S) links are rendered.
- The edge recognizes both `<app>.deploy.local` and existing `<app>.local` addresses for HTTP
  and WebSocket route selection. Unknown app hosts return a static 404 with a deterministic
  edit-distance suggestion and an absolute link to Apps at home. Empty catalogs still offer a
  useful way back. Stopped apps, active rollbacks and unavailable backends get static 503 pages,
  no-store, Retry-After and Refresh headers, plus a five-second HTML refresh. HTML values are
  escaped, HEAD responses have no body, and the pages make no external requests.
- Edge state is a one-second, read-only snapshot of existing deployment rows and owner-scoped
  `v2-health`, `v2-release` and `v2-rollback` records. It does not initialize databases, migrate,
  call the coordinator API or invoke Docker. It uses Live names when available, the assigned
  computer, and rollback step timestamps. The rollback page stops intercepting traffic once
  activation finishes; the ten-minute watch phase does not keep a healthy app unavailable.
  Both the split edge and single-process runtime register these page metadata providers.
- In-app 404 and error recovery use the shared v2 Empty component with Home and Live links.
  Error recovery also offers Reload page and does not expose raw server errors.
- Tests cover unknown hosts and closest matches, aliases, escaping, empty catalogs, rollback
  interception and reload headers, HEAD, owner isolation, activation completion, read-only
  snapshots, single-process metadata registration, changelog parsing and route registration.

## Visual status and deliberate differences

**Fresh screenshot capture, paired review and browser interaction checks remain blocked.**
The required headless Chromium capture failed at launch with
`bootstrap_check_in … Permission denied (1100)`. No desktop-browser workaround was attempted.
`captures.md` lists every exact fixture URL, size and command for the orchestrating session.
The fixture server and board-data React fixture are committed. Their URLs were checked over
HTTP, including actual `/about` and `/changelog`; all returned 200 and the board fixture served
its actual entry script. HTTP success is not visual verification.

- The shipped Live PNGs are byte-for-byte copies of the existing, real Live fixture captures at
  `docs/evidence/v2/2-live/captures/Live-{1440,700}.png`. Both were inspected. The new fixture
  capture was attempted but blocked before page load. **The phone currently uses the 700-wide
  capture scaled into the board's 240 × 300 frame. Replace it with a fresh 390-wide capture and
  re-review before visual acceptance.** The actual web Live screen differs from the board's
  native iPhone preview; we do not ship a mock UI as a product screenshot.
- LandingPhone's Safari top safe area and bottom address bar are browser chrome, so the web page
  does not draw them. The rest of the page scrolls below the preview. At 700, the screenshot is
  clipped inside its frame instead of overflowing the document. Computer roles wrap when needed,
  and the lower sections stack at phone widths. Existing v2 icons are reused for the pillars and
  device list rather than adding a second icon library.
- Public-page CSS hides only the legacy root header/footer while a `.v2-public` page is present.
  It leaves the shared files owned by the docs/sign-in session untouched. The new public header
  and footer remain inside the route. This should be simplified when the root chrome is unified.
- The changelog uses real versioned entries in production, rather than the board's invented
  commit-only release history. Its board-data fixture exercises the same renderer. The lead
  says “What’s new and what’s fixed in deploy.local.” The board's automatic-update timing claim
  is omitted because earlier slice notes explicitly leave parts of self-update unfinished. An
  All release notes link keeps the full history reachable.
- Edge pages use the current light/dark design-token values inline and the system font fallback;
  they cannot request a network font or depend on coordinator assets. App initials use the
  board's violet app color; no arbitrary persisted app color is invented. Suggestions display
  the app's stored name when no public display title is available.
- The unavailable page avoids claiming other apps are running without health evidence. It offers
  both Apps at home and Live. A rollback says it usually takes about a minute and that the return
  time is not confirmed. Stopped/unavailable apps say there is no return time yet. Exact return
  timestamps are supported by the renderer, but current persisted contracts do not supply one.

## Verification

- `pnpm install --frozen-lockfile`: passed. Its tracked pnpm cache change was restored.
- `pnpm typecheck`: passed (`typecheck.log`).
- `pnpm lint`: passed, warnings only (`lint.log`).
- `pnpm format:check`: passed (`format.log`).
- `pnpm build`: passed (`build.log`), including the separately bundled edge.
- `node --test server/edge/app-pages.test.ts server/edge/proxy.test.ts
  server/edge/response-cache.test.ts app/routes/v2-public/about/changelog.test.ts
  app/routes/v2-public/about/routes.test.ts`: **22 passed, 0 failed** (`focused-tests.log`).
- Final full `pnpm test`: **726 tests, 698 passed, 15 failed, 13 skipped, 0 cancelled**
  (`full-suite.log`, exit 1). Ten `application-api.test.ts` requests failed with closed/reset
  fixture sockets; `ci-http.test.ts` explicitly exhausted the two permitted test ports. The
  remaining four are the failures previously recorded by other slices: two LibreSSL certificate
  assertions, Home Assistant catalog readiness with Docker unavailable, and Linux `/proc/self/fd`
  on macOS. No edge/public focused test failed. These failures were not repaired outside scope.
- The first full run had 636 passed, 42 failed and 13 skipped (`full-suite-initial.log`): its
  guard returned EACCES for disallowed listener ports. The final guard reports EADDRINUSE so
  tests that scan 5180–5199 can advance to 5198–5199 without binding any other port. Full-suite
  concurrency was reduced to one. Both runs used temporary data, an unavailable Docker socket
  and a temporary Docker stub that exits without taking action. `test-guard.mjs` records the
  final isolation preload; it is evidence tooling only, not application/test infrastructure.

## Integration and remaining work

- This base has no `/about`, `/signin`, `/setup` or `/recover` entries. Only `/about` was added.
  The existing `/` import still references `home.tsx`, so it temporarily shows the product page
  until the sign-in slice replaces that route with Apps at home. `/about` must keep its product
  module. The `/signin` link depends on that slice adding its route. No cross-slice launcher
  link was added because Apps at home is not merged here.
- **DNS and TLS alias provisioning remain outside this slice.** `server/certs.ts` still generates
  explicit `<app>.local` SANs, and the existing mDNS registration uses those addresses. This slice
  routes requests for `*.deploy.local` correctly once they reach the edge, but does not change
  certificates or advertise the new aliases. The coordinator/network owner must provision these
  before treating the new addresses as trusted, resolvable URLs. Existing `.local` routes remain.
- The edge snapshot is intentionally independent of the coordinator. Later app-address work can
  add public display titles, per-app colors, visibility-aware suggestions and authoritative ETAs
  when those contracts exist; none is inferred from private project prose.
- Fresh Live captures (especially 390), all side-by-side pairs, copy/menu keyboard checks, Safari
  inspection and dark-mode visual review remain for the orchestrating session. See `captures.md`.

Both isolated fixture processes on 5198/5199 were stopped after the HTTP checks. No live services
were stopped. Changes were committed locally; nothing was pushed, merged or rebased.

## Visual review (added by the orchestrating session)

Captured with the fixture and Vite on 5198/5199, and paired (`<Board>-<width>.png`, board left): Landing at 1440 and 700, LandingPhone at 390, Changelog, AppNotFound and AppUnavailable at 1440 and 700.

- **Landing, AppNotFound, AppUnavailable:** match their boards closely.
- **LandingPhone:** shows the web Live page scaled down. The board shows the iPhone Live screen. Use the iPhone capture from `docs/evidence/v2/12-ios-1/captures/LivePhone.png` instead.
- **Changelog:** renders the real CHANGELOG.md in plain language with New/Fixed tags. The board's sample entries and PR references are illustrative.
