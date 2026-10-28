# ShipDialog captures still required

Chromium could not launch in this sandbox: `bootstrap_check_in ... Permission denied (1100)` and SIGABRT. See `capture.log`. No implementation screenshots or side-by-side pairs were produced, so visual parity, keyboard interaction, and compact-width scrolling remain unverified. The design's 1440 and 700 renders were inspected; `design/v2` is unchanged.

Start the isolated fixture from the repository root:

```sh
node docs/evidence/v2/4-releases-2/fixture-server.mjs
```

It serves the actual React Task route and ShipDialog, with fixture API responses, on **127.0.0.1:5188 only**. It removes the development API proxy and never connects to the live coordinator. Ensure that assigned port is free. Stop the fixture with Ctrl-C afterwards.

| Board      | Exact URL                                             | Width | Height |
| ---------- | ----------------------------------------------------- | ----- | ------ |
| ShipDialog | http://127.0.0.1:5188/dashboard/tasks/ShipDialog#ship | 1440  | 900    |
| ShipDialog | http://127.0.0.1:5188/dashboard/tasks/ShipDialog#ship | 700   | 900    |

```sh
node design/v2/tools/capture.mjs 'http://127.0.0.1:5188/dashboard/tasks/ShipDialog#ship' docs/evidence/v2/4-releases-2/captures/ShipDialog 1440,700 900
python3 design/v2/tools/pair.py docs/evidence/v2/4-releases-2/ShipDialog-1440-pair.png design/v2/canvas/png/ShipDialog-1440.png docs/evidence/v2/4-releases-2/captures/ShipDialog-1440.png
python3 design/v2/tools/pair.py docs/evidence/v2/4-releases-2/ShipDialog-700-pair.png design/v2/canvas/png/ShipDialog-700.png docs/evidence/v2/4-releases-2/captures/ShipDialog-700.png
```

Review both pairs, then exercise computer selection, address editing, visibility, data selection, Cancel, and Ship with the keyboard. Expected fixture choices are SER / bazzite, an editable `meal-planner.deploy.local`, Just me / Everyone at home, and Keep existing data / New data.
