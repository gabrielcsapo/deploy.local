# Computer permissions

Each task computer has its own set of permissions: it can run coding tasks, show its screen, accept
clicks and typing, and stay unlocked. Before this change, the owner set these up with CLI commands
over SSH, and caught GNOME's screen-sharing dialog within 110 seconds of an agent's first request.

The **Permissions** panel puts them in one place. Open a computer under **Computers › Task
computers** in the web app, or in the native app's Computers list. Each row shows:

- what the computer currently allows (from the worker's last poll, refreshed every few seconds);
- the one next step to turn it on or off, and **where** that step happens.

A step either happens **on the computer** (a command or setting the owner runs there) or **here**
(an action in deploy.local itself). The panel never lets the coordinator grant something the
computer's owner hasn't approved on that computer.

## The rule

> Anything that lets an agent see, click, type, or keep the screen unlocked is approved on the
> computer itself. The coordinator can show state and take access away. It never grants access.

Three reasons:

1. **The OS already enforces it.** GNOME's portal dialog, macOS Screen Recording and Accessibility
   are approved on screen by design. A remote toggle would have to bypass them or pretend to.
2. **A stolen coordinator session shouldn't be able to take over a desktop.** If the coordinator
   could set `--allow-input` or turn off the lock, anyone holding an owner token could reach every
   enrolled desktop. With local approval, they still need someone at the keyboard.
3. **Removing access is always safe.** Revoking access is the one change worth making remotely.

Per-conversation approval is unchanged: each agent request for a desktop still needs the owner's
OK in the conversation, and **desktop targets never auto-approve**, whatever a project's browser
setting says.

## What each permission is and where it changes

| Permission             | Shown as                                 | Turn on                                                                                                | Turn off                                                                                        |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Run coding tasks       | Enrolled · online/offline                | On the computer: enroll and start the task worker (managed worker: Settings)                           | **Here: Revoke** (one-way; re-enrolling needs the computer again)                               |
| See the screen (Linux) | Off / Needs approval / On                | On the computer: `deploy desktop-helper setup`, then approve the screen-sharing dialog                 | On the computer: `deploy desktop-helper uninstall`, or revoke in the desktop's privacy settings |
| See the screen (macOS) | Screen Recording on/off                  | On the Mac: System Settings › Privacy & Security › Screen Recording › Deploy                           | Same setting                                                                                    |
| Click and type (Linux) | View-only / On                           | On the computer: `deploy desktop-helper install --allow-input`, then approve the remote-desktop dialog | On the computer: `deploy desktop-helper install` (reinstalls view-only)                         |
| Click and type (macOS) | Accessibility on/off                     | On the Mac: System Settings › Privacy & Security › Accessibility › Deploy                              | Same setting                                                                                    |
| Stay unlocked (GNOME)  | Locks after N min / Stays unlocked       | On the computer: `deploy desktop-helper screen-lock off`                                               | On the computer: `deploy desktop-helper screen-lock restore`                                    |
| Stay unlocked (macOS)  | Locked / Unlocked now                    | The Mac's own Lock Screen settings                                                                     | Same                                                                                            |
| Task browser           | Available / not; N projects auto-approve | On the computer: start the worker with `DEPLOY_BROWSER_CONTROL=1`                                      | **Here:** each project's Repository settings › Always allow task browser                        |

Notes on individual rows:

- **Click and type on Linux** needs the RemoteDesktop portal work (branch
  `claude/linux-desktop-input`). Until that lands, the helper reports no `inputAllowed`, and the row
  says the helper is view-only, with no command, because `--allow-input` doesn't exist yet. Once the
  coordinator forwards `inputAllowed` as a boolean, the row offers
  `install --allow-input`. Merging that branch will conflict in the poll sanitizer in
  `server/workspace/interactive.ts`: keep both its `inputAllowed`/`viewOnly` fields and this
  change's `screenLock`.
- **Stay unlocked** is the only row where "on" weakens the computer's own security. Its summary
  says so, and the command prints every setting it changes and how to undo it.
- **Task browser auto-approve** is the only grant made here, because the browser is a headless
  Chromium sandbox owned by the worker, not the owner's desktop. It was already a project setting.
  The panel links to it and shows which projects use it.
- **Revoke** removes the worker's credential and hides the computer from task placement. Its task
  history stays. The managed worker on the coordinator is turned off in Settings instead.

## The one local command: `deploy desktop-helper setup`

The fiddly part was the local side: several commands, then catching a dialog that only appeared
when an agent first asked. `setup` does all of it in one go from a terminal **in the computer's
graphical session**, asking before each change:

```
$ deploy desktop-helper setup
Installed the desktop helper on ser (view-only).
A screen-sharing dialog will open on this screen now. Choose one monitor and allow Deploy to remember it.
Approved. Agents you allow in a conversation can now see ser's screen without asking here again.
The screen locks after 5 minutes idle, and captures show nothing while it is locked.
Turn off the automatic lock so captures work unattended? Anyone at ser could then use it without a password. [y/N]
```

- Install is the same as `install`. Extra flags (such as `--allow-input` once that branch lands)
  are passed through.
- The dialog opens **while the owner is at the computer**, so the 110-second window is no longer a
  race. The helper does one throwaway capture to trigger it. The frame is discarded, never sent
  anywhere.
- The lock question defaults to **No**, and is skipped without a terminal (`stdin` not a TTY).
- Nothing in `setup` runs remotely. Running it over SSH fails on install, as before, because there
  is no graphical session to install into.

The panel shows `deploy desktop-helper setup` as the step for any Linux desktop permission that
isn't on yet.

## Local Node setup and Chromium

The Linux Node app embeds the computer’s permissions at 420×640. On this computer, grants and
reverse actions open the app’s native confirmation dialog. Allowed input offers **Make view-only**;
screen capture offers **Stop screen capture**; unattended capture offers **Restore lock**. An enabled
permission’s remote instructions describe how to turn it off, rather than another setup step.

The local **Task browser** row offers **Install Chromium (about 150 MB)** when Chromium is missing.
The app runs its bundled Playwright CLI through Electron as plain Node, without a shell or pnpm.
The installer and task worker explicitly share `PLAYWRIGHT_BROWSERS_PATH` under the app’s user-data
folder. Setup shows short progress stages and a retryable one-line failure; the worker’s next
inventory determines when the browser is **Ready**. Start at login and Revoke task access live in a
separate **This computer** group.

For CLI and managed workers, run `deploy browser install` from the worker installation, as the same
user and with the same `PLAYWRIGHT_BROWSERS_PATH` environment as the worker. Without an override,
both use Playwright’s normal per-user cache. The command uses the installed worker’s Playwright
version. Other computers’ web permission rows retain copyable commands; they cannot run a local
app installer on a different computer.

## Routes and API

The panel is driven entirely by these endpoints, so other shells (such as a node's own tray app)
can embed it:

|                                                |                                                            |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/workspace/computers`                 | `{computers: [{id, name, platform, status, permissions}]}` |
| `GET /api/workspace/computers/:id/permissions` | One computer, same shape; 404 if unknown or revoked        |
| `POST /api/workspace/computers/:id/revoke`     | Body `{operationId}`; remote task workers only             |
| `/dashboard/embed/computers`                   | Chrome-free page listing every computer's permissions      |
| `/dashboard/embed/computers/:id`               | Chrome-free page for one computer                          |
| `/dashboard/nodes#task-computers`              | The panel inside the dashboard                             |

Owner authentication applies as for the rest of `/api/workspace`. Worker credentials are refused.
The embed pages have no dashboard chrome, fit a 420×640 window, refresh every 4 seconds, and ask
the viewer to sign in when there is no session.

## What reaches the coordinator

The worker already forwards the desktop helper's status on each poll. This change forwards a few
more fields, all booleans or numbers, and never a token:

- Linux: `screenLock` `{locks, idleSeconds, changedByDeploy}`, and `inputAllowed` when the helper
  sends it.
- macOS: the main display target's `permissions` `{screenRecording, accessibility, unlocked}` from
  the signed Swift helper. These used to be folded into the reason text only.

The server turns these into a list of `permissions` on each computer
(`server/workspace/node-permissions.ts`). Both the web and native views render that list, so
neither client hard-codes per-platform rules.

## Not in this change

- **Enrolling a remote task worker from the UI.** Today it's `POST /api/workspace/workers/enroll`
  plus a hand-written `worker.env`. The right shape is the deployment agent's flow: a one-use code
  here, and `deploy worker join <url>` on the computer to redeem it and install a service. The panel
  shows how to connect a task worker, but the join command is a follow-up.
- **Remote pause of desktop access.** It would make "resume" a remote grant of a locally approved
  permission. Per-conversation approval already gates every session. If wanted later, pausing
  should be remote and resuming local.
