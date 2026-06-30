# deploy.local

Your own local cloud. Deploy and manage applications on your network with a CLI and web dashboard.

## Features

- **One-command deploys** — run `deploy` from any project directory
- **Auto-detection** — supports Node.js, static sites, and Dockerfiles
- **Web dashboard** — monitor deployments, view logs, track resources, and manage containers
- **mDNS routing** — each app gets its own `<name>.local` URL via multicast DNS
- **Live container logs** — stream logs in real time from the CLI or dashboard
- **Resource metrics** — track CPU, memory, network, and disk I/O over time
- **Request analytics** — automatic traffic logging with status codes, response times, and RPM
- **5xx captures** — failing requests automatically snapshot headers and request/response bodies for debugging (expand the row on the Requests page)
- **Deploy history** — full audit trail of deploys, restarts, and deletions
- **Multi-user auth** — register accounts, token-based authentication

## Prerequisites

- **Node.js 22+**
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
pnpm run service:status         # check state
sudo pnpm run service:uninstall # remove
```

Logs go to `.deploy-data/logs/server.log` and `server.err.log`.

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
curl -fsSL http://deploy.local/install | sh
```

This downloads the CLI binary and configures `~/.deployrc` with the server URL.

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
deploy list                List all deployments
deploy logs -app <name>    Stream logs from a deployment
deploy delete -app <name>  Delete a deployment
deploy open -app <name>    Open a deployment in the browser
deploy files               List files that will be bundled
deploy schema              Copy deploy.schema.json to current directory
deploy register            Create a new account
deploy login               Log in to an existing account
deploy logout              Log out
deploy whoami              Show current user
```

| Flag                         | Description                                  |
| ---------------------------- | -------------------------------------------- |
| `-u, --url <url>`            | Server URL (default: `https://deploy.local`) |
| `-app, --application <name>` | Application name                             |
| `-p, --port <port>`          | Server port (default: `443`)                 |
| `-h, --help`                 | Show help                                    |

**Aliases:** `d` (deploy), `ls` (list), `l` (logs), `rm` (delete), `o` (open), `f` (files), `r` (register), `who`/`me` (whoami), `start` (server).

## Supported project types

| Type        | Detection              | What happens                                             |
| ----------- | ---------------------- | -------------------------------------------------------- |
| **Docker**  | `Dockerfile` present   | Builds and runs your Dockerfile                          |
| **Node.js** | `package.json` present | Generates a Dockerfile, runs `npm install` + `npm start` |
| **Static**  | `index.html` present   | Serves files with a lightweight Node.js static server    |

## Development

```bash
pnpm dev          # Start dev server
pnpm test         # Run tests
pnpm run lint     # Lint with oxlint
pnpm run format   # Format with oxfmt
pnpm run typecheck # TypeScript checks
```

## License

See [LICENSE](LICENSE) for details.
