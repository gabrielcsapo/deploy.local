# Remote computer terminals

Open **Computers**, select an enrolled computer, and enable **Terminal access**. The default is off. The **Terminal** action on the online computer row or detail opens a full-height shell. The permission applies to its task worker, including the coordinator's managed worker. No execution-agent or Docker permission is required.

Turn Terminal access off to end every open terminal on that worker immediately. Revoking or re-enrolling a worker clears terminal consent and closes its sessions. On the computer itself, start/restart the worker with `DEPLOY_TERMINAL=0` to veto web access. For SER's managed worker, set this in the coordinator service environment and restart it; the setting is passed through to the ordinary worker account. Remove that environment setting and restart the worker to permit web opt-in again. This is separate from agent screen/browser control and its local pause switch: agents cannot request terminal sessions.

Update control/edge and all computers that need terminals (SER's managed worker, the bazzite worker, and the MacBook Pro worker). Workers advertise the `terminal` capability. Older workers show **Update deploy.local on <computer>**. No new npm packages, inbound worker ports, SSH server, or native Node modules are needed. Away-from-home use requires the owner's existing HTTPS route to the dashboard; this feature does not publish a new public endpoint or configure remote network access.

## Transport and authorization

- The browser connects to `/ws/terminal` and sends the same username/session-token authentication as the dashboard socket. Credentials never appear in the URL. Only a computer record owned by that authenticated account can be selected. Worker and agent credentials cannot open terminals or enable access.
- Each worker independently long-polls `GET /api/workspace/workers/<id>/terminals?instanceId=…` with its worker token. A request wakes that poll immediately, even while a coding task is running. The response assigns a random terminal ID, owner, worker ID, process instance, and dimensions.
- The worker opens `/ws/terminal/worker` outbound with its worker token in headers. Control binds the socket to the exact pending assignment and process instance, rechecks permission and freshness, and permits one worker connection per terminal. The worker checks the returned start message against its immutable assignment before starting the PTY.
- Both socket paths traverse the edge's upgrade tunnel on the same HTTPS listener as `/ws`. App-host upgrades keep their existing routing. The edge replaces the terminal audit IP header; control trusts it only on the loopback hop.
- Input/output are binary frames, preserving split UTF-8. `exec:start`, `exec:ready`, `exec:resize`, `exec:ack`, `exec:exit`, and `exec:end` are JSON control frames. Xterm acknowledges bytes after processing them; the worker pauses PTY output until acknowledgements drain. Frame limits and bounded input/output buffers terminate oversized or stalled consumers instead of dropping terminal bytes.

There are at most four sessions per worker/account, a 30-minute timeout without keyboard/paste input, and a 12-hour maximum lifetime. Resize and output do not reset the idle timer. Permission, revocation, worker freshness and process identity are checked during the session. Worker ping/pong detects a broken upstream within approximately 45 seconds. For machine terminals, closing either socket ends the shell. Task terminals detach on browser disconnect, as described below. A lost connection shows an explicit ended state; **Open a new session** reconnects with a new shell, without replaying input or silently resuming an old session.

## PTY and process lifecycle

The worker launches its user's `$SHELL -l`, falling back to `/bin/bash` or `/bin/sh`, in the user's home directory with `TERM=xterm-256color`. It never changes user or elevates privileges. `sudo` sees a real controlling TTY and prompts normally; it still requires that user's existing sudo rights and credentials.

The embedded Python 3 helper uses `pty.fork`, raw byte forwarding, `TIOCSWINSZ`, and foreground-group `SIGWINCH`. Input and resize controls travel over a bounded JSON/base64 stdin channel. Cleanup kills the shell process group and foreground/background descendants; macOS uses Python's standard-library `ctypes` with system libproc to enumerate children. Parent EOF and termination also invoke cleanup.

If Python 3 is unavailable, Linux uses util-linux `script -qefc … /dev/null`; macOS uses `script -q /dev/null …` behind a POSIX pipe (macOS script rejects Node's socket-backed stdin). Private temporary files contain only the slave TTY path and process IDs. `stty` resizes that slave directly on a best-effort basis; it never types a resize command into the current application. The fallback requires the system `script`, `stty`, shell and process utilities. Both backends propagate shell exit codes. These are ordinary user processes, not a container or job-control sandbox: deliberately daemonized/reparented processes can escape descendant cleanup, and OS restrictions can limit fallback cleanup/resizing.

## UI and audit

The terminal uses xterm, fit and web-links, with copy/paste and a horizontally scrollable extra-keys bar (Ctrl, Esc, Tab, arrows, `|`, `~`, `/`). Ctrl applies to the next key. The view follows the visual viewport so the bar stays above a mobile keyboard; landscape at 667px fits about 83 columns. Escape while typing belongs to the terminal. Close or End session is available in the header.

Workspace events `terminal.started` and `terminal.ended` record terminal/computer ID, owner, peer IP, user agent, start time, duration, exit code and end reason. `terminal.permission` records permission changes. Recent sessions appear in computer detail. Interactive terminal input/output are not stored in these events; normal shell history and commands' own logs are controlled by the shell and OS.

## Verification

PTY tests cover real `tty`, input, Unicode, `stty size` after resize, exit codes, background process cleanup, and the script fallback. Relay tests connect fake browser/control/worker sockets to a real PTY and exercise denied permissions, owner/worker/instance mismatch, worker credentials, local veto, concurrent caps, timeouts, disable, audit events and long-poll wake-up. Edge tests tunnel both terminal socket paths, preserve binary data, and reject spoofed audit addresses.

Manual verification used an isolated local control/worker fixture in Chrome at desktop, 375×667, and 667×375: enable/disabled recovery, connection, `tty`, resize, Escape, exit code 9, and the recent-session audit entry. The physical iOS software keyboard and a Linux host were not available in this worktree environment.

## Worktree test results (macOS, 2026-10-24)

- `pnpm typecheck`, `pnpm lint`, `pnpm build`: passed.
- `npx oxfmt` applied to changed files; repository-wide `format:check`: passed in both commit hooks.
- Workspace, edge and shared tests: 334 passed, 1 existing skip, 0 failures.
- Web tests: 170 passed, 1 failure in the existing media-viewer browser test. Chromium launch is denied by the macOS sandbox (`MachPortRendezvousServer`, permission denied); this failure was not skipped or treated as passing.
- Full `pnpm test`: 820 passed, 13 skipped, exactly the 4 identified baseline failures (two CA tests, Home Assistant readiness/catalog, rollback flush).
- The targeted terminal tests all passed, including the real PTY relay, fallback, credential-rotation race, output flow control, and split UTF-8.

## Changed files

- `app/design-system.css`
- `app/routes/dashboard/nodes.client.tsx`
- `app/routes/dashboard/terminal-state.test.ts`
- `app/routes/dashboard/terminal-state.ts`
- `app/routes/dashboard/terminal.client.tsx`
- `app/routes/dashboard/terminal.css`
- `docs/node-permissions.md`
- `docs/remote-terminals.md`
- `packages/node-app/src/main.ts`
- `server.ts`
- `server/edge/control-forward.test.ts`
- `server/edge/index.ts`
- `server/edge/upgrade-proxy.ts`
- `server/index.ts`
- `server/workspace/api.ts`
- `server/workspace/coordination.ts`
- `server/workspace/credentials.ts`
- `server/workspace/managed-worker.ts`
- `server/workspace/protocol.ts`
- `server/workspace/provider-connections.test.ts`
- `server/workspace/remote-worker.ts`
- `server/workspace/terminal-pty.test.ts`
- `server/workspace/terminal-pty.ts`
- `server/workspace/terminal-relay.test.ts`
- `server/workspace/terminal-relay.ts`
- `server/workspace/terminal-service.ts`
- `server/workspace/terminal-socket.ts`
- `server/workspace/terminal-worker.ts`
- `server/workspace/worker-capabilities.ts`
- `server/ws.ts`

## Task conversation terminals and shell commands

The task panel now has **Computer / Changes / Activity / Terminal** tabs, with the same desktop split and compact overlay. Terminal shares `TerminalView`, xterm, and the phone key bar with the full-screen Computers terminal. The task view provides an **Enable terminal access** action when consent is off. Both the machine and task terminals remain owner-only.

Task terminal assignments carry an opaque `taskId`, never a browser path. Control checks the owner's task record and its assigned worker at creation, worker attachment, and during session sweeps. The worker resolves `<DEPLOY_WORKER_ROOT>/tasks/<taskId>` itself. The managed worker root is `<ordinary-user home>/.local/share/deploy.local/task-workers/<workerId>`; it follows the same `tasks/<taskId>` layout. If the folder is not prepared yet, an interactive terminal opens in home and explicitly says so. Non-interactive commands instead fail visibly until that task folder exists, to avoid accidentally running a command in home.

Task PTYs are separate from agent processes. Closing the panel or navigating detaches the browser; the worker keeps the shell until **End session**, permission revocation, disconnect from control, or the existing idle/lifetime limits. Reopening in the same browser document reattaches one session per task/viewer, with up to 64 KB of recent terminal output replayed from memory. Other browser tabs are independent viewers; reloading the document starts a new viewer. Detached output is bounded and acknowledged so background output cannot stall the worker. Machine-terminal socket-close behavior is unchanged.

In an existing task, start the composer text with `!` to run a command, for example `! npm test`. The Shell affordance names the computer and replaces Send with Run shell command. This calls the owner-only task shell endpoint instead of `/messages` or `/queue`; it never creates an agent run. Attachments are not accepted in shell mode. `/bin/sh -c` runs with closed stdin and a separate process group, in the resolved task directory. Commands may run alongside the agent; their cards record that an agent was running when they started. Stop kills the command process group, and both worker and coordinator enforce a ten-minute limit. Commands share the four-session cap, Terminal access consent, worker freshness, local veto and audit path with terminals.

Command records keep a UTF-8-safe 64 KB output tail, with a truncation indicator. Transcript snapshots and prompt context strip ANSI control sequences. Output updates wake the existing event stream without storing repeated output copies in audit events. Cards show command, computer, output, exit code, duration and Stop. Command start/end audit entries include the task ID and command. If control restarts, the next task read marks orphaned cards ended with a connection-loss explanation.

At run creation, visible commands changed since the previous run enter the run prompt as data: command, computer, state, exit code and the last 4,000 output characters. Version tracking prevents repeats and lets an in-flight command's later result reach the following turn. **Hide from agent** defaults off; hidden cards are excluded, including adapter-handoff conversation history. Hiding cannot retract a prompt already sent. Shell cards are excluded from generated publishing requests and from web agent-turn navigation. Existing Mac/iOS clients receive a read-only Markdown code-block representation in the existing message model; no Swift or native terminal UI changes are needed.

**Upgrade requirement:** rebuild and restart control/edge and every participating task worker (including the managed worker, bazzite and MacBook Pro). Updated workers advertise `task-terminal` in addition to `terminal`. A worker advertising only the earlier `terminal` capability is refused for both task terminals and commands, with **Update deploy.local on <computer>**. No dependency or port changes are required.

### Task conversation verification (macOS, 2026-10-24)

- Typecheck, lint and production build passed. Oxfmt was applied to changed files.
- Required server/edge/shared run: 340 passed, one existing skip, no failures. The final targeted task terminal, shell process, prompt-context and web rendering run passed all 27 checks, including coordinator-restart recovery and old-worker rejection added after the broad run.
- Required web run: 173 passed; two browser tests blocked at Chromium launch (`MachPortRendezvousServer`, macOS permission denied): the existing media viewer and new desktop/phone terminal recovery test. These were not skipped or counted as passing. The computer-use browser fallback also could not access a Chrome window, so live desktop/phone visual verification remains outstanding.
- Full `pnpm test`: 826 passed, 13 skipped, exactly the four identified baseline failures (two CA tests, Home Assistant readiness/catalog and rollback flush).
- No Swift files changed; Swift tests were not required. Existing native models continue decoding ordinary messages with the read-only command content.

### Files changed for task conversations

- Web: `projects.client.tsx`, `task-activity-rail.client.tsx`, `task-split-state.ts`, `terminal.client.tsx`, `terminal-state.ts`, `terminal.css`, `transcript-index.ts`, new `shell-command.client.tsx` and `shell-mode.ts` (all under `app/routes/dashboard/`).
- Coordinator and prompt context: `server/workspace/api.ts`, `terminal-relay.ts`, `terminal-service.ts`, `terminal-socket.ts`, `service.ts`, new `shell-commands.ts`. `publish.ts`, `checkpoint-commit.ts` and `task-presentation.ts` keep command cards out of publishing-request text.
- Workers: `server/workspace/remote-worker.ts`, `terminal-worker.ts`, `terminal-pty.ts`, `worker-capabilities.ts`, new `task-shell.ts`.
- Tests: `server/workspace/terminal-relay.test.ts`, `agent-context.test.ts`, new `task-shell.test.ts`; new `app/routes/dashboard/shell-mode.test.ts` and `task-terminal.test.mjs`.
- Documentation: this file. No package dependencies or Swift files changed.
