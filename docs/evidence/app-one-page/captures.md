# App under its project: capture handoff

The sandbox refused `listen` on `127.0.0.1:5180` (EPERM). No app screenshots were produced or visually verified here. The approved HTML boards were read; `design/tools/render.mjs` was not invoked because it performs a Git fetch, prohibited for this task. Do not treat the successful compile as visual acceptance.

## Start the isolated fixture

From the repository root, with dependencies installed:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5180 node docs/evidence/app-one-page/fixture-server.mjs
```

It serves both the fixture API and the real React components through Vite on **127.0.0.1:5180**. The Vite WebSocket shares that server. It imports no coordinator, database, Docker or mDNS implementation and does not contact deploy.local. `PORT` accepts only 5180–5185. The fixture client supplies a local dummy sign-in and a simplified sidebar. Production routing is represented by ordinary document navigation in the fixture router.

## Web URLs

Capture at **1440 and 700 px**. Paths below are relative to `http://127.0.0.1:5180`.

| Board / check                                         | URL                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Worker                                                | `/dashboard/projects/home-gym/apps/home-gym-sync`                            |
| AppSettings, web tab row                              | `/dashboard/projects/home-gym/apps/home-gym/settings`                        |
| AppSettings, worker tab row                           | `/dashboard/projects/home-gym/apps/home-gym-sync/settings`                   |
| AppRequests                                           | `/dashboard/projects/home-gym/apps/home-gym/requests`                        |
| OneAppProject, with tasks, PRs and issues present     | `/dashboard/projects/pantry`                                                 |
| OneAppProject, fallback / Discover-style project      | `/dashboard/projects/app%3AImmich`                                           |
| Project / Running section                             | `/dashboard/projects/home-gym`                                               |
| Projects / all health tones, plus repository-only row | `/dashboard/projects`                                                        |
| ReleaseLive / Output                                  | `/dashboard/projects/app%3Adeploy%2Elocal/releases/7f3b2d4?app=deploy.local` |
| Worker Releases tab context                           | `/dashboard/projects/home-gym/releases?app=home-gym-sync`                    |
| Worker Logs tab context                               | `/dashboard/projects/home-gym/logs?app=home-gym-sync`                        |
| Live, unchanged table layout                          | `/dashboard/live`                                                            |
| Legacy Live app link, redirects under Projects        | `/dashboard/live/home-gym-sync`                                              |
| Legacy standalone link, ends at its project           | `/dashboard/live/immich`                                                     |
| Nested one-app alias, redirects to project root       | `/dashboard/projects/pantry/apps/pantry`                                     |

The first output read is empty; the second (about two seconds later) provides build output. Wait at least three seconds on ReleaseLive before capturing, and verify the Output group was absent initially. Release output and error logs are synthetic. The Requests fixture supplies summary totals but empty series/path/request lists. Sidebar tasks/agents and project care summaries are simplified; this is a layout/navigation fixture, not a pixel-identical data reproduction of all boards.

Example (use the height from the relevant board's `design-board` meta tag):

```sh
node design/tools/capture.mjs http://127.0.0.1:5180/dashboard/projects/home-gym/apps/home-gym-sync output/app-one-page/Worker 1440,700 1100
```

Compare against the approved board at each width. Check keyboard access and horizontal scrolling of tabs, the active Projects sidebar, the breadcrumb, worker Requests omission, absence of Performance, app query persistence when switching releases, and Back from a legacy redirect. Verify one-app Overview remains the app despite its fixture work records.

## iPhone handoff

Build DeployIOS with the orchestrator's Swift 6/Xcode environment. The same server supplies the Live and Projects data needed for the changed screens. In the existing Debug simulator fixture mode, launch with:

```text
--v2-fixture http://127.0.0.1:5180 --v2-board WorkerPhone
--v2-fixture http://127.0.0.1:5180 --v2-board ProjectsCarePhone
```

Capture at **390 pt**. WorkerPhone now selects Projects and pushes `[project, app]`; Back must return to the project. Also open Live, tap an app, and repeat that check. Tap Releases under App and verify the existing project release screen opens. Logs and Settings rows are intentionally omitted because there are no existing native app screens. Compare the right-hand project health labels and tones with web. Native build, tests and simulator captures were not run here.
