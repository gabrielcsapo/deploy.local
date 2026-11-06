# Desktop capture

See [Computers and roles](computers.md) for the shared role switches and readiness states.

Linux task workers advertise `<hostname> desktop`. It is **view-only** by default. The
owner of that computer can opt in to input there (see [Allowing input](#allowing-input)),
and only then do click, text, key and scroll work. An owner must allow access in the
conversation for each session, including projects that always allow the task browser:
desktop targets never auto-approve. Approved `inspect` actions post computer-use image
attachments through the existing snapshot path. Navigation and recording requests are
always refused. macOS retains window targets and input control.

For tray-based enrollment and permission setup on Linux, see [deploy.local Node](node-app.md).

## Linux setup

Use the same unprivileged account for the graphical login and task worker. From a terminal
**inside that account’s GNOME or KDE session**, install dependencies as needed:

Ubuntu 26.04 / GNOME:

```sh
sudo apt install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good xdg-desktop-portal xdg-desktop-portal-gnome xdg-desktop-portal-gtk
```

Fedora Workstation / GNOME:

```sh
sudo dnf install python3-gobject gstreamer1 pipewire-gstreamer gstreamer1-plugins-base gstreamer1-plugins-good xdg-desktop-portal xdg-desktop-portal-gnome xdg-desktop-portal-gtk
```

Fedora KDE Plasma 6 (uses KDE’s own portal backend):

```sh
sudo dnf install python3-gobject gstreamer1 pipewire-gstreamer gstreamer1-plugins-base gstreamer1-plugins-good xdg-desktop-portal xdg-desktop-portal-kde
```

These are distro libraries, with no pip or npm dependencies. PyGObject is already used by
[Ubuntu’s desktop update manager](https://packages.ubuntu.com/resolute/update-manager) and
[Fedora’s installer](https://packages.fedoraproject.org/pkgs/anaconda/anaconda-core/fedora-45.html).
Do not assume every installed spin retains it or the GStreamer plugins. The helper probes
GI, Gst and every required element, and reports an unavailable target with an install
command when something is missing. The PipeWire plugin packages are
[Ubuntu `gstreamer1.0-pipewire`](https://packages.ubuntu.com/resolute/gstreamer1.0-pipewire)
and [Fedora `pipewire-gstreamer`](https://packages.fedoraproject.org/pkgs/pipewire/pipewire-gstreamer/).

Then use the CLI from this checkout (`node bin/deploy.js` also works), or a newly built CLI.
`deploy desktop-helper setup` installs, opens the on-screen approval right away, and offers to keep
the screen unlocked; see [computer permissions](node-permissions.md). The individual steps:

```sh
deploy desktop-helper install
deploy desktop-helper install --allow-input   # optional; see Allowing input
deploy desktop-helper status
deploy desktop-helper status --json
systemctl --user status deploy-desktop-helper.service
journalctl --user -u deploy-desktop-helper.service
```

Install copies the helper to `~/.local/lib/deploy/desktop-helper.py`, writes a user unit and
`local.deploy.DesktopHelper.desktop`, and enables it for `graphical-session.target`. It only
starts immediately when that target is already active. It imports display variables from
the installing graphical terminal into the user manager; subsequent graphical logins must
also import their environment (GNOME and KDE normally do). If status reports an unknown
session, rerun install from the desktop terminal, or log out and back in. Never start a
graphical session from a coordinator service or SSH shell just to enable capture.

The service stops with the graphical session, even with user lingering enabled. It serves
one newline-terminated JSON request per Unix connection: `{"type":"status"}`,
`{"type":"inspect"}`, or, with input allowed, `click` (`x`, `y`), `text` (`text`), `press`
(`key`) or `scroll` (`x`, `y`), each with the `expectedBounds` of the last snapshot.
Unknown fields are refused. The socket is `$XDG_RUNTIME_DIR/deploy-desktop.sock`, mode 0600, with Linux
`SO_PEERCRED` enforcing the same uid. The worker needs no display or session bus environment:
it finds this socket through its own runtime directory, or `/run/user/<its uid>`.
No root, another user’s bus, compositor-private screenshot API, or Wayland bypass is used.

Status is read-only and never prompts. It reports session type, desktop, portal availability,
stored-grant state, `inputAllowed` and socket path. The Computers view shows the status
reason. The approval card says whether the desktop is view-only or the agent can click and
type there, and whether on-screen approval is still needed.

## One-time on-screen approval

Allow the desktop request in the conversation, then have the agent inspect. On the computer
being captured, select **one monitor** in the desktop’s screen-sharing dialog and allow the
backend to remember that selection. The first request waits up to 110 seconds for this
local approval. A denied or expired request fails explicitly; request a new session to retry.

We use [ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
version 4+ with `persist_mode=2`, not Screenshot: its `interactive=false` option does not
promise remembered permission across GNOME and KDE. A stable
[host app registration](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html)
associates the portal grant with Deploy’s desktop identity. The helper opens only the
portal-provided PipeWire fd, reads one JPEG using GStreamer, then closes the pipeline,
fd and portal session. It never opens the general PipeWire remote for Wayland capture.

The returned restore token is saved privately (0600) under
`$XDG_STATE_HOME/deploy/desktop-restore.json`, defaulting to `~/.local/state/deploy/`.
Each use consumes the previous token and saves its replacement. A stored token means a
remembered grant was issued, not that it cannot be revoked: the desktop owns revocation,
monitor changes and whether another approval is needed. No token is sent to the coordinator.

X11 sessions use GStreamer `ximagesrc` directly, with the same Deploy owner approval, and
need no portal grant. GNOME/KDE ScreenSaver state is checked before and after a frame:
a reported locked/idle screen yields a text snapshot instead of an image. If the compositor
does not expose that state, a missing frame yields an explicit capture error.

## Allowing input

Input is an opt-in per computer, made by its owner from a terminal in that graphical session:

```sh
deploy desktop-helper install --allow-input
```

This adds `--allow-input` to the user unit's `ExecStart`, so neither the worker nor the
coordinator can turn it on. Running `deploy desktop-helper install` without the flag makes the
desktop view-only again. Status then reports `inputAllowed: true` and `viewOnly: false`, and
the CLI prints `Input: allowed`. The worker advertises the target without `viewOnly`, so the
web and native viewers offer **Take control** and **Return to agent** as they do for macOS.
The approval card is titled **Allow desktop control?** and says the agent can click and type
on that computer, anywhere on its screen. Desktop targets still never auto-approve.

With input allowed, every request (inspect included) uses one
[RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
session that contains the screen cast: `CreateSession`, `SelectDevices` (keyboard and
pointer, `persist_mode=2`, restore token), `SelectSources` (one monitor), then `Start`. The
first request shows the desktop's remote-desktop dialog instead of the screen-sharing one;
allow keyboard and pointer, pick one monitor, and let it remember the choice. RemoteDesktop
version 2 or newer is required for that remembered grant. The token is stored with its kind,
so a view-only token is never offered to a remote desktop session or the reverse; switching
modes asks once more.

Each action is one short session: the helper restores the grant, sends the input, waits
300 ms, captures a frame, and closes the session. Nothing stays connected between actions.

| Action   | Portal call                                                                  |
| -------- | ---------------------------------------------------------------------------- |
| `click`  | `NotifyPointerMotionAbsolute` on the stream, then left `NotifyPointerButton` |
| `text`   | `NotifyKeyboardKeysym` press and release for each character                  |
| `press`  | `NotifyKeyboardKeysym` for Enter, Tab, Escape, Backspace, arrows or Space    |
| `scroll` | `NotifyPointerAxis` with `x`/`y` in logical pixels, then `finish`            |

Click coordinates are pixels in the latest screenshot, at most 1280 wide; the helper scales
them to the monitor's logical size. Each snapshot reports its frame as `inputBounds`
(`{x: 0, y: 0, width, height}`), which the viewers also use to map a click on the image.
Input is refused, with nothing sent, before any inspect or when the frame has changed since.
Latin-1 characters type as their own keysyms and others as Unicode keysyms; characters the
compositor cannot map to the current keyboard layout may not appear. Input is never sent
while the desktop reports a locked or idle screen, so the agent cannot type into a lock
screen. If the portal lacks RemoteDesktop, a keyboard or a pointer, or the session is X11,
status explains why and the desktop stays view-only.

The desktop's own remote-desktop indicator shows while each action runs. Revoke the
remembered grant in the desktop's privacy settings, or reinstall without `--allow-input`.

## Screen lock on unattended computers

A locked or blanked screen can't be captured: the agent gets a "locked or idle" note instead
of an image. Status says whether the desktop locks itself, and after how long. The approval
card and Computers view show the same thing, so the owner knows before allowing access:

```
Screen lock: on, after 5 minutes idle. Keep it unlocked: deploy desktop-helper screen-lock off
```

For a headless or unattended computer, the owner can turn the automatic lock off. Deploy never
does this on its own. On GNOME, the command reports each change and warns before returning:

```sh
deploy desktop-helper screen-lock off
```

```
Turned off automatic screen lock on ser so desktop captures work unattended:
  Lock screen when idle: on → off
  Blank screen after: 5 minutes → never
  Dim screen when idle: on → off
Anyone with physical access to ser can now use its desktop without a password.
Undo: deploy desktop-helper screen-lock restore
```

The previous values are saved (0600) to `$XDG_STATE_HOME/deploy/screen-lock-backup.json`, and
status keeps saying deploy turned the lock off until `screen-lock restore` puts them back.
Suspend on AC power is left as it is. On KDE Plasma, the command explains which setting to
turn off in System Settings instead of changing it.

To remove the service and its local restore token:

```sh
deploy desktop-helper uninstall
```

Uninstall does not edit the desktop’s permission database. The desktop’s privacy controls
can revoke remembered screen-sharing permissions independently.

## macOS

Install the Electron desktop app with its embedded, consistently signed Swift helper.
The bundled worker receives the helper path from the desktop app. For a separately started
remote worker, set the helper path explicitly before starting it:

```sh
export DEPLOY_DESKTOP_HELPER="/Applications/deploy.local Desktop.app/Contents/Resources/helpers/deploy-control-helper"
```

The remote worker still recognizes helpers inside an older `Deploy.app` installation for
compatibility. Those fallback paths do not build or depend on the retired Swift Mac target.

macOS Screen Recording and Accessibility permissions, per-window approval, and existing
input behavior are unchanged. The Linux user service is not installed on macOS.

## Verification on actual desktops

Automated tests mock D-Bus/portal responses and frame capture. Before rollout, verify on
Ubuntu GNOME 50, Fedora GNOME and Fedora KDE Plasma 6: initial on-screen consent, repeat
capture without a prompt, with `--allow-input` the remote-desktop consent and a click, text,
key and scroll landing where the screenshot shows, token rotation after helper restart and logout/login, revocation,
lock/idle snapshots, missing-plugin diagnostics, service stopping on logout, and screenshots
appearing in the conversation from a worker without graphical environment variables.
Check X11 direct capture in an X11 session and macOS window capture/input with the installed
signed helper. None of these real desktop interactions run in the test suite.
