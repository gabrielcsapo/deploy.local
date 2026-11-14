# Captures to finish on a host that can launch Electron/Chromium

No native or renderer PNG was produced in this sandbox. Electron `_electron.launch` failed before
creating a window (`electron-capture.log`); Chromium failed at `bootstrap_check_in … Permission
denied (1100)` (`renderer-capture.log`). No desktop browser or computer-use fallback was attempted.

## Real Electron windows

With ports 5184 and 5185 free, from the repository root:

```sh
pnpm --dir desktop run capture:electron
```

The script starts and stops its own coordinator at **http://127.0.0.1:5184**, logs in through
`/api/login`, reads `/api/inbox`, `/api/live`, `/api/activity-events` and `/api/computers`, and uses
a fresh temporary app profile. It cannot enroll or start a worker. It disables mDNS/hostname
resolution and pins the fixture origin. Port 5185 is shared by Node's IPv6-loopback inspector and
Chromium's IPv4-loopback debugger. No other listener port is requested. The fixture harness is
not included in packaged applications.

| Board        | Native window                                                    | Output under `native/`                          |
| ------------ | ---------------------------------------------------------------- | ----------------------------------------------- |
| Setup        | 720 × 800 outer window, normal onboarding after password sign-in | `Setup.png`                                     |
| SetupLinux   | 720 × 800, `DEPLOY_DESKTOP_FIXTURE_PLATFORM=linux`               | `SetupLinux.png`                                |
| Permissions  | 720 × 800, same shell window                                     | `Permissions.png`                               |
| Tray         | 340 × 650 frameless popover                                      | `Tray.png`                                      |
| Offline      | 720 × 800, fixture coordinator returns 503                       | `Offline.png`                                   |
| Notification | 368 × 200 frameless content window                               | `Notification-content.png`, `Notification.json` |

Playwright captures Electron renderer contents; native title-bar pixels are not in page captures.
The Linux platform flag simulates setup choices and hardware text, not Linux window decorations.
The notification content window is built from the exact options passed to Electron's native
Notification constructor; **it is not an OS notification-center screenshot or proof of delivery**.
Review native notification delivery/actions on each release OS separately. The harness also checks
Take new tasks changes admission without removing the fixture's running task, and records API
requests in `native/requests.json` to show no enrollment request occurred.

## Board-size renderer comparisons

Run this fixture in a separate terminal, after the Electron harness has stopped:

```sh
node docs/evidence/v2/13-desktop-2/fixture-server.mjs
```

| Board        | Exact URL                          | Widths    | Height |
| ------------ | ---------------------------------- | --------- | ------ |
| Setup        | http://127.0.0.1:5185/Setup        | 1440, 700 | 900    |
| SetupLinux   | http://127.0.0.1:5185/SetupLinux   | 1440, 700 | 900    |
| Permissions  | http://127.0.0.1:5185/Permissions  | 1440, 700 | 900    |
| Tray         | http://127.0.0.1:5185/Tray         | 1440, 700 | 900    |
| Offline      | http://127.0.0.1:5185/Offline      | 1440, 700 | 900    |
| Notification | http://127.0.0.1:5185/Notification | 1440, 700 | 900    |

For each board above, substitute its name for `Tray` below:

```sh
node design/v2/tools/capture.mjs http://127.0.0.1:5185/Tray docs/evidence/v2/13-desktop-2/captures/Tray 1440,700 900
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/13-desktop-2/Tray-1440.png design/v2/canvas/png/Tray-1440.png docs/evidence/v2/13-desktop-2/captures/Tray-1440.png
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/13-desktop-2/Tray-700.png design/v2/canvas/png/Tray-700.png docs/evidence/v2/13-desktop-2/captures/Tray-700.png
```

These previews use the actual shell renderer and copied build tokens, with fixture data and
embedded local fonts. They are labeled renderer fixtures. The backdrop centers the window to
isolate its content; it does not recreate the board's unrelated Live page or Terminal. Inspect
all paired images before accepting parity. Stop the fixture with Ctrl-C when finished.
