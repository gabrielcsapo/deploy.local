# deploy.local

Your own application cloud, on hardware you control. Define an application once, run its graph at
Home, and carry selected applications onto a detachable Docker-backed Suitcase site.

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
- **Sites and Suitcases** — pair a portable Docker target, choose which applications it should keep,
  work through its local admin/build surface while disconnected, and exchange authenticated state
  when it rejoins Home
- **Explicit data policy** — no data sync, manual sync, or automatic sync per application/site pair;
  multi-site sync is available only after a compatible portability report
- **Recovery boundary** — create, independently verify, rehearse, and automatically refresh
  encrypted Home recovery bundles before a cutover or trip

## What “supported” means in v1

deploy.local separates implemented capability from compatibility evidence. A parser accepting a
graph does not prove a particular target can run it, and a Catalog blueprint does not imply every
upstream configuration has been tested.

| Area                | v1 capability                                                                                                                                                               | Boundary                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application graph   | Multi-component Home/Suitcase/connected-agent execution, fixed instances, private services, jobs, volumes, health-gated traffic, and PostgreSQL lifecycle profile contracts | A graph is node-local in v1; components are not distributed across several execution nodes and the coordinator publishes one primary remote route |
| Catalog             | Signed, immutable blueprint import/install/preflight with exact OCI artifacts                                                                                               | Bundled entries are validation-stage contracts unless their evidence says otherwise; no physical-hardware claim is included                       |
| Suitcase target     | Inspectable Docker Compose target on Linux containers, including Docker Desktop on macOS/Windows; persistent state/content/build-cache volumes                              | Docker socket access is host-admin access; Wi-Fi hotspot and native `.local` integration remain host responsibilities                             |
| Fleet sync          | Pairing, site identities, docked/away/rejoining modes, resumable authenticated event/artifact exchange, revocation, and per-origin cursors                                  | A selected replica is not “ready offline” until release, data, identity/secrets, access, build/runtime, and capacity evidence pass                |
| Data reconciliation | Admitted SQLite row changesets and uploaded-file manifests with schema/conflict gates; opaque data follows one site or remains site-local                                   | Generic v1 semantic sync admits at most one declared SQLite file; PostgreSQL lifecycle support is not disconnected multi-writer merge             |
| Home recovery       | Encrypted bundle creation, offline verification, clean-directory restore primitive, rehearsal records, scheduled freshness/retention, and release-readiness gate            | Restore is an offline maintenance operation, not an in-place running-server action                                                                |

Portability reports classify an application as `stateless-replica`, `file-replica`,
`sqlite-replica`, `adapter-managed-replica`, `follows-one-site`, or
`not-suitcase-compatible`. Only the first four can unlock cross-site data sync. Capacity plans report
minimum and recommended memory/storage, their contributors, confidence, and unknown inputs; they do
not recommend a brand or certify an untested device.

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
deploy suitcase target      Create/start/upgrade/rollback the portable Docker target
deploy suitcase pair        Create or redeem a one-use site pairing
deploy suitcase topology    Show Home and Suitcase sites
deploy suitcase away        Mark the local Suitcase disconnected
deploy suitcase rejoin      Exchange state, then return to docked mode
deploy suitcase sync        Inspect sync or explicitly run manual sync
deploy suitcase access      Diagnose the offline admin URL and access mode
deploy suitcase revoke      Revoke a lost Suitcase from Home
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
Home emits a signed target command, and a disconnected Suitcase admits and applies it on rejoin.
Restart and replacement target only the requested component or instance and preserve unrelated
healthy siblings. On a Suitcase, local runtime commands remain local.

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
restored inventory, identity and key material, application/data lineage, and active Suitcase
credential hashes validate.

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

## Take applications offline with a Suitcase

A Suitcase is a separate site, not another execution node and not a clone of Home. The portable
target runs as Linux containers on Docker Engine or Docker Desktop. Start and inspect it on the
device you intend to carry:

```bash
deploy suitcase target compose
deploy suitcase target start --accept-docker-socket-risk
deploy suitcase target diagnose
```

The first start and every platform upgrade pull the requested core/helper pair and resolve both to
immutable OCI repository digests before activation. The target keeps health-admitted A/B platform
slots in `releases.json`; a failed candidate is automatically replaced with the still-active slot.
Use `deploy suitcase target rollback --accept-docker-socket-risk` to switch back explicitly. A
release is reported as signature-verified only when a cosign key or complete keyless identity/issuer
policy was supplied. `--allow-mutable-images` exists only for local image development and is
recorded as a development override, never as verified.

As an administrator, open **Dashboard → Sites → Pair suitcase**, choose the safe default data
policy, then redeem the one-use code on the target. The same workflow is available through the CLI:

```bash
# On Home
deploy suitcase pair create --name "Travel" --policy none

# On the target
deploy suitcase pair https://deploy.local --code <one-use-code>
```

Pairing writes a restricted bootstrap exchange in the target directory; suitcase-core copies the
authoritative fleet identity, credential, cursors, and queues into the persistent
`deploy-local-suitcase-state` volume. The docked core then syncs automatically with bounded retry,
so deleting the host launcher directory does not unpair a running suitcase. `sync now` remains the
explicit transfer action for applications whose data policy is `manual`.

For each application, open its **Data** page and choose **Keep on suitcase**. Placement and data
policy are separate: `none` creates a site-local data namespace; `manual` exchanges compatible data
only after `deploy suitcase sync now`; `automatic` exchanges compatible data while docked. Manual
and automatic modes require an evidence-backed portability report. Use **Analyze portability** to
briefly quiesce the Home graph, inspect a verified cold snapshot of its managed volumes, resume it,
restore that snapshot into an internal-network/read-only-root validation graph, exercise the actual
SQLite/file reconciliation primitives and any no-network build, then publish the exact signed
report/profile to the selected Suitcase. Structural classification alone never unlocks data sync. A
green **Ready offline** result means the specific release, target, data baseline, identity/secrets,
access path, and requested build mode were all materialized—not merely that a container once
started. The access check becomes green only after an authenticated administrator opens the
Suitcase dashboard through its private LAN address or `.local` name; localhost/self-probes do not
count, and the proof expires or invalidates when the appliance boot/network changes.

The application data topology is explicit. **Syncs across sites** exchanges admitted semantic
SQLite and uploaded-file changes against a retained common checkpoint; generic v1 admission permits
at most one declared SQLite file and preserves ambiguous row/file conflicts for an administrator.
**Follows one site** uses verified opaque snapshots with exactly one current writer and recovery-only
replicas elsewhere. Its initial setup never silently assumes Home: the administrator explicitly
chooses Home or the selected Suitcase as the first writer. Choosing the Suitcase starts the same
verified authority-transfer workflow used by later writer moves. **Site local** never implies
reconciliation.

When the analyzer needs application intent, a volume resource may declare `reconciliation`
`excludeTables`, relative `excludePaths`, and an explicit `conflictPolicy`. These annotations keep
derived/local-only content out of the shared profile but never waive integrity, primary-key,
schema, or opaque-format checks.

A Follows-one-site writer move is a durable cross-site handoff, not a metadata toggle. Plan it to
obtain the current authority epoch/data-sequence CAS, then start and inspect it:

```bash
deploy suitcase writer plan <app-id> <target-site-id>
deploy suitcase writer move <app-id> <target-site-id>
deploy suitcase writer status <transfer-id>
deploy suitcase writer abort <transfer-id>
```

The source is captured cold and remains quiesced while the authenticated snapshot and artifacts
cross Home. The target restores, passes health admission, and is quiesced again before Home commits
the next authority epoch. Only the commit starts the target writer. Failure or abort keeps the old
authority epoch and durably retries source resume; status distinguishes “aborted” from “source
resumed.” Both sites must reconnect to advance a cross-site handoff.

Operational history has its own bounded, cursor-based fleet stream. Semantic activity, completed
build output, backup inventory/content when its data policy permits, and one-minute request
aggregates converge across connected sites. Raw requests, request identity fields, captures,
container stdout/stderr, and high-frequency resource samples stay on the site that observed them.

Before leaving, verify the target. No departure command is required: after repeated authenticated
Home exchange failures the background loop records the target as Away locally, keeps applications
available, and continues probing for Home. The explicit mode command remains useful as an override:

```bash
deploy suitcase sync status
deploy suitcase access
# optional override: deploy suitcase away
```

You can use the Suitcase dashboard and deploy/build locally while Home continues to serve its own
replicas. Away-built releases return as candidates; Home never accepts one silently. When the
device is back on a network that can reach Home:

```bash
deploy suitcase rejoin
deploy suitcase sync status
```

The background loop returns to Docked after a successful exchange; `rejoin` forces that exchange
immediately. Rejoin exchanges immutable events and artifacts idempotently. Review row/file
conflicts in **Sites** and the application **Data** page; review
away-built releases in **Releases**. A collision is retained as evidence until an administrator
chooses Home, Suitcase, or—only for uploaded-file path conflicts—keep both. Schema, validation, and
custom repairs require a new branch that passes portability validation before it can be adopted.

### Home recovery runbook

Before relying on a Suitcase, use the recovery commands above to evaluate readiness, create an
encrypted bundle, and verify it independently. Keep the file and passphrase separately. Recovery is
deliberately offline: stop the replacement Home, restore the verified bundle into an empty server
data directory, then start Home and verify fleet ID, Home site ID, application revisions, site
credentials/revocations, and artifact inventory before allowing Suitcases to rejoin. The same
operations are available through the administrator-only `/api/operations/recovery-bundles` API
family. Raw re-pairing is not recovery—it creates a different lineage.

See the built-in **v1 Support & Workflows** page for the complete compatibility matrix, capacity
planning inputs, and API examples.

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
