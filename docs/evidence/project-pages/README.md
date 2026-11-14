# Project pages evidence

This fixture uses the real stores, API handlers, feature routes and production build. It has no router shim. No browser or long-running server was launched in the Codex sandbox; the orchestrator must capture and inspect the built pages at 1440 and 700 px.

## Run

From the repository root, with dependencies installed:

```sh
export DEPLOY_DATA_DIR="$(mktemp -d /tmp/project-pages.XXXXXX)"
node --import tsx docs/evidence/project-pages/seed.mts > /tmp/project-pages-seed.json
pnpm build
DEPLOY_ROLE=control CONTROL_PORT=5188 DEPLOY_MDNS_ADDRESS=127.0.0.1 \
  DEPLOY_PUBLIC_ORIGIN=http://127.0.0.1:5188 \
  DOCKER_HOST=unix:///nonexistent/docker.sock node dist/server.js
```

Seed before starting the server. Use an empty directory: the seed creates `owner` and refuses to replace an existing account. It prints JSON containing `username`, `token`, `pages`, and `cookieSignIn` (the validated cookie-adoption endpoint, headers and body). Keep this output private: it contains fixture credentials. It writes terminal pipeline jobs, releases, project membership, variables and encrypted fixture secrets. It constructs small bare repositories directly from Git objects, without running Git mutation commands, workers, Docker or network requests. The app's repository readers still use the real Git read APIs.

Authenticate Playwright on the server's origin with the printed token. The cookie authenticates server renders; local storage authenticates subsequent browser API calls:

```js
await context.request.post(`${origin}/api/auth/session`, {
  headers: { 'x-deploy-username': 'owner', 'x-deploy-token': token },
  data: {},
});
await context.addInitScript(
  ({ username, token }) => {
    localStorage.setItem('deploy-sh-auth', JSON.stringify({ username, token }));
  },
  { username: 'owner', token },
);
await page.goto('http://127.0.0.1:5188/dashboard/projects/many-tabs');
```

Deployments are deliberately stopped: no health probes or Docker containers are needed. They therefore say Stopped, not the board's sample Healthy. HTTP recording remains known independently of runtime health. `unmeasured` is a private service with a TCP interface and no published HTTP route; it has no HTTP traffic to record. Missing resource samples correctly say Not measured; `pantry` has no configured memory limit.

## Server-first automated proof

After starting the built app above, run in a second shell:

```sh
node docs/evidence/project-pages/server-first.mjs \
  http://127.0.0.1:5188 /tmp/project-pages-seed.json \
  output/project-pages/server-first
```

The runner signs in through the validated cookie endpoint, checks cookie attributes, and visits the project list, every many-tabs tab, nested app pages, pull/release details and the other project fixtures at 1440 and 700 px. Each direct load uses a fresh page cache. The browser uses a different timezone and locale from the server. It writes HTML, screenshots and `report.json`; each report includes HTML data presence, first complete paint time, API request counts before that paint and in the first two seconds, any skeleton observed by a mutation observer, hydration errors, and repeated fresh seeded GETs. It also delays all requests by 300 ms during an unprefetched tab click and checks that the previous page stays while the clicked tab is pending. Any failed assertion exits nonzero.

See [server-first implementation and verification](server-first.md) for route coverage, identity handling, changed files, test results and remaining limitations. The older verification inventory below describes the preceding project-page layout work, not this server-first change.

## States and paths

Paths below are relative to the server origin. Inspect each at **1440 and 700 px**.

| State                       | Path                                              | Look for                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover                    | `/dashboard/discover`                             | Projects is the current sidebar item; Projects › Discover links back; menu opens navigation at 700.                                                                                                              |
| Many project tabs           | `/dashboard/projects/many-tabs`                   | One persistent header and strip. Code, Pull requests 1, Issues 1, Apps 2, Pipelines, Releases, Logs, Settings.                                                                                                   |
| Pull requests               | `/dashboard/projects/many-tabs/pulls`             | Pull list beneath the same project strip; no duplicate header.                                                                                                                                                   |
| Pull detail                 | `/dashboard/projects/many-tabs/pulls/pull-1`      | Existing review UI under the persistent strip.                                                                                                                                                                   |
| Issues                      | `/dashboard/projects/many-tabs/issues`            | Seeded issue; stable Issues count.                                                                                                                                                                               |
| Apps                        | `/dashboard/projects/many-tabs?tab=apps`          | Two app links.                                                                                                                                                                                                   |
| Pipeline runs               | `/dashboard/projects/many-tabs/pipelines`         | 1440: original side list; 700: selected run and “5 runs” above jobs, packages and release. Click or press Enter/Space to expand, select a run, and confirm collapse.                                             |
| Releases                    | `/dashboard/projects/many-tabs/releases`          | Two releases under the same strip; open either release and go back.                                                                                                                                              |
| Multi-app project settings  | `/dashboard/projects/many-tabs/settings`          | Shared project configuration; individual app settings remain separate.                                                                                                                                           |
| Multi-app app settings      | `/dashboard/projects/many-tabs/apps/web/settings` | Web app address and resources, with project-settings link.                                                                                                                                                       |
| One-app / quiet hour        | `/dashboard/projects/pantry`                      | Requests per minute **0**, “No requests in the last hour”; p95 **—**, “No requests to time”; memory Not measured with reason.                                                                                    |
| One-app settings / no limit | `/dashboard/projects/pantry/settings`             | Address, Health and resources, Variables and secrets, Repository, Releases, existing Packages policy, Remove. No handoff notice. Memory limit says **No limit**. Singular wording and coordinator's actual name. |
| Old one-app settings URL    | `/dashboard/projects/pantry/apps/pantry/settings` | Replaces location with `/dashboard/projects/pantry/settings`. Back does not return to a second settings page.                                                                                                    |
| Requests                    | `/dashboard/projects/pantry/requests`             | Existing successfully empty Requests state, beneath persistent tabs.                                                                                                                                             |
| Performance                 | `/dashboard/projects/pantry/performance`          | Existing successfully empty Performance state.                                                                                                                                                                   |
| Traffic not measured        | `/dashboard/projects/app%3Aunmeasured`            | **Not measured**, “Traffic is not recorded for this app”; never invented zero traffic.                                                                                                                           |
| Preparing repository        | `/dashboard/projects/preparing/code`              | Existing “Repository is not ready; inspect its setup operation” notice and Retry; no “Could not open this page” crash.                                                                                           |
| Small project               | `/dashboard/projects/small`                       | Overview, Code, Settings; same stable parent behavior.                                                                                                                                                           |
| Live numeric fallbacks      | `/dashboard/live`                                 | Quiet and unmeasured apps use the same measurement semantics.                                                                                                                                                    |
| Computer measurements       | `/dashboard/computers/coordinator`                | Unreported CPU, memory and disk say Not measured with the missing-report reason.                                                                                                                                 |

Multi-app project tabs retain existing availability: Requests and Performance are per-app destinations. Also check `/dashboard/projects/many-tabs/apps/web/requests` and `/dashboard/projects/many-tabs/apps/web/performance`.

## Navigation proof

After the initial project load, retain references to `header.dl-head` and `.v2-project-page .dl-tabs`. Click through Overview → Code → Pull requests → Issues → Apps → Pipelines → Releases → Logs → Settings, then back/forward. Assert those same DOM nodes remain connected and identical throughout, including pending RSC responses. Delay requests by 300 ms: the clicked tab must be pending, the previous content must remain until the destination is ready, and no fallback or skeleton may appear. Check computed `display: inline-flex` and the label/count gap on the Pull requests tab. Repeat on pantry including Requests and Performance, and on the small project.

At 700, choose a tab beyond the visible edge and resize with that tab selected. It must be revealed without scrolling the page. The trailing fade appears only when content remains beyond the right edge. Scroll to the final tab and check the fade clears. Retained counts must survive a failed refresh, not turn into zero or disappear.

For server-first proof, the initial response must contain the pantry metrics and the browser must skip the fresh seeded `/api/live/pantry` request. Separately test the legacy path without a cookie: delaying that request retains the original skeleton, and rejecting it shows the retry notice, not zero traffic. Subsequent refreshes retain previously known answers. Missing browser timings, ratings and layout-shift values on Performance say Not measured and explain what was not reported; zero-request comparison periods use a dash and “No requests to time”. These partial telemetry cases are covered by component tests; the seed intentionally has no browser telemetry producer.

## Differences from the board

- Existing domain and health-check configuration remains declared in `deploy.yaml`; this work retains its current address row and memory edit/Save control. It does not invent domain/DNS/certificate management or computer-move controls that the web page cannot perform. The approved grouping and one-page navigation are implemented.
- The existing **Packages / Install through deploy.local** setting remains between Releases and Remove so the consolidation does not remove functionality.
- The one-app overview retains existing Runtime and Recent releases sections and the add-app action. Its metric strip now contains Requests per minute, p95 latency and Memory, including the approved quiet copy. No synthetic “Recent” activity feed is created.
- For a quiet last minute after earlier requests in the hour, latency says “No requests in the last minute to time”; it does not claim the entire hour was quiet. Missing telemetry carries field-specific reporting reasons. These states are not drawn on OneAppQuiet.
- When a pipeline has a deployment record, its existing status and release link follow Packages. The sample board has no such record. Above 820 px, the existing run-list layout is preserved.
- Fixture-specific differences: stopped apps instead of Healthy, no measured memory usage, locally hosted repositories without an upstream remote, and sample project/release/job data. No fabricated health or measurements.

## Implementation and numeric inventory

A1 was caused by sibling routes under the dashboard Suspense boundary and independently rendered Pull requests/Releases chrome. `projects/layout.tsx` now keeps `Projects` / `ProjectPage` and its `DetailTemplate`, header, Tabs and overview/release data mounted. `ProjectPanel` puts the child `Outlet` inside a content-only Suspense boundary. Feature `routes.ts` files still own their routes. Pull requests and Releases render panels only. `useData` retains answers on refresh and prevents one path's data appearing on another path. A3 guards the optional `refs` in a preparing repository response.

Every numeric “Unavailable” replacement:

- `projects/app.client.tsx`: single-app request rate, p95 latency, and memory limit in both Settings and Runtime. The former worker-only numeric fallback branches in this web-only compact overview are removed; workers still use AppDetail. Memory usage is now an independent metric with an explicit missing-report reason.
- `live/page.client.tsx`: app-table traffic, worker job baseline, HTTP p95; queue missing-report wording is made explicit too.
- `computers/page.client.tsx`: CPU, memory and disk measurements.
- `projects/performance.ts`: missing timing and percentage formatters, including route/release comparisons.
- `projects/performance.client.tsx`: missing browser ratings and both layout-shift renderings.

`server/v2/measurements.ts` extends each Live app response with discriminated `traffic` and nullable `memoryBytes`, without altering the existing health contract. Traffic recording and last-hour counts are independent of HTTP health checks. Both the compact overview and Live consume this metadata. Existing nonnumeric unavailable states (identity, capability, repository metadata and request failures) retain their meaning.

## Verification

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with existing repository warnings.
- `pnpm lint:design`: passed.
- `pnpm build`: passed, including nested project routes in the production route tree.
- Project, Live, sidebar, shared UI and neighbouring feature tests: passed (116 tests); includes route parent identity, refresh retention, preparing repository, singular settings, compact run selector, tab scrolling/fade and metric semantics.
- Seed plus neighbouring server Live, health, Performance, Projects and contracts tests: passed (46 tests).
- No screenshots, browser mount-duration measurement or real-app pixel/layout comparison were performed in the sandbox. The orchestrator must run the navigation proof and captures above.

The installed pnpm here is 11.25.0; the repository pins 11.1.3, whose download is blocked in this sandbox. Checks used a command-local `--pm-on-fail=ignore` override, with the same override passed through a temporary PATH wrapper for the build's nested pnpm call. Node was 26.8.1. No repository package-manager settings were changed.

Re-run the tests without a browser:

```sh
node --import tsx --import ./scripts/test-css-stub.mjs --test \
  app/routes/dashboard/discover-sidebar.test.ts \
  app/routes/dashboard/v2/projects/*.test.* app/routes/dashboard/v2/live/*.test.* \
  app/components/ui/v2/*.test.* \
  app/routes/dashboard/v2/start/*.test.* app/routes/dashboard/v2/tasks/*.test.* \
  app/routes/dashboard/v2/releases/*.test.* app/routes/dashboard/v2/computers/*.test.*
node --import tsx --import ./scripts/test-css-stub.mjs --test \
  docs/evidence/project-pages/seed.test.mts \
  server/v2/{live,health,performance,projects,projects-performance,contracts,measurements}.test.ts
```

## Files changed

- `app/components/ui/v2/Tabs.tsx`
- `app/components/ui/v2/tabs.test.mjs`
- `app/routes.ts`
- `app/routes/dashboard/discover-sidebar.test.ts`
- `app/routes/dashboard/v2-layout.client.tsx`
- `app/routes/dashboard/v2/computers/page.client.tsx`
- `app/routes/dashboard/v2/live/measurements.test.ts`
- `app/routes/dashboard/v2/live/measurements.ts`
- `app/routes/dashboard/v2/live/page.client.tsx`
- `app/routes/dashboard/v2/projects/app.client.tsx`
- `app/routes/dashboard/v2/projects/code-preparing.test.mjs`
- `app/routes/dashboard/v2/projects/code.client.tsx`
- `app/routes/dashboard/v2/projects/content.client.tsx`
- `app/routes/dashboard/v2/projects/data.test.mjs`
- `app/routes/dashboard/v2/projects/data.ts`
- `app/routes/dashboard/v2/projects/layout.tsx`
- `app/routes/dashboard/v2/projects/page.client.tsx`
- `app/routes/dashboard/v2/projects/performance-view.test.ts`
- `app/routes/dashboard/v2/projects/performance.client.tsx`
- `app/routes/dashboard/v2/projects/performance.test.ts`
- `app/routes/dashboard/v2/projects/performance.ts`
- `app/routes/dashboard/v2/projects/pipelines.client.tsx`
- `app/routes/dashboard/v2/projects/pipelines.css`
- `app/routes/dashboard/v2/projects/pipelines.test.mjs`
- `app/routes/dashboard/v2/projects/projects.css`
- `app/routes/dashboard/v2/projects/remove-dialog.test.mjs`
- `app/routes/dashboard/v2/projects/routes.ts`
- `app/routes/dashboard/v2/projects/routing.test.ts`
- `app/routes/dashboard/v2/projects/routing.ts`
- `app/routes/dashboard/v2/projects/settings.client.tsx`
- `app/routes/dashboard/v2/projects/settings.test.mjs`
- `app/routes/dashboard/v2/releases/page.client.tsx`
- `app/routes/dashboard/v2/releases/routes.ts`
- `app/routes/dashboard/v2/start/page.client.tsx`
- `app/routes/dashboard/v2/tasks/pulls.client.tsx`
- `app/routes/dashboard/v2/tasks/routes.ts`
- `docs/evidence/project-pages/README.md`
- `docs/evidence/project-pages/seed.mts`
- `docs/evidence/project-pages/seed.test.mts`
- `server/v2/live.ts`
- `server/v2/measurements.test.ts`
- `server/v2/measurements.ts`
