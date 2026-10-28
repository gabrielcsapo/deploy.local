# Final polish capture handoff

Chromium failed to launch with `bootstrap_check_in … Permission denied (1100)`.
See `capture-attempt.log`. No implementation captures or pairs are claimed.

Run the isolated fixture (real application components, synthetic API data):

```sh
node docs/evidence/v2/final/fixture-server.mjs
```

It binds **5180** only, using Vite middleware. It never imports a coordinator,
opens a database, enrolls a worker or contacts the real install. Stop with Ctrl-C.

| Board           | Exact URL                                                            | Widths   | Height |
| --------------- | -------------------------------------------------------------------- | -------- | ------ |
| SettingsAgents  | http://127.0.0.1:5180/dashboard/settings/approvals                   | 1440,700 | 1260   |
| ProjectSettings | http://127.0.0.1:5180/dashboard/projects/home-gym/settings           | 1440,700 | 1160   |
| RestoreData     | http://127.0.0.1:5180/dashboard/settings/backups?restore=pre-release | 1440,700 | 900    |
| NewProject      | http://127.0.0.1:5180/dashboard/start/project                        | 1440,700 | 900    |
| Offline         | http://127.0.0.1:5180/offline                                        | 1440,700 | 900    |

```sh
node design/v2/tools/capture.mjs 'http://127.0.0.1:5180/dashboard/settings/approvals' docs/evidence/v2/final/captures/SettingsAgents 1440,700 1260
node design/v2/tools/capture.mjs 'http://127.0.0.1:5180/dashboard/projects/home-gym/settings' docs/evidence/v2/final/captures/ProjectSettings 1440,700 1160
node design/v2/tools/capture.mjs 'http://127.0.0.1:5180/dashboard/settings/backups?restore=pre-release' docs/evidence/v2/final/captures/RestoreData 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5180/dashboard/start/project' docs/evidence/v2/final/captures/NewProject 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5180/offline' docs/evidence/v2/final/captures/Offline 1440,700 900
```

Pair each capture with its matching board, board first:

```sh
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/final/SettingsAgents-1440.png design/v2/canvas/png/SettingsAgents-1440.png docs/evidence/v2/final/captures/SettingsAgents-1440.png
```

Repeat for both widths and the other boards. Offline is the actual desktop
renderer and stylesheet served in Chromium; native title bar and OS desktop are
not imitated. Compare its content, then use the existing Electron capture workflow
for native window acceptance. The original Offline board is 1440 × 900; 700 is an
additional narrow-content check.

Also inspect `/dashboard/projects/home-gym/settings?key=STRAVA_CLIENT_ID` and
`?key=MISSING_VALUE`: the first edits an existing variable and the second opens an
Add variable editor with that key. Secret values must never appear.

Check dialog centering against the **viewport**, scrim coverage, Escape/focus
restoration, and overflow at both widths. All v2 dialogs use the shared Dialog
except Markup's deliberately top-anchored full editing surface, which retains its
native modal and explicit horizontal auto margins.

For native iPhone captures, use the existing dedicated-simulator workflow in
`../12-ios-2/captures.md`. SettingsPhone, AgentMenuPhone and paired-device removal
need a fixture implementing the newly documented preference endpoints. Swift
package and iOS Simulator package builds succeeded; no app was installed here.
