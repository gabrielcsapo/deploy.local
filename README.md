# deploy.local

Projects, durable coding tasks, and applications on hardware you control. The project workspace
adds a shared browser/native harness alongside the existing deployment engine. Portable-site
runtime remains in this revision while its retirement and data inventory are unfinished.

## Project workspace pilot

Repository hosting now has a supervised background import/fetch service, setup diagnostics, and
commit-pinned source APIs, Git LFS, issues, pull requests, and Linux/macOS pipelines in `deploy.yaml`.
A real Linux check → Mac Swift build → healthy Linux release has passed. See
[repository server setup and offline recovery](docs/plans/repository-server.md). Windows execution is deferred.

Open `/dashboard` to create/import a committed Git repository, start a task in an isolated worktree,
and run Codex through an independent ordinary-user worker. Existing deployments remain under
`/dashboard/apps`. macOS/iOS client sources and setup are in [`native/`](native/).

The shared API uses existing deploy.local account/session authentication. See
[the versioned API contract](docs/plans/workspace-api.md) and
[implementation evidence and remaining milestones](docs/plans/workspace-implementation.md).
This is a usable local pilot, not completion of every project-workspace milestone.

For a disposable development instance (Node 26; never point this at production data):

```sh
# Terminal 1: API/auth only; does not start deployment/fleet reconciliation
DEPLOY_DATA_DIR=/tmp/deploy-workspace-pilot pnpm workspace:preview
# Terminal 2: independent coding worker, same explicit data directory
DEPLOY_DATA_DIR=/tmp/deploy-workspace-pilot pnpm workspace:worker
# Terminal 3: browser client
DEPLOY_DATA_DIR=/tmp/deploy-workspace-pilot DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:17843 pnpm exec vite --host 127.0.0.1 --port 15173 --strictPort
```

Open `http://127.0.0.1:15173/dashboard`. The disposable preview creates the synthetic account
`workspaceqa` / `Workspace-QA-2026!`; its session is saved only in the selected temporary directory.
The production API exposes the same workspace routes using ordinary existing accounts, without
creating a preview account. Start the coding worker separately as an ordinary user; closing any
client or restarting the API does not own that worker's lifetime. Built worker entry points are
`dist/workspace-worker.js` and `dist/workspace-remote-worker.js`.

Codex uses the worker's authorized account. An exact model name is optional; unsupported names
fail visibly and never trigger an inference fallback. A second provider-independent tool loop is
available only with an explicitly configured compatible endpoint:

```sh
DEPLOY_MODEL_BASE_URL=http://127.0.0.1:11434/v1
DEPLOY_MODEL_NAME=your-installed-model
DEPLOY_MODEL_BILLING_MODE=local  # use api for an explicitly chosen billed endpoint
# DEPLOY_MODEL_API_KEY may be set when that endpoint requires it.
```

Set these environment variables on the API and selected worker processes; selecting the
`compatible` adapter then uses that endpoint. No model/server is installed or downloaded
implicitly. Task shell/check commands run as the worker’s ordinary host user; a Git worktree is not a
security sandbox. Provider/session/worker credential variables are removed from their subprocess
environments. The loop supports repository read/write/search, shell commands, retained context,
usage events, and cancellation. An opt-in browser/computer control tool is now wired through
the shared worker protocol; permission questions and full desktop acceptance remain unfinished. In addition to synthetic protocol tests, the disposable mesh pilot has exercised
Lemonade on SER with `Qwen3-8B-GGUF`: a task started on macOS, continued from iOS Simulator,
and dispatched a successful Linux check from the browser using the same retained model session.
The model needed two corrective prompts before its generated tests passed. This verifies the
integration, not unattended coding quality. See
[Lemonade acceptance evidence](docs/evidence/workspace/lemonade-acceptance.json).

For approved Linux desktop screenshots and macOS window control, see
[Desktop capture setup](docs/desktop-capture.md).

For that existing home server, the explicit settings are:

```sh
export DEPLOY_MODEL_BASE_URL=http://ser.local:11434/api/v1
export DEPLOY_MODEL_NAME=Qwen3-8B-GGUF
export DEPLOY_MODEL_BILLING_MODE=local
```

Apply them to the coordinator and coding worker before starting those processes. In the composer,
open the model selector and choose **Qwen3-8B-GGUF** under **Local / API**. This is inference on the existing
LAN server, independent of Codex/Claude subscription billing. No additional model was downloaded.
The current pilot settings are process-local; production service configuration was not changed.

Voice input uses a separate transcription endpoint configured on the coordinator:

```sh
export DEPLOY_TRANSCRIPTION_BASE_URL=http://ser.local:11434/api/v1
export DEPLOY_TRANSCRIPTION_MODEL=Whisper-Base
# DEPLOY_TRANSCRIPTION_API_KEY is optional for authenticated providers.
```

The mic records up to two minutes, inserts a transcript into the draft, and leaves sending to you.
Both clients submit mono PCM WAV for compatibility. Browser recording requires microphone access
and a secure context (HTTPS or localhost). On the current SER installation, Whisper-Base uses a
saved CPU backend override because its default ROCm backend failed. The pilot's synthetic sentence
transcribed in about 0.9 seconds. Actual Mac and browser microphone capture also passed: both
inserted the spoken sentence into an editable draft without sending. Physical iPhone capture remains
unverified. See [voice evidence](docs/evidence/workspace/voice-acceptance.json).
The coordinator environment above is enabled only in the disposable preview so far.

Connect a remote computer through **Dashboard → Computers → Connect a computer**. Choose
macOS or Linux, name the computer, and select its roles. Copy the command and enrollment code:

```sh
deploy agent join https://deploy.local
```

Run as your normal login on macOS and for Linux coding-only workers. On Linux, use
`sudo deploy agent join https://deploy.local` when **Deploy apps** is enabled; the task worker
still runs as the invoking login user. Join installs a task worker for **Coding tasks**, an
execution agent for **Deploy apps**, or both. The CLI contains the worker; no checkout,
manual environment variables, or operator session token is needed. Complete provider sign-in,
Chromium installation (for browser control), and desktop permissions locally.

`deploy agent status` reports coordinator roles and each local service. `deploy agent install`
repairs services for the selected roles; if Coding tasks was enabled after enrollment and no
worker credential exists, create a new enrollment and join again. `deploy agent uninstall`
removes both local services and the credential file, keeping the coordinator record and worker
files. Role changes stop new work; they do not start missing services automatically.

The scoped task-worker token can report assigned runs and read their Git repositories; it cannot
send chat, create projects, browse unrelated repositories, or push hosted Git. Re-enrollment
rotates credentials. The CLI uses system CA trust and passes it to worker tools.

## Features

- **One-command deploys** — run `deploy` from any project directory
- **Durable application graphs** — versioned `deploy.yaml` definitions, canonical digests, revision
  history, and semantic change plans
- **Application graph runtime** — build- or image-backed components, fixed instance groups, private
  services, lifecycle jobs, volumes, and health-gated routes
- **Connected execution nodes** — build and run complete node-local application graphs on enrolled
  Docker hosts while keeping one primary application URL
- **Declared configuration** — typed, required, site-aware values with encrypted secret storage
- **Auto-detection** — supports Node.js, static sites, and Dockerfiles
- **Web dashboard** — monitor deployments, view logs, track resources, and manage containers
- **mDNS routing** — each app gets its own `<name>.local` URL via multicast DNS
- **Live container logs** — stream logs in real time from the CLI or dashboard
- **Resource metrics** — track CPU, memory, network, and disk I/O over time
- **Request analytics** — automatic traffic logging with status codes, response times, and RPM
- **5xx captures** — failing requests automatically snapshot headers and request/response bodies for debugging (expand the row on the Requests page)
- **Deploy history** — full audit trail of deploys, restarts, and deletions
- **Multi-user auth** — register accounts, token-based authentication
- **Catalog** — install exact signed blueprint releases with declared configuration, target grants,
  compatibility promises, and evidence that stays separate from the blueprint

- **Explicit data policy** — no data sync, manual sync, or automatic sync per application/site pair;
  multi-site sync is available only after a compatible portability report
- **Recovery boundary** — create, independently verify, rehearse, and automatically refresh
  encrypted Home recovery bundles before a cutover or trip

## What “supported” means in v1

deploy.local separates implemented capability from compatibility evidence. A parser accepting a
graph does not prove a particular target can run it, and a Catalog blueprint does not imply every
upstream configuration has been tested.

| Area              | v1 capability                                                                                                                                                             | Boundary                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application graph | Multi-component coordinator/connected-agent execution, fixed instances, private services, jobs, volumes, health-gated traffic, and PostgreSQL lifecycle profile contracts | A graph is node-local in v1; components are not distributed across several execution nodes and the coordinator publishes one primary remote route |
| Catalog           | Signed, immutable blueprint import/install/preflight with exact OCI artifacts                                                                                             | Bundled entries are validation-stage contracts unless their evidence says otherwise; no physical-hardware claim is included                       |
| Home recovery     | Encrypted bundle creation, offline verification, clean-directory restore primitive, rehearsal records, scheduled freshness/retention, and release-readiness gate          | Restore is an offline maintenance operation, not an in-place running-server action                                                                |

## Prerequisites

- **Node.js 26.1**
- **Docker**
- **OpenSSL** — used to generate TLS certificates on first startup

## Install

```bash
git clone https://github.com/gabrielcsapo/deploy.local.git
cd deploy.local
pnpm install && pnpm build
```

## Start the server

```bash
pnpm start
```

This runs a small supervisor that manages two processes:

- **edge** — TLS, the `*.local` reverse proxy, WebSocket tunneling, mDNS, and
  TCP proxies. Stays up while the rest of the system restarts, so deployed
  apps never drop traffic.
- **control** — API, dashboard, builds, and Docker orchestration on
  `127.0.0.1:7843`, fronted by the edge. If it crashes the supervisor
  restarts it; apps are unaffected and the dashboard shows a brief
  "restarting" page.

Either process is restarted automatically on crash. `pnpm start:single` runs
the legacy everything-in-one-process mode.

### Run as a supervised service (recommended)

On macOS, install the server as a launchd daemon so it starts at boot and is
automatically restarted if it ever crashes:

```bash
pnpm build
sudo pnpm run service:install   # writes /Library/LaunchDaemons/sh.deploy.server.plist
sudo pnpm run service:stop      # stop temporarily without uninstalling
sudo pnpm run service:restart   # restart edge + control after a new build
pnpm run service:status         # check state
sudo pnpm run service:uninstall # remove
```

Logs go to `.deploy-data/logs/server.log` and `server.err.log`.

On Linux, [configure ordinary-user release updates](docs/linux-release-updates.md) once to use
`deploy-update prepare` and `deploy-update activate` over SSH without sudo on subsequent updates.

### Menu bar status (macOS)

A small menu bar app shows fleet health at a glance: a colored dot (green
when edge + control are running, orange while a child is restarting or
Docker is unreachable, red when the supervisor is down) plus the running
container count and their live CPU/memory consumption, e.g. `● 6 · 28% · 1.4G`.
The dropdown breaks it down: per-process pids/uptime/restart counts,
CPU/memory as a share of the Docker VM's capacity, per-container usage, and
shortcuts to the dashboard and server log.

```bash
pnpm run menubar:install    # build with swiftc + install as a LaunchAgent (no sudo)
pnpm run menubar:uninstall  # remove
```

It subscribes to `.deploy-data/supervisor.sock` — the supervisor pushes
child-process state on every transition and relays container stats published
by the metrics collector, so there are no status files and no polling, and a
dead supervisor shows up instantly via socket close. Works with both
`pnpm start` and the launchd service (not the legacy `start:single` mode,
which has no supervisor). Requires the Xcode Command Line Tools for the
one-time build.

This starts the HTTPS server on port 443 (with an HTTP redirect server on port 80). The dashboard is available at `https://deploy.local`. The server handles deployments, auth, Docker builds, TLS certificates, and subdomain proxying via mDNS.

On first startup, a local CA certificate is generated. To avoid browser TLS warnings, trust the CA cert on each client machine:

```bash
curl -O http://deploy.local/ca.crt
# macOS: open the file, add to Keychain, set to "Always Trust"
# Linux: copy to /usr/local/share/ca-certificates/ and run sudo update-ca-certificates
```

## Install the CLI (on other machines)

To deploy from a different machine on the same network:

```bash
# macOS and Linux
curl -fsSL http://deploy.local/install | sh
```

On Windows PowerShell:

```powershell
irm http://deploy.local/install.ps1 | iex
```

These installers download the matching CLI binary and configure the local deploy settings with the
server URL.

## Create an account

```bash
deploy register
```

You'll be prompted for a username and password. Credentials are stored in `~/.deployrc`.

## Deploy an app

From any project directory:

```bash
deploy
```

Your app will be bundled, uploaded, built into a Docker image, and started. Visit `https://<name>.local` to see it running.

## CLI commands

```
deploy server              Start the deploy.local server
deploy                     Deploy the current directory
deploy validate            Validate and summarize the local application graph
deploy plan --app <name>   Compare the local graph with the server
deploy list                List all deployments
deploy logs -app <name>    Stream logs from a deployment
deploy ssh <name>          Open an interactive shell in a deployment
deploy delete -app <name>  Delete a deployment
deploy open -app <name>    Open a deployment in the browser
deploy files               List files that will be bundled
deploy schema              Copy the deploy.yaml v1 schema
deploy register            Create a new account
deploy login               Log in to an existing account
deploy logout              Log out
deploy whoami              Show current user
deploy version             Show the installed build
deploy upgrade             Update the CLI to the build the server serves
deploy nodes enroll        Create a one-time execution-node enrollment
deploy agent join <url>     Enroll this machine and install its agent service
deploy agent install        Repair or reinstall the agent service
deploy agent status         Check this machine's agent connection
deploy component inspect    Compare desired, active, and actual graph state
deploy component scale      Create a revision with a new fixed instance count
deploy component restart    Restart one component without replacing siblings
deploy component replace    Replace one component instance by stable instance ID
deploy component operation  Run a supported profile operation with declared variables
deploy catalog list         Browse supported one-click applications
deploy catalog inspect      Inspect one exact signed blueprint release
deploy catalog install      Install through the ordinary application graph
deploy catalog installations|status|upgrade|rollback|retry|uninstall
                            Operate catalog-managed applications
deploy recovery readiness   Evaluate the complete v1 release/recovery gate
deploy recovery create|verify|rehearse|restore|list|support
                            Operate encrypted Home recovery and support artifacts
```

| Flag                         | Description                                       |
| ---------------------------- | ------------------------------------------------- |
| `-u, --url <url>`            | Server URL (default: `https://deploy.local`)      |
| `-app, --application <name>` | Application name                                  |
| `-p, --port <port>`          | Server port (default: `443`)                      |
| `--check`                    | Report an available upgrade without installing it |
| `--force`                    | Reinstall even when the versions match            |
| `--json`                     | Machine-readable output (`version`)               |
| `-v, --version`              | Show the installed build                          |
| `-h, --help`                 | Show help                                         |

**Aliases:** `d` (deploy), `ls` (list), `l` (logs), `rm` (delete), `o` (open), `f` (files), `r` (register), `who`/`me` (whoami), `start` (server), `update` (upgrade).

### Versions and upgrading

A CLI build is stamped with the commit it was built from and the time it was
built — `1.0.0+c4d1a04.20260724T173839Z` — so rebuilding the same commit still
produces a distinct version.

```
deploy version          # what's installed here
deploy upgrade          # replace it with the build this server serves
deploy upgrade --check  # exits 1 if the server has a different build
```

`deploy upgrade` downloads the binary for your platform from the server, checks
it against the SHA-256 in the server's manifest, runs it once, and only then
swaps it over the installed binary. Versions are compared for equality, not
order: the CLI's job is to match its server, so a server rolled back to an older
build pulls the CLI back with it.

The server publishes what it serves at `GET /cli/version`. Both come from
`pnpm build:cli` — until that has run on the server, upgrades report that no
build is available.

### Graph, Catalog, and recovery operations

`deploy validate` compiles the local `deploy.yaml` without changing the server. The
`deploy plan --app <name>` command compares that normalized graph with the server's desired revision
and reports the semantic change plan. `deploy schema` copies the public v1 schema for editor and CI
use.

Component operations keep graph intent and runtime actions distinct:

```bash
deploy component inspect <app> [--site <site-id>]
deploy component scale <app> <component> <instances> [--site <site-id>]
deploy component scale <app> <component> --site <site-id> --use-default
deploy component restart <app> <component>
deploy component replace <app> <component> <instance-id>
deploy component operation <app> <component> <operation> --variables '{"key":"value"}'
```

Graph-wide scaling creates an immutable desired revision. A site-scoped count is operational state:
The coordinator controls placement and dispatches work to enrolled execution nodes.
Restart and replacement target only the requested component or instance and preserve unrelated
healthy siblings.

Catalog commands operate on signed immutable releases while using the ordinary application graph
runtime:

```bash
deploy catalog list
deploy catalog inspect <catalog-id> [release]
deploy catalog install <catalog-id> [release]
deploy catalog installations
deploy catalog status <installation-id>
deploy catalog upgrade <installation-id> <release>
deploy catalog rollback <installation-id> <recovery-point-id>
deploy catalog retry <installation-id>
deploy catalog uninstall <installation-id>
```

Home recovery is administrator-only and deliberately explicit:

```bash
deploy recovery readiness
deploy recovery create --output <server-bundle-path>
deploy recovery verify <server-bundle-path>
deploy recovery rehearse <bundle-id> <server-bundle-path>
deploy recovery restore <server-bundle-path> <empty-server-data-directory>
deploy recovery list
```

Passphrases are prompted when omitted. Recovery paths name files/directories on Home because bundle
creation, verification, clean-directory rehearsal, and restore are maintenance operations executed
by Home. Rehearsal restores into an isolated temporary directory and records `passed` only after the
restored inventory, identity and key material, and application/data lineage validate.

For unattended freshness, set `DEPLOY_RECOVERY_PASSPHRASE` to a dedicated value of at least 12
characters. Home then creates, independently verifies, rehearses, and retains scheduled bundles
daily. `DEPLOY_RECOVERY_DIRECTORY`, `DEPLOY_RECOVERY_RETENTION`, and
`DEPLOY_RECOVERY_SCHEDULE` override the destination, retained count, and cron schedule. Keep the
passphrase outside the server data directory and monitor `deploy recovery readiness`.

### Add an execution node

The first registered account is the fleet administrator. Open **Dashboard → Nodes**, name the new
machine, and create a short-lived enrollment. The CLI remains available for automation:

```bash
deploy nodes enroll --name imac
```

On the new machine, install the deploy CLI, then redeem the printed code:

```bash
# macOS — run as your normal desktop user
deploy agent join https://deploy.local

# Linux
sudo deploy agent join https://deploy.local
```

The agent installs as a per-user launchd agent on macOS, so it can access Docker Desktop and mounted
storage, or as a systemd service on Linux. It connects outbound to the coordinator and does not
advertise any mDNS names. Choose the default node under
**Dashboard → Nodes**; application placement can be changed from each application's Settings page.
Only the main coordinator advertises `deploy.local`, `discover.local`, and application hostnames.

You always deploy to the coordinator. It dispatches the build to the selected node, verifies the
result, and keeps the application at the same `https://<name>.local` URL. The Nodes page shows agent
health, Docker capability, running applications, job stages, byte progress, and recent failures.

For `deploy.yaml`, that job carries the coordinator-admitted graph and resolved site configuration
inside the existing encrypted agent-job envelope. The agent verifies the downloaded manifest,
builds or pulls every component, creates fixed instance siblings on one private network, runs
health-gated lifecycle jobs, and returns exact instance plus primary-route metadata. Managed graph
volumes live in the agent backup namespace, so ordinary remote backup/delete behavior remains
coherent. The coordinator exposes the graph's first route through the application relay in v1;
cross-node component placement and multiple independently relayed public routes remain future work.

Changing a legacy application's node moves its managed `/app/data` and `/app/uploads` volumes before
the next build. **Move now** performs the same migration from the latest retained source artifact
without another CLI upload. The old route remains active until the destination container is healthy,
then the coordinator switches traffic and cleans up the previous container. Stateful graph placement
uses its declared profile/recovery workflow rather than implying that this legacy archive can move an
arbitrary graph resource safely.

Remote application traffic passes through an agent-owned LAN relay, including Docker Desktop and
Colima setups whose published ports are otherwise loopback-only. Logs and interactive terminal
sessions are tunneled through the authenticated agent control channel. Scheduled remote backups are
collected on the coordinator so its external rsync schedule protects the entire fleet.

See [Nodes & Placement](https://deploy.local/docs/nodes) in the built-in documentation for the full
workflow and troubleshooting guide.

## One home coordinator

Computers enroll as execution nodes. Projects, issues, pull requests, conversations, and pipeline
history stay on the coordinator. A disconnected computer does not become an independent coordinator.
Portable sites and cross-site reconciliation are retired. Upgrades stop if portable-site records
still need export and migration; existing application data is never discarded automatically.

## Supported project types

| Type        | Detection              | What happens                                             |
| ----------- | ---------------------- | -------------------------------------------------------- |
| **Docker**  | `Dockerfile` present   | Builds and runs your Dockerfile                          |
| **Node.js** | `package.json` present | Generates a Dockerfile, runs `npm install` + `npm start` |
| **Static**  | `index.html` present   | Serves files with a lightweight Node.js static server    |

## Development

```bash
pnpm run dev:ui   # Develop the UI at https://deploy.local through the running service
pnpm dev          # Standalone full-stack development on unprivileged ports
pnpm test         # Run tests
pnpm run lint     # Lint with oxlint
pnpm run format   # Format with oxfmt
pnpm run typecheck # TypeScript checks
```

`dev:ui` keeps the production edge and control plane on ports 443/7843, sends dashboard pages and
Vite HMR to port 5173, and leaves `/api`, `/ws`, agent enrollment, and deployed app traffic on the
running service. When the Vite process exits or cannot be reached, the edge falls back to the built
dashboard automatically.

## License

See [LICENSE](LICENSE) for details.
