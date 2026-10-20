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

Node setup shows the same choices when redeeming an enrollment. Selecting a role expresses
intent; it does not grant screen recording, input, or provider access. Complete those steps
locally on that computer. See [Node app](node-app.md), [Desktop capture](desktop-capture.md),
and [Computer permissions](node-permissions.md).

A deployment targeting a computer with Deploy apps off fails with a reason. Off computers
are hidden from the default deployment picker and the task computer picker. Disabled screen
and browser roles disappear from agent control targets, and new control requests are rejected.
Deployment notifications are delivered to enrolled computers with Deploy apps on, plus the
coordinator. These switches do not replace per-conversation desktop approval.
