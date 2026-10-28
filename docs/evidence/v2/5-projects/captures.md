# Slice 5 capture handoff

Headless Chromium aborted under the sandbox (`bootstrap_check_in … Permission denied`).
No implementation captures or pairs were produced, and visual parity is **unverified**.
See `capture-attempt.log`. No desktop browser or computer-use tool was used.

Run the fixture and UI in separate terminals from the repository root:

```sh
node docs/evidence/v2/5-projects/fixture-server.mjs
DEPLOY_DATA_DIR=/private/tmp/deploy-v2-project-preview DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5195 pnpm exec vite --host 127.0.0.1 --port 5196 --strictPort
```

The fixture is in-memory sample data, with no coordinator imports or database access.
Stop both processes with Ctrl-C when finished. Ports 5195 and 5196 must be free.
Vite currently logs the pre-existing `workspace-icons.json?ssr` parse error and falls
back to client rendering; capture after the client loads.

Every row below uses **1440 and 700 CSS pixels**. Heights match the reference PNGs.
The last two rows are additional coverage beyond the named boards.

| Board                      | Exact URL                                                                                  | Height |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------ |
| Projects                   | http://127.0.0.1:5196/dashboard/projects                                                   | 900    |
| Project                    | http://127.0.0.1:5196/dashboard/projects/deploy.local                                      | 900    |
| OneAppProject              | http://127.0.0.1:5196/dashboard/projects/pantry                                            | 900    |
| Code                       | http://127.0.0.1:5196/dashboard/projects/deploy.local/code                                 | 900    |
| Issues                     | http://127.0.0.1:5196/dashboard/projects/deploy.local/issues                               | 900    |
| App                        | http://127.0.0.1:5196/dashboard/projects/deploy.local/apps/deploy.local                    | 900    |
| AppSettings                | http://127.0.0.1:5196/dashboard/projects/home-gym/apps/home-gym/settings                   | 1000   |
| ImmichApp                  | http://127.0.0.1:5196/dashboard/projects/immich/apps/Immich                                | 900    |
| Logs                       | http://127.0.0.1:5196/dashboard/projects/deploy.local/logs                                 | 900    |
| ProjectSettings            | http://127.0.0.1:5196/dashboard/projects/home-gym/settings                                 | 1160   |
| SecretEdit                 | http://127.0.0.1:5196/dashboard/projects/home-gym/settings?editSecret=STRAVA_CLIENT_SECRET | 900    |
| Apps (no board)            | http://127.0.0.1:5196/dashboard/projects/home-gym?tab=apps                                 | 900    |
| Settings (navigation only) | http://127.0.0.1:5196/dashboard/settings                                                   | 900    |

For each row:

```sh
node design/v2/tools/capture.mjs '<URL>' docs/evidence/v2/5-projects/captures/<Board> 1440,700 <Height>
```

Pair each named board at both widths, then inspect every pair:

```sh
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/5-projects/<Board>-<Width>.png design/v2/canvas/png/<Board>-<Width>.png docs/evidence/v2/5-projects/captures/<Board>-<Width>.png
```

`ProjectPhone-390.png` was inspected as a read-only reference. This slice does not
implement or capture a native iPhone screen.
