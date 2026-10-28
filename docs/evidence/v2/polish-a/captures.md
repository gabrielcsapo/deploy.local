# Polish A captures

Run from the repository root. This one-process Vite fixture listens only on 5194,
imports no coordinator/worker/database code, and keeps mutations in memory.

```sh
node docs/evidence/v2/polish-a/fixture-server.mjs
```

In another terminal, capture and pair everything:

```sh
node docs/evidence/v2/polish-a/capture-all.mjs
```

Individual exact commands (quote URLs containing query parameters):

```sh
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/inbox?tab=answered' docs/evidence/v2/polish-a/captures/Inbox 1440,700 1000
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/inbox?tab=answered' docs/evidence/v2/polish-a/captures/AnsweredPhone 390 844
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/live' docs/evidence/v2/polish-a/captures/Live 1440,700 1100
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/live/home-gym-sync' docs/evidence/v2/polish-a/captures/Worker 1440,700 1000
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/live?board=AutoRollback' docs/evidence/v2/polish-a/captures/AutoRollback 1440,700 1100
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/projects/deploy%2Elocal/releases' docs/evidence/v2/polish-a/captures/Deployments 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/projects/home-gym/releases/b81e4c0' docs/evidence/v2/polish-a/captures/ReleaseFailed 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/settings/backups' docs/evidence/v2/polish-a/captures/Backups 1440,700 1240
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/settings/backups?restore=pre-release' docs/evidence/v2/polish-a/captures/RestoreData 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/' docs/evidence/v2/polish-a/captures/AppsHome 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/start/project' docs/evidence/v2/polish-a/captures/NewProject 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/discover/immich' docs/evidence/v2/polish-a/captures/InstallApp 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/dashboard/tasks/FirstTask' docs/evidence/v2/polish-a/captures/FirstTask 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5194/about' docs/evidence/v2/polish-a/captures/LandingPhone 390 844
```

Stop the fixture with Ctrl-C when finished. Board left / implementation right pairing
uses `design/v2/tools/pair.py`; `capture-all.mjs` runs it for every width.

- NewProject seeds the result of **Inspect repository** through a fixture-only Vite
  transform. Production requires pressing that action; it reads a temporary bare clone.
- InstallApp uses the real `/dashboard/discover/immich` route and fixture catalog metadata.
- FirstTask mounts the actual task page. `/dashboard/tasks/LaterTask` uses the same
  fixture with `firstTask: false` for the negative check, even after local storage reset.
- AnsweredPhone captures responsive web at 390, not the native SwiftUI page. Native
  presentation is outside this pass; only its additive Codable mirror changed.
- RestoreData opens the actual shared Dialog via `?restore=pre-release`. Check it is
  centered at both widths, with a scrim, Escape, Tab containment and focus restoration.
- AutoRollback's Undo must POST `{ from: "81be0d2", to: "9c3e1fa", ... }` to the project's
  rollback endpoint. Start, Ask Scout and Back up now also mutate only fixture state.
  Inspect recorded bodies at `http://127.0.0.1:5194/api/fixture/requests`.
- The LandingPhone image is copied from the existing iPhone Live capture, not re-rendered.

Chromium was attempted here but could not launch: `bootstrap_check_in ... Permission
denied (1100)`. See `capture-attempt.log`. No post-fix screenshots or visual sign-off
are claimed; the orchestrator must capture, pair and inspect these screens.
