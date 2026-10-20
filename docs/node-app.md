# deploy.local Node (Linux)

See [Computers and roles](computers.md) for the shared role switches and readiness states.

Node is a background task worker with a native tray menu and one on-demand setup window.
There is no task, chat or review window: **Open deploy.local** opens the coordinator in your
browser. macOS uses the native SwiftUI Deploy app; this package has no macOS build target.

## Install and run

Use the ordinary account that owns the graphical session and task worker, never root.
Keep the existing `deploy-server.service` system unit: the coordinator starts at boot without
a desktop login. Node starts at graphical login and does not replace that system unit.

From this checkout, using the already installed dependencies:

```sh
pnpm --filter @deploy-local/node-app build
pnpm --filter @deploy-local/node-app start --setup
# Existing Linux tray installer now opens Node setup:
node scripts/menubar.mjs install
```

For Linux release artifacts (AppImage and Debian package, x64 and arm64):

```sh
pnpm --filter @deploy-local/node-app dist
```

Artifacts go in `packages/node-app/release/`. Run the AppImage as your desktop user, or install
the `.deb` and run `deploy-node --setup`. Put an AppImage in its permanent location before
enrolling; its login launcher records that location. No macOS app, helper or installer is
built or bundled. Electron 44.5.1 and electron-builder 26.15.3 remain pinned.

**On Ubuntu 24.04 and later, install the `.deb`.** Ubuntu restricts unprivileged user
namespaces (`kernel.apparmor_restrict_unprivileged_userns = 1`), so Chromium's sandbox needs
either a root-owned setuid `chrome-sandbox` or an AppArmor profile. The `.deb` installs both
(`sudo apt install ./deploy-node-0.1.0-amd64.deb`); an AppImage or a checkout started with
`pnpm … start` fails there with "The SUID sandbox helper binary was found, but is not
configured correctly". Do not work around it with `--no-sandbox`: the setup window loads
coordinator pages.

Create a one-use enrollment in Dashboard → Nodes or `deploy nodes enroll --name <name>`.
Paste the coordinator URL and code in Node setup. Links containing `?code=…` or `#code=…`
are also accepted. Enrollment uses the same request and private credential-storage module
as `deploy agent join`. For Node, the coordinator additionally issues a task-worker credential
owned by the account that created the enrollment. Node runs that ordinary-user task worker
in the background and restarts it on failure. Existing execution-agent services are retained;
Node does not install a root execution-agent service or claim Docker deployment jobs.

The task worker trusts the operating system's certificate store (`NODE_USE_SYSTEM_CA=1`), so a
coordinator on deploy.local's private CA works once that CA is installed system-wide (Fedora:
`/etc/pki/ca-trust/source/anchors/` then `update-ca-trust`). Its output goes to a private
`worker.log` (0600) in the worker directory, restarted past 5 MB; the tray never shows it.

Credentials are stored privately in `$XDG_CONFIG_HOME/deploy.local/agent.json` (normally
`~/.config/deploy.local/agent.json`). Workspaces live under Electron's user-data directory
(`deploy.local Node/worker`). Provider tools and credentials must already be available to
this user, just as for a remote task worker. The shipped Playwright runtime does not include
browsers; if Task browser reports a missing Chromium runtime, use its displayed install command.
The coordinator must include the Node enrollment extension before enrolling from this app.

After enrollment, login startup is enabled in
`$XDG_CONFIG_HOME/autostart/deploy-node.desktop`. Switch **Start at login** in setup to change it.
Closing setup leaves Node running; **Quit** in the tray exits. Starting a second instance with
`--setup` focuses the running instance. No window opens on a normal login launch. With no
StatusNotifier host, the service keeps running and logs once how to open setup. GNOME needs
the AppIndicator extension to show Electron's tray.

On first run, Node disables, stops and removes the old user `deploy-menubar.service`, reloads
the user manager and prints a one-line replacement notice. The GJS tray has been removed.
The macOS Swift status tray and its installer path are unchanged.

## Setup and permissions

The 420 × 640 resizable setup window loads the coordinator's existing
`/dashboard/embed/computers/<workerId>` permissions page. Sign in there to view account data.
It uses the same permission decisions as the tray and CLI. Permission rows offer local helper
actions only when they describe this worker. If the coordinator cannot load, a local page
provides enrollment, permission actions and login-startup settings.

- **Screen capture** installs the bundled `native/Linux/desktop-helper.py` using the existing
  `runDesktopHelper('install')` logic. It opens the desktop's screen-sharing approval dialog
  on Wayland. Choose one monitor and allow the desktop to remember it. Capture is view-only.
- **Input (click and type)** uses the same installer with `allowInput: true`, then opens the
  RemoteDesktop approval dialog. Keyboard and pointer access require explicit desktop approval
  and a supported portal. Running `deploy desktop-helper install` makes it view-only again.
- **Screen lock / Keep unlocked** offers GNOME's existing off/restore commands. **Anyone with
  physical access can use an unlocked computer without a password.** Every lock change,
  including restore, first shows a native confirmation with Cancel selected. Settings change
  only after confirmation. Captures show nothing while the desktop is locked.
- **Task browser** reports the worker's configured headless browser and Chromium availability.
  It remains subject to conversation approval and existing project settings.

Install the desktop's Python, GStreamer, PipeWire and portal dependencies described in
[Desktop capture](desktop-capture.md). Node bundles the helper script, not distro libraries.
No capture grant is made by a coordinator API. Local helper actions run only in the main
process through a narrow preload bridge; the renderer has no Node integration. Local pages
have a restrictive CSP. Navigation is limited to the configured coordinator origin; external
links open in the default browser. Credentials are never passed through the bridge or logged.

## Pause and status

**Pause agent control** creates `$XDG_STATE_HOME/deploy/control-paused` (normally
`~/.local/state/deploy/control-paused`). Both local and remote task-worker runtimes check it
immediately before opening a new computer or browser session. Existing sessions and coding
tasks continue. Resume removes the file. The tray and worker must run as the same user.
`DEPLOY_CONTROL_PAUSE_FILE` overrides the location for a separately managed worker; set the
same value for its tray. The coordinator cannot remove this local pause.

```sh
deploy agent status --json
```

This read-only status returns `enrolled`, `coordinatorUrl`, `workerId`, `workerName`, `online`,
`runningTaskCount`, and `capabilities` (`capture`, `input`, `browser`, `screenLock`,
`controlPaused`). Each capability has `state` (`ok`, `needs-action`, `unavailable`), `reason`
and `fix`. Unknown information is stated explicitly; an unknown task count is `null`.
Workers publish private, credential-free snapshots at
`$XDG_STATE_HOME/deploy/node-status.json`. Snapshots older than ten seconds are offline;
status checks never send a heartbeat that could make a stopped worker appear online.
An execution-only enrollment without a task-worker snapshot has an unknown worker count.
Worker registration/control heartbeats carry the same capability object, and Computers shows
one line per capability with its fix text. Mac workers use their existing detected helper
permissions; the native Mac app and helper are unchanged.

`DEPLOY_NODE_STATUS_PATH` overrides the snapshot path. `DEPLOY_AGENT_CONFIG` overrides the
credential path. `DEPLOY_COORDINATOR_URL` selects the coordinator for an externally managed
worker. `DEPLOY_NODE_SETUP_PATH` overrides the embedded setup path (same origin only).
`DEPLOY_SUPERVISOR_SOCKET` selects the local supervisor socket, otherwise
`$DEPLOY_DATA_DIR/supervisor.sock`, then the server system unit’s working directory plus
`.deploy-data/supervisor.sock`, then the source checkout’s `.deploy-data/supervisor.sock`.
Set an absolute socket path for a coordinator with a custom data directory. Login startup
preserves these non-secret Node configuration overrides.

## Coordinator controls

Only a machine with the supervisor socket exposes the coordinator section. It consumes the
same pushed NDJSON `status` and `fleet` records as the previous tray: green means both children
run, orange means a child is restarting or Docker is unreachable, red means disconnected.
Fleet consumption expires after 90 seconds. Start, Stop and Restart operate on
`deploy-server.service` with `systemctl`. Stop and Restart always require confirmation.
Only an authorization failure for a verified system unit falls back to `pkexec systemctl`;
otherwise errors show the exact command to run. **Open logs** reads the unit's journal.
No tray action disables the system unit or changes its boot configuration.

## Deployment notifications

The Linux Node tray shows native desktop notifications for deployments targeting this node.
On the coordinator (the main node with the supervisor socket), it shows deployments targeting
any node. Startup recovery, status synchronization, and restarts/recreates never notify.

Notifications announce building, running and failed deployments. Completion replaces the
building notification, and duplicate statuses within ten seconds are ignored. Click a failed
notification to open that application's Releases page on the coordinator.

**Deployment notifications** in the tray menu is on by default. Turning it off dismisses
visible deployment notifications and prevents new ones. The preference is saved in
`settings.json` under Electron's user-data directory (`deploy.local Node`).

The coordinator uses its local supervisor socket. Other enrolled nodes use a node-authenticated
live event stream, reconnecting after connection loss without replaying historical events.
Messages contain only the application name, status, target node, account name and timestamp;
no logs, environment values or credentials are included.

## Uninstall

Switch off **Start at login**, quit from the tray, then remove the AppImage or uninstall the
Debian package. `node scripts/menubar.mjs uninstall` also removes the login launcher. Helpers
and enrollment are intentionally retained by that launcher-only uninstall. To remove them,
restore the screen lock in setup, run `deploy desktop-helper uninstall`, revoke the worker in
Computers and revoke its node enrollment in Nodes, then remove the private Node credential and
user-data directory. The server system unit is separate and remains installed.

## Verification limits

The bundle and pure unit tests can be built on a Mac without launching Electron or building
any macOS Electron artifact. Linux GNOME tray hosting, Wayland portal dialogs, screen-lock
confirmation, systemctl/pkexec authorization, login startup and release installation require
validation in an actual Linux desktop session.
