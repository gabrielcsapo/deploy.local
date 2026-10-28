# Integration captures

Headless Chromium could not start in this sandbox: `bootstrap_check_in … Permission denied
(1100)`. No new screenshots or visual interaction checks are claimed. The reference Live
and Worker renders were inspected at both widths. The fixture and Vite processes were stopped.

Run from the repository root with free ports 5188 and 5189:

```sh
node docs/evidence/v2/4-releases/integration/fixture-server.mjs
DEPLOY_DATA_DIR=$(mktemp -d /private/tmp/v2-integration-ui.XXXXXX) DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5188 pnpm exec vite --host 127.0.0.1 --port 5189 --strictPort
```

In another terminal, capture these exact URLs and sizes:

```sh
node design/v2/tools/capture.mjs http://127.0.0.1:5189/dashboard/live docs/evidence/v2/4-releases/integration/Live 1440,700 1100
node design/v2/tools/capture.mjs http://127.0.0.1:5189/dashboard/live/home-gym-sync docs/evidence/v2/4-releases/integration/Worker 1440,700 1000
```

Pair each capture with `design/v2/canvas/png/<Board>-<width>.png` using
`design/v2/tools/pair.py`. Inspect both widths, keyboard focus and error/retry behavior.
On fresh fixtures, each Roll back button should POST `actionId: rollback`, `on: web` to
`/api/v2/inbox/rollback%3Ahome-gym%3A9c3e1fa/answer` and remove the pending decision.
The fixture's Not now action also answers it. Restart the fixture between those checks.
Production releases advertise Keep release instead, which uses the `keep` action.
Stop both fixture and Vite after review. Neither fixture starts the real rollback runtime;
the HTTP/service integration tests verify that separately.
