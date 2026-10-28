# Slice 1 web · Waiting on you

## Implemented

- The sidebar reads Waiting on you from `/api/v2/inbox` and consumes `/api/v2/events` with a shared cursor and long-poll subscription. Answering in a card updates the sidebar and other mounted cards immediately. Replay cannot restore an answered item to Waiting. Unmount and account changes abort pending reads and discard old responses.
- Today and Yesterday use `/api/workspace/state`, ordered by latest task activity. The latest run supplies running, ready and stalled states. Agents use the optional `/api/v2/agents` envelope `{ agents }`, falling back to the two built-in agents, Scout and Warden. The section appears only with more than one agent.
- Live uses `/api/v2/live` → `summary: { running, failing }`. A 404 hides it; other failures say Unavailable. Account and online computer count come from `/api/user` and `/api/nodes`. Ancillary sidebar resources refresh every ten seconds; inbox events stay live through the server's long-poll feed.
- `/dashboard/inbox` has Waiting and Answered tabs. Actions send `on: 'web'`; a 409 replaces the card with the stored answer and reports the conflict. Answered cards stay mounted as dashed records. Free-text questions require an answer, failed requests retain the decision, and server-supplied confirmation text opens a confirmation dialog.
- `app/routes/dashboard/v2/inbox/InboxDecision.tsx` exports `<InboxDecision itemId={event.inboxItemId} />` for conversation `decision` events. It uses the `InboxProvider` already mounted by `V2Layout`.
- Both production `server.ts` and development `server/index.ts` call `handleWebRedirect` before rendering. It calls the existing `permanentRedirectResponse` adapter, returns HTTP 308, and resolves application ownership with the existing authenticated repository data. Cookie/header authentication is supported. Missing browser-local credentials or unavailable lookup retain the client fallback. Responses are private and not cached across accounts. `server/api.ts`, schema, shared contracts, design sources and other routes were not changed.

## Parity and deliberate differences

Read the brief, design rules, Home and Inbox markup, bundle CSS, and all four 1440/700 reference renders. **Visual parity was verified afterwards by the orchestrating session** (see Visual review below). The agent itself could not open a browser: The computer-use tool could not obtain a Chrome or Safari window (`cgWindowNotFound`); Chrome and in-app browser connections were unavailable. Automatic approval review rejected opening Finder to launch a browser, without supplying further detail. A request to open a Chrome window was sent while implementation and tests continued. No browser interaction or screenshot is claimed.

Intended differences from the boards:

- Inbox defaults to Waiting; `?tab=answered` selects the board's Answered view. Answered rows retain the board's grouped structure, agent glyph, title, metadata and action label. The caption says “Answering anywhere answers everywhere,” without implying a particular desktop device.
- Health-after-answer, release IDs, rule provenance and elapsed control duration are omitted: `InboxItem` does not contain those outcomes. The UI never invents a healthy state or a released commit. Answer labels come from the server's actions instead of guessing Approved/Not now. The API currently produces only questions and control requests; other kinds render when their producers land.
- Answer records show the stored user, client, local date/time and note. Legacy answers without provenance explicitly say details are unavailable. A question whose title equals its text does not repeat the prompt.
- Waiting uses the existing Approval component; Answered history uses the Inbox board's list rows. Selecting a historical row opens its full dashed record. A decision answered while Waiting is open stays visible there until navigation, while its waiting count drops immediately.
- Task ready and stalled states add a check and a warning clock when the API reports them. The Home board's fixtures show two running tasks and leave other task states unmarked. Only decisions use the attention glyph.
- Unknown computer counts and failed data reads say Unavailable rather than showing zero. Live is absent on 404 as required by this slice, even though the design-system prose says it always has a summary.
- Search and the existing Home composer/actions remain disabled pending their slices. Home's sample-data caption is hidden through the owned shell stylesheet; the Home module itself is outside this task's file boundary. Other placeholder screens retain their sample label.
- Scout and Warden are built-in product identities, not sample data. Optional agent API results replace that built-in list; no custom agent is invented.

No design files were changed. Browser keyboard, compact drawer, scrolling, request recovery, and screenshot comparison still need visual verification at 1440 and 700.

## Verification

- `pnpm install --frozen-lockfile`: passed; restored the generated tracked pnpm cache change.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with existing warnings, no errors.
- `pnpm format:check`: passed.
- `pnpm build`: passed; see `build.log`.
- `node --test server/web-redirects.test.ts server/v2-redirects.test.ts app/routes/dashboard/v2/data/inbox-store.test.ts`: **36 passed, 0 failed**; see `focused-tests.log`. Covers stub-fetch subscription sharing, cursor continuation, abort, account reset, event replay, expiry, successful/409/failed answers, optional 404 resources, task states and calendar boundaries. HTTP tests exercise GET `/dashboard/nodes` → 308 with Location `/dashboard/computers`, a real temporary home-gym repository, cookie/header authentication, owner isolation, SSR bypass and both host mounts. The app tests run explicitly because `pnpm test` discovers only `server/**/*.test.ts`.
- Final `pnpm test`: **639 tests; 611 passed, 4 failed, 11 cancelled, 13 skipped**, exit 1; see `full-suite.log`. The unchanged failing files match earlier slices: two certificate tests in `server/ca-profile.test.ts` (system OpenSSL verification options and the expected correction exception), Home Assistant readiness in `server/catalog-api.test.ts` with Docker unavailable, and Linux `/proc/self/fd` in `server/legacy-preserving-update.test.ts` on macOS. `server/application-api.test.ts` cancels eleven children after an HTTP socket closes during setup, also reported in the inbox API slice. These remain unverified environmental failures, not a green suite.
- The first full run additionally exposed a fixed-port collision in the new redirect test. Fixed the test to try free ports only within 5180–5199 and reran the suite; every new redirect test passed in the recorded final run.
- The suite used temporary data, an unavailable Docker socket and a fixture-only Docker executable, plus the existing `../1-inbox-api/test-guard.mjs` preload to constrain test listeners. No live services, workers or containers were stopped, restarted or reconfigured.
- The isolated Vite page returned HTTP 200. Its development SSR path logs the previously documented `workspace-icons.json?ssr` parse problem and falls back to client rendering. This is not a browser verification; production build succeeds.

## Finish the visual review

`fixture.mjs` contains capture-only board data; no fixture is imported by production code. With ports 5192 and 5193 free, run in separate terminals:

```sh
INBOX_FIXTURE_BOARD=Inbox node docs/evidence/v2/1-inbox-ui/fixture.mjs
DEPLOY_DATA_DIR=/private/tmp/v2-inbox-ui-data DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5193 pnpm exec vite --host 127.0.0.1 --port 5192 --strictPort
```

Open `http://127.0.0.1:5192/dashboard/inbox?tab=answered` and capture 1440 × 1000 and 700 × 1000. For Home, restart only this fixture without `INBOX_FIXTURE_BOARD`, open `/dashboard`, and capture 1440 × 900 and 700 × 900. The fixture provides seven running apps for Inbox and one failing app for Home, two/three waiting decisions, the board's task names, Scout, Warden, Gabriel, SER and bazzite. Stored timestamps use the capture day. Check Waiting actions, free-text input, the answered collapse, historical rows and the compact drawer. Stop both preview processes afterward.

Pair each capture using `design/v2/tools/pair.py` with its matching reference PNG, save `Inbox-1440.png`, `Inbox-700.png`, `Home-1440.png`, and `Home-700.png` here, and update this note after visual inspection. The capture-only fixture has no real release, rollback or computer actions.

## Integration notes

- Conversation views must render every `decision` through `InboxDecision`; they should not synthesize independent approval state or answer through the legacy API.
- The Live branch should preserve `summary.running` and `summary.failing`. Agents may supply `{ agents: [{ id, name, ... }] }`; before that endpoint exists the two built-ins remain visible.
- The API lacks result health, release IDs and rule provenance on `InboxItem`; adding those would require an additive contract in a later slice. Nothing in this change changes existing contracts.
- HTTP redirect lookup uses the same owner-scoped repository association as `/api/workspace/application-repositories`. Browser-local authentication continues through the unchanged client resolver.

## Visual review (added by the orchestrating session)

Captured with Playwright Chromium against `fixture.mjs` and Vite on 5192/5193, then paired with `design/v2/tools/pair.py` (board left, implementation right): `Inbox-1440.png`, `Inbox-700.png`, `Home-1440.png`, `Home-700.png`; raw captures in `captures/`.

- Home matches the board at both widths.
- Inbox matches in structure, tabs, grouping, glyphs and labels. One difference to fix in a polish pass: answer provenance reads `Gabriel · web · 10/27/2026, 9:41:04 PM`. The board says `you answered at 2:33 PM from the menu bar`. Format it as "you answered at <time> on iPhone / on this Mac / from the menu bar / in the terminal", with the date only when it isn't today or yesterday.
- Outcome chips (Healthy after 10 min, Released 0d96f82) are absent until `InboxItem` carries outcomes, as noted above.
