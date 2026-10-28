# Slice 6 captures

The required capture helper was attempted. Chromium aborts at launch with
`bootstrap_check_in … Permission denied (1100)`; see `capture.log`.
No implementation captures or pairs exist. Visual parity is not verified.

Run the isolated fixture API and web app in separate terminals:

```sh
node docs/evidence/v2/6-markup/fixture-server.mjs
DEPLOY_DATA_DIR=/private/tmp/v2-markup-preview-data DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5193 pnpm exec vite --host 127.0.0.1 --port 5192 --strictPort
```

The fixture reuses slice 3's meal-planner assets and task data, supplies Models,
and adds the board's red ellipse, underline, arrow and two text annotations. It
never imports the coordinator, worker, database or Docker. Stop both processes
with Ctrl-C after capturing.

| Board                | Exact URL                                                       | Widths    | Height |
| -------------------- | --------------------------------------------------------------- | --------- | ------ |
| Home (composer)      | `http://127.0.0.1:5192/dashboard`                               | 1440, 700 | 900    |
| NewProduct (gallery) | `http://127.0.0.1:5192/dashboard/tasks/NewProduct`              | 1440, 700 | 900    |
| MarkupDesktop        | `http://127.0.0.1:5192/dashboard/tasks/NewProduct#markup=shot0` | 1440, 700 | 900    |

```sh
node design/v2/tools/capture.mjs http://127.0.0.1:5192/dashboard docs/evidence/v2/6-markup/captures/Home 1440,700 900
node design/v2/tools/capture.mjs http://127.0.0.1:5192/dashboard/tasks/NewProduct docs/evidence/v2/6-markup/captures/NewProduct 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5192/dashboard/tasks/NewProduct#markup=shot0' docs/evidence/v2/6-markup/captures/MarkupDesktop 1440,700 900
```

Pair each capture with `design/v2/canvas/png/<Board>-<width>.png`:

```sh
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/6-markup/MarkupDesktop-700.png design/v2/canvas/png/MarkupDesktop-700.png docs/evidence/v2/6-markup/captures/MarkupDesktop-700.png
```

Inspect all six pairs. Also verify keyboard focus containment and restoration,
Escape, attachment picking/removal, model selection, Pen/Arrow/Text/Undo, failed
upload and failed send draft retention. Real markup sending needs PNG/JPEG input;
the fixture's SVG sample app is for visual comparison only.
