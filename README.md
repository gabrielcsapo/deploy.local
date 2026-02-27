# deploy.sh

A self-hosted deployment platform. Deploy and manage applications from your own server with a CLI and web dashboard.

## Features

- **One-command deploys** — run `deploy` from any project directory
- **Auto-detection** — supports Node.js, static sites, and Dockerfiles
- **Web dashboard** — monitor deployments, view logs, track resources, and manage containers
- **mDNS routing** — each app gets its own `<name>.local` URL via multicast DNS
- **Live container logs** — stream logs in real time from the CLI or dashboard
- **Resource metrics** — track CPU, memory, network, and disk I/O over time
- **Request analytics** — automatic traffic logging with status codes, response times, and RPM
- **Deploy history** — full audit trail of deploys, restarts, and deletions
- **Multi-user auth** — register accounts, token-based authentication

## Prerequisites

- **Node.js 22+**
- **Docker**

## Install

```bash
git clone https://github.com/gabrielcsapo/deploy.sh.git
cd deploy.sh
pnpm install
```

## Start the server

```bash
deploy server
```

Or with a custom port:

```bash
deploy server -p 3000
```

This starts the dashboard and API on `http://localhost` (or your chosen port). The server handles deployments, auth, Docker builds, and subdomain proxying.

## Create an account

```bash
deploy register
```

You'll be prompted for a username and password. Credentials are stored in `~/.deployrc`.

## Deploy an app

From any project directory:

```bash
npx deploy
```

Your app will be bundled, uploaded, built into a Docker image, and started. Visit `http://<name>.local` to see it running.

## CLI commands

```
deploy server              Start the deploy.sh server
deploy                     Deploy the current directory
deploy list                List all deployments
deploy logs -app <name>    Stream logs from a deployment
deploy delete -app <name>  Delete a deployment
deploy open -app <name>    Open a deployment in the browser
deploy register            Create a new account
deploy login               Log in to an existing account
deploy logout              Log out
deploy whoami              Show current user
```

| Flag                         | Description                              |
| ---------------------------- | ---------------------------------------- |
| `-u, --url <url>`            | Server URL (default: `http://localhost`) |
| `-app, --application <name>` | Application name                         |
| `-p, --port <port>`          | Server port (default: `80`)              |

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
