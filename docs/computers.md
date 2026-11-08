# Computers and roles

A computer can do several jobs. Open Dashboard → Computers to see all enrolled execution
nodes and task workers together. A Node-app worker belongs to its enrolled node; the
coordinator’s managed worker belongs to the coordinator. A worker without a node keeps its
worker identity. The old `/dashboard/nodes` URL redirects to Computers.

Roles are independent switches. Turning one off keeps enrollment, task history, applications,
and credentials. It prevents new work of that kind from landing on that computer. Existing
runs finish on their assigned computer; a role change does not move a run elsewhere.

| Role          | What it does                                     | What it needs                                                                                                              |
| ------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Coordinator   | Runs deploy.local                                | The coordinator server. Always on; cannot be switched off.                                                                 |
| Deploy apps   | Builds and runs deployed applications            | An enrolled execution agent, online, with a reachable Docker or compatible Podman Docker API.                              |
| Coding tasks  | Runs agents in chat tasks and executes task jobs | An online task worker and at least one available provider connection.                                                      |
| Screen access | Lets chat see the desktop                        | A Linux desktop helper or signed macOS control helper with capture permission. Input permission is a separate sub-setting. |
| Task browser  | Lets agents drive a headless browser             | An online worker offering browser control, with Chromium installed.                                                        |

The server reports one state and explanation per role:

- **Ready**: the required capability is available now.
- **Needs setup**: the role is wanted, but a requirement is missing or its worker is offline.
  Expand the computer for the reason and next step. The embedded Node setup page offers local
  capture, input, and Chromium actions; remote pages show instructions or a copyable command.
- **Paused**: local agent control is paused. This applies to screen access and the task browser;
  coding tasks and deployments remain independent. Resume control from the Node tray.
- **Off**: the owner does not want this work here. Turn the switch on to see any setup needed.

Existing computers default to their existing functions. Enrollment asks what the new computer
is for: desktop presets select coding tasks, screen access, and the task browser; server presets
select deployments. Any combination is valid. Native apps show the role chips read-only.

For CLI enrollment, use `deploy nodes enroll --name <name>`. Interactive terminals ask about
each role. Use `--desktop` for the desktop preset, or choose explicitly:

```sh
deploy nodes enroll --name build-mac --roles tasks,computer
deploy nodes enroll --name app-server --roles deploy
```

To connect a CLI computer, choose its platform in **Connect a computer**, create the enrollment,
and run the displayed command on that computer. Enter the separate code at the prompt:

```sh
deploy agent join https://deploy.local
```

macOS always runs from the normal login without sudo. Linux uses sudo only when Deploy apps
is selected. When both roles are selected, invoke sudo from the intended login: deployments use
the root system service, while coding uses that login's user systemd service, never root.
Linux task workers need an active user systemd session; persistence after logout depends on the
machine's existing user-session/linger configuration.

The standalone CLI includes the task worker. Coding tasks installs `sh.deploy.worker` in the
macOS login's LaunchAgents (RunAtLoad and KeepAlive), or `deploy-local-worker.service` in
Linux user systemd. Deploy apps keeps the existing `sh.deploy.agent` / root
`deploy-local-agent.service`. Selecting neither installs no services. macOS worker output goes
to `~/Library/Logs/deploy.local/worker.log`; Linux output goes to the user journal.

Credentials stay in `~/Library/Application Support/deploy.local/agent.json` on macOS and
`~/.config/deploy.local/agent.json` for Linux login users (honoring `XDG_CONFIG_HOME` for
non-sudo setup); existing root-only Linux agents use `/var/lib/deploy.local/agent.json`.
Worker files live under `~/Library/Application Support/deploy.local/worker` on macOS or
`~/.local/share/deploy.local/worker` on Linux. The CLI and spawned tools trust system CAs.
The service PATH includes system tools, Homebrew, local user tools, and provider CLI directories
found at installation. Repair after moving a provider installation.

Use `deploy agent status` to read current coordinator roles and inspect both services without
marking a stopped service online. `deploy agent install` repairs the services the roles request;
enabling Coding tasks on an old deployment-only enrollment requires a fresh enrollment to issue
its worker credential. `deploy agent uninstall` stops/removes both local services and removes
agent.json, preserving the coordinator record and worker files. Use sudo on Linux to repair or
remove an installed deployment system service. No credentials are printed by these commands.

Node setup shows the same choices when redeeming an enrollment. Selecting a role expresses
intent; it does not grant screen recording, input, or provider access. Complete those steps
locally on that computer. See [Node app](node-app.md), [Desktop capture](desktop-capture.md),
and [Computer permissions](node-permissions.md).

A deployment targeting a computer with Deploy apps off fails with a reason. Off computers
are hidden from the default deployment picker and the task computer picker. Disabled screen
and browser roles disappear from agent control targets, and new control requests are rejected.
Deployment notifications are delivered to enrolled computers with Deploy apps on, plus the
coordinator. These switches do not replace per-conversation desktop approval.

## Worker updates

Computers with an older or unreported worker build show **Update available**. The task composer
warns without blocking task creation. Workers report the shared workspace engine's root package
version, a commit when available at build time, and the coordination tool names bundled into their
MCP server on registration and heartbeats. These reports are informational, never authorization.
The coordinator compares package versions and tool lists; commit hashes are build
identity, not an ordering. Its own `local` and `managed-*` workers are always current.

An absent report is **unknown**, which needs an update for agent tasks. No exact missing-tool list
is inferred from an absent report. Install the latest deploy.local worker on that computer. For
Linux Node, use the [.deb or AppImage installation path](node-app.md#install-and-run), replacing an
AppImage at its existing location, then quit and reopen Node. On a CLI computer that isn't updating,
run `deploy upgrade` then `deploy agent install` from your normal login (without sudo on macOS).
Repair replaces an outdated worker with the coordinator's verified build and installs its restart
supervisor. After that, automatic updates keep it current when they're turned on. Linux may ask
you to run `sudo deploy agent install` from that same login to install the execution agent.

Newer workers consume a coordinator-owned developer-instruction snapshot, which warns about
missing tools and directs the agent to ask via `deploy_ask_user` before relying on them. Builds
from before that instruction-snapshot protocol assemble their own instructions and cannot receive
this warning. The web and native computer/composer warnings cover those builds.
