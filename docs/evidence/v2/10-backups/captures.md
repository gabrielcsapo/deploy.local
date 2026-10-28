# Capture handoff · backups

Chromium failed to launch under the sandbox (`bootstrap_check_in … Permission denied (1100)`). No implementation screenshots or pairs are present. Run from this worktree when headless Chromium is permitted. Use free ports 5182 and 5183; do not use the live coordinator.

In separate terminals:

```sh
node docs/evidence/v2/10-backups/fixture-server.mjs
```

```sh
DEPLOY_DATA_DIR=$(mktemp -d /tmp/v2-backups-ui.XXXXXX) DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5182 pnpm exec vite --host 127.0.0.1 --port 5183 --strictPort
```

| Board        | Exact URL                                                              | Widths    | Height |
| ------------ | ---------------------------------------------------------------------- | --------- | ------ |
| Backups      | `http://127.0.0.1:5183/dashboard/settings/backups`                     | 1440, 700 | 1240   |
| RestoreData  | `http://127.0.0.1:5183/dashboard/settings/backups?restore=pre-release` | 1440, 700 | 900    |
| RestorePhone | Reference only; iPhone implementation belongs to the later slice       | 390       | 844    |

```sh
mkdir -p docs/evidence/v2/10-backups/captures
node design/v2/tools/capture.mjs http://127.0.0.1:5183/dashboard/settings/backups docs/evidence/v2/10-backups/captures/Backups 1440,700 1240
node design/v2/tools/capture.mjs 'http://127.0.0.1:5183/dashboard/settings/backups?restore=pre-release' docs/evidence/v2/10-backups/captures/RestoreData 1440,700 900
```

Pair each capture (board left, implementation right):

```sh
for board in Backups RestoreData; do
  for width in 1440 700; do
    uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py "docs/evidence/v2/10-backups/$board-$width.png" "design/v2/canvas/png/$board-$width.png" "docs/evidence/v2/10-backups/captures/$board-$width.png"
  done
done
```

Inspect all four pairs and fix unintended differences before claiming parity. `notes.md` lists deliberate differences. Also exercise radio selection, keyboard focus/Escape, scrolling, Test-restore, Restore to a copy → Open → Switch, and Cancel. The fixture's `/copy` address serves synthetic text only; its switch/cancel actions update an in-memory receipt. Restart the fixture for a fresh state. Stop both servers with Ctrl-C afterwards.
