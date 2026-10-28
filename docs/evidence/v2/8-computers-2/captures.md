# Capture instructions

No dashboard or iPhone UI files were changed by the first pass. The continuation below changes SelfUpdate. The existing
SelfUpdate, RestoreData and RestorePhone renders were reviewed. Their fixtures and
paired captures remain in `../8-computers/` and `../10-backups/`; this slice does
not claim to implement their missing self-update controls.

The existing standalone Restarting screen is served by this isolated fixture:

```sh
node docs/evidence/v2/8-computers-2/fixture-server.mjs
node design/v2/tools/capture.mjs http://127.0.0.1:5186/restarting docs/evidence/v2/8-computers-2/captures/Restarting 1440,700 900
```

| Board      | URL                              | Width | Height |
| ---------- | -------------------------------- | ----- | ------ |
| Restarting | http://127.0.0.1:5186/restarting | 1440  | 900    |
| Restarting | http://127.0.0.1:5186/restarting | 700   | 900    |

This is regression evidence for the existing edge screen, not evidence of a
successful coordinator self-release. See `capture.log` for the capture result.

## Continuation: SelfUpdate

The continuation adds the real persisted switch and update failure explanations.
Chromium was denied `bootstrap_check_in` while launching; see
`self-update-capture.log`. No new implementation PNG or paired screenshot is
claimed. The 1440 and 700 reference PNGs were inspected. The orchestrating session
must capture, pair and review these screens before visual sign-off.

Run the two isolated fixtures in separate terminals, then stop both:

```sh
node docs/evidence/v2/8-computers-2/self-update-fixture.mjs
DEPLOY_DATA_DIR=$(mktemp -d /private/tmp/v2-update-ui.XXXXXX) DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5186 pnpm exec vite --host 127.0.0.1 --port 5187 --strictPort
```

| Board / state                  | Exact URL                                                                    | Widths    | Height |
| ------------------------------ | ---------------------------------------------------------------------------- | --------- | ------ |
| SelfUpdate                     | `http://127.0.0.1:5186/dashboard/computers?updates=1&board=SelfUpdate`       | 1440, 700 | 900    |
| SelfUpdate, failed replacement | `http://127.0.0.1:5186/dashboard/computers?updates=1&board=SelfUpdateFailed` | 1440, 700 | 900    |

```sh
node design/v2/tools/capture.mjs 'http://127.0.0.1:5186/dashboard/computers?updates=1&board=SelfUpdate' docs/evidence/v2/8-computers-2/captures/SelfUpdate 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5186/dashboard/computers?updates=1&board=SelfUpdateFailed' docs/evidence/v2/8-computers-2/captures/SelfUpdateFailed 1440,700 900
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/8-computers-2/SelfUpdate-1440.png design/v2/canvas/png/SelfUpdate-1440.png docs/evidence/v2/8-computers-2/captures/SelfUpdate-1440.png
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/8-computers-2/SelfUpdate-700.png design/v2/canvas/png/SelfUpdate-700.png docs/evidence/v2/8-computers-2/captures/SelfUpdate-700.png
```

The fixture serves every API locally, including an in-memory PUT for the switch.
It never enrolls or updates a real computer. The failed state deliberately adds a
recovery explanation absent from the happy-path board.
