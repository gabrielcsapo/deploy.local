# Desktop capture

Linux task workers advertise `<hostname> desktop`, a **view-only** target. An owner must
allow access in the conversation for each session, including projects that always allow
the task browser. Approved `inspect` actions post computer-use image attachments through
the existing snapshot path. Linux click, text, key, scroll, navigation and recording
requests are refused. macOS retains window targets and input control.

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

Then use the CLI from this checkout (`node bin/deploy.js` also works), or a newly built CLI:

```sh
deploy desktop-helper install
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
one newline-terminated JSON `{"type":"status"}` or `{"type":"inspect"}` request per Unix
connection. The socket is `$XDG_RUNTIME_DIR/deploy-desktop.sock`, mode 0600, with Linux
`SO_PEERCRED` enforcing the same uid. The worker needs no display or session bus environment:
it finds this socket through its own runtime directory, or `/run/user/<its uid>`.
No root, another user’s bus, compositor-private screenshot API, or Wayland bypass is used.

Status is read-only and never prompts. It reports session type, desktop, portal availability,
stored-grant state and socket path. The Computers view shows the status reason; the approval
card explains that Linux is view-only and whether on-screen approval is still needed.

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

To remove the service and its local restore token:

```sh
deploy desktop-helper uninstall
```

Uninstall does not edit the desktop’s permission database. The desktop’s privacy controls
can revoke remembered screen-sharing permissions independently.

## macOS

Install the Mac app with its embedded, consistently signed Swift helper. A remote worker
now discovers `Contents/Helpers/deploy-control-helper` under `~/Applications/Deploy.app`
or `/Applications/Deploy.app` and sets `DEPLOY_DESKTOP_HELPER` when unset. For another
installation path, set it explicitly before starting the worker:

```sh
export DEPLOY_DESKTOP_HELPER=/Applications/Deploy.app/Contents/Helpers/deploy-control-helper
```

macOS Screen Recording and Accessibility permissions, per-window approval, and existing
input behavior are unchanged. The Linux user service is not installed on macOS.

## Verification on actual desktops

Automated tests mock D-Bus/portal responses and frame capture. Before rollout, verify on
Ubuntu GNOME 50, Fedora GNOME and Fedora KDE Plasma 6: initial on-screen consent, repeat
capture without a prompt, token rotation after helper restart and logout/login, revocation,
lock/idle snapshots, missing-plugin diagnostics, service stopping on logout, and screenshots
appearing in the conversation from a worker without graphical environment variables.
Check X11 direct capture in an X11 session and macOS window capture/input with the installed
signed helper. None of these real desktop interactions run in the test suite.
