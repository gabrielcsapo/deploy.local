# Capture slice 8

Headless Chromium failed at launch with `bootstrap_check_in … Permission denied (1100)`.
No implementation screenshots or paired images were produced. Visual parity, keyboard focus and
responsive scrolling remain unverified. The reference PNGs at both widths were inspected.

Start these two isolated processes from this worktree, then stop both after capture:

```sh
node docs/evidence/v2/8-computers/fixture-server.mjs
DEPLOY_DATA_DIR=$(mktemp -d /private/tmp/v2-computers-ui.XXXXXX) DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5190 pnpm exec vite --host 127.0.0.1 --port 5191 --strictPort
```

The fixture intercepts all APIs. It never mounts the real coordinator, enrolls a computer,
changes a role, installs an update or contacts Docker. Its setup script opens RemoveComputer
and enters the AddComputer name and creates a fixture join code. Vite supplies only UI assets.

| Board          | URL                                                                      | Widths    | Height |
| -------------- | ------------------------------------------------------------------------ | --------- | ------ |
| Compute        | `http://127.0.0.1:5190/dashboard/computers?board=Compute`                | 1440, 700 | 900    |
| Computer       | `http://127.0.0.1:5190/dashboard/computers/coordinator?board=Computer`   | 1440, 700 | 900    |
| Models         | `http://127.0.0.1:5190/dashboard/computers/models?board=Models`          | 1440, 700 | 1300   |
| AddComputer    | `http://127.0.0.1:5190/dashboard/computers/add?board=AddComputer`        | 1440, 700 | 900    |
| SelfUpdate     | `http://127.0.0.1:5190/dashboard/computers?updates=1&board=SelfUpdate`   | 1440, 700 | 900    |
| RemoveComputer | `http://127.0.0.1:5190/dashboard/computers/bazzite?board=RemoveComputer` | 1440, 700 | 900    |
| Restarting     | `http://127.0.0.1:5190/restarting`                                       | 1440, 700 | 900    |

```sh
mkdir -p docs/evidence/v2/8-computers/captures
node design/v2/tools/capture.mjs 'http://127.0.0.1:5190/dashboard/computers?board=Compute' docs/evidence/v2/8-computers/captures/Compute 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5190/dashboard/computers/coordinator?board=Computer' docs/evidence/v2/8-computers/captures/Computer 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5190/dashboard/computers/models?board=Models' docs/evidence/v2/8-computers/captures/Models 1440,700 1300
node design/v2/tools/capture.mjs 'http://127.0.0.1:5190/dashboard/computers/add?board=AddComputer' docs/evidence/v2/8-computers/captures/AddComputer 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5190/dashboard/computers?updates=1&board=SelfUpdate' docs/evidence/v2/8-computers/captures/SelfUpdate 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5190/dashboard/computers/bazzite?board=RemoveComputer' docs/evidence/v2/8-computers/captures/RemoveComputer 1440,700 900
node design/v2/tools/capture.mjs 'http://127.0.0.1:5190/restarting' docs/evidence/v2/8-computers/captures/Restarting 1440,700 900
```

Pair each capture with its board, then inspect every pair and fix unintended differences:

```sh
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/8-computers/Compute-700.png design/v2/canvas/png/Compute-700.png docs/evidence/v2/8-computers/captures/Compute-700.png
```

ComputePhone was read as an API reference only; no iPhone screen is implemented in this slice.
