# deploy.local 1.0: Application Graph and Suitcase

Status: Implemented integration plan; release-evidence collection in progress  
Date: 2026-08-07  
Target branch: `codex/v1-integration`

The v1 graph, Catalog, Suitcase, synchronization, reconciliation, PostgreSQL profile, admin, CLI,
and Home-recovery code described here is integrated. The phase checklists remain as the architecture
record and acceptance matrix. Physical-device runs, abrupt-power drills, platform-specific hotspot
checks, and 24-hour docked/away soaks are release evidence for exact builds and targets; they are not
unfinished product subsystems.

## Executive decision

deploy.local 1.0 is implemented as a personal application cloud whose topology can change:
nodes can join a fleet, applications can be placed across those nodes, and a portable subset of the
fleet can detach, remain writable without internet access, and rejoin later.

This work is the deploy.local **1.0** product cutover. Earlier implementations are pre-release
history: there has not been an npm release or a public manifest compatibility promise. Version 1.0
therefore establishes the first durable application contract, `apiVersion: deploy.local/v1`, while
retaining today's unversioned `deploy.json` as a compatibility input.

The product primitive that enables this is a **suitcase**:

> A suitcase is a detachable, offline-capable deploy.local site that carries active replicas of
> selected applications, keeps them writable while disconnected, and synchronizes their releases,
> database records, and uploaded files across the fleet.

The recurring user experience must be this simple:

1. Pair a suitcase once.
2. Turn on **Keep on suitcase** for selected applications.
3. Wait for **Ready offline**.
4. Unplug the suitcase and take it.
5. Continue using the dashboard and the normal `deploy` command while offline.
6. Reconnect it at home and let it synchronize automatically.

There is no recurring export, pack, checkout, or database-copy workflow.

The same application graph also powers a second product surface: a curated catalog of
**one-click applications**. deploy.local supports installing, configuring, backing up, and
upgrading a versioned application package even when the upstream application has no deploy.local
integration. Catalog applications and source-built applications use the same runtime, service,
storage, placement, and suitcase model; the catalog is not a parallel deployment engine.

## Product thesis

deploy.local does not primarily manage virtual machines or containers. It manages an application
graph that can change shape across hardware and connectivity boundaries.

Recommended positioning:

> **Your cloud is wherever your nodes are.**  
> Run applications across the machines you own. Take part of your cloud offline, keep deploying
> while you travel, and reconnect when you return.

The distinction is application mobility:

- nodes provide compute;
- sites define network and authority boundaries;
- the fleet is the complete application graph;
- placement determines where an application lives;
- a suitcase is a detachable site;
- the remaining home graph continues running when a suitcase leaves;
- the detached graph and home replicas remain locally usable and writable;
- multiple suitcases may diverge temporarily and converge through verified checkpoints and
  changesets;
- reconnection reunites the graph without merging raw database or volume files.
- curated blueprints can instantiate complete application graphs, including databases, workers,
  migrations, secrets, devices, and routes;
- “supported installation” and “safe disconnected data reconciliation” remain separate promises.

## Goals

### Product goals

- Let an administrator plan a suitcase from measured home-hub workloads before choosing or buying
  hardware.
- Start and pair a suitcase deploy target on macOS, Linux, or Windows through one Docker-backed
  command without repository checkout or recurring setup.
- Make an application portable with one clear control.
- Provide an honest, testable **Ready offline** state.
- Let the user unplug without running a departure command.
- Preserve `https://deploy.local`, application `.local` names, authentication, dashboard access,
  logs, terminal access, backups, and the normal `deploy` workflow while away.
- Allow existing and new applications to be deployed while offline.
- Keep non-portable applications at home running normally.
- Let home and multiple suitcases continue serving selected applications and accepting data while
  disconnected.
- Rejoin automatically and reconcile application records and uploaded files across sites.
- Preserve a safe snapshot-only mode for applications that cannot participate in multi-site sync.
- Make the fleet graph legible in the admin UI, homepage, CLI, and documentation.
- Install a curated third-party application through one guided transaction without requiring its
  upstream project to adopt deploy.local.
- Give source-built and catalog applications the same first-class profiled-service bindings,
  backup/restore lifecycle, placement controls, and compatibility reporting.
- Run fixed multi-instance components behind health-aware service routing while presenting one
  coherent application and honest failure-domain status.
- Make `deploy.yaml` the portable, versioned, source-controlled application graph and make the admin
  UI a visual editor that can export the complete manifest or a reviewable patch.
- Declare every administrator-supplied configuration value and secret needed to start an
  application, validate it before execution, and never place resolved secret values in the
  manifest.

### Engineering goals

- Never replicate a live SQLite database between coordinators.
- Give fleets, sites, applications, events, and artifacts stable identities independent of names.
- Separate release authority, site replicas, same-site component instances, and multi-writer
  application data reconciliation.
- Make database/file branch changesets globally identifiable, based on verified checkpoints,
  idempotent, conflict-detecting, and replay-safe across any number of sites.
- Make every synchronization operation resumable, content-verified, idempotent, and replay-safe.
- Treat a power loss or network loss at any transfer boundary as recoverable.
- Keep ordering correct without trusting wall-clock time while offline.
- Preserve compatibility with ordinary coordinator and execution-node deployments.
- Build on the existing placement, remote-job, retained-artifact, backup, edge, and mDNS code.
- Normalize catalog blueprints and developer configuration into one versioned application graph.
- Canonicalize every accepted graph into deterministic JSON, address revisions by digest, and keep
  the normalized specification as an artifact rather than only as relational projection rows.
- Reconcile desired component counts into replaceable instances and update ready endpoint sets
  atomically without coupling migrations or data backups to instance count.
- Plan graph changes before applying them so resource identity, renames, data preservation,
  restarts, rollouts, and destructive operations are explicit.
- Make Home replaceable from an encrypted recovery bundle without losing fleet identity, application
  revision history, secret-store access, site trust, or data lineage.

## Non-goals for the first release

- Active-active writable filesystem or raw database-file replication.
- Automatic semantic merging for arbitrary opaque Docker volumes.
- Declaring arbitrary or opaque volume content safe when the portability analyzer cannot prove that
  every durable mutation can be reconciled or surfaced as a conflict.
- Kubernetes, VM migration, or a Proxmox-compatible cluster layer.
- Guaranteed installation of arbitrary new internet dependencies while offline.
- Internet access to the suitcase or tunnelling home traffic through it.
- Multiple home coordinators.
- Peer-to-peer suitcase synchronization without home in the first release; home is the durable
  exchange hub when sites rejoin.
- Full replication of raw request logs, container logs, captures, and high-frequency metrics.
- Hiding an ownership conflict after somebody explicitly breaks suitcase authority.
- Claiming support for every Docker Compose feature or importing arbitrary Compose files without a
  security and compatibility review.
- Generic offline multi-writer reconciliation for PostgreSQL, MySQL, Redis, or other service data.
- Promising upstream application support merely because deploy.local supports one of its packaging
  recipes.

## Vocabulary and domain model

The same terms should be used in UI copy, CLI output, docs, APIs, and code.

| Term               | Meaning                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Fleet              | The complete deploy.local graph and its stable identity.                                                    |
| Site               | A network and authority boundary containing one or more nodes.                                              |
| Home               | The primary site and fleet coordinator.                                                                     |
| Node               | A machine that provides compute and storage to a site.                                                      |
| Suitcase           | A detachable site with a portable coordinator, edge, executor, and local projection.                        |
| Application        | A logical product made of one or more components and resources.                                             |
| Component          | Any runnable process/container: web, worker, proxy, scheduler, PostgreSQL, Redis, or job.                   |
| Lifecycle profile  | Optional typed operational capabilities attached to a component, such as PostgreSQL backup/restore/upgrade. |
| Managed service    | User-facing label for a normal component with a supported lifecycle profile.                                |
| Resource           | A non-runnable volume, secret, route, network, device, or external-service binding.                         |
| Blueprint          | A declarative, versioned recipe that produces an application graph.                                         |
| Catalog release    | A tested blueprint version pinned to exact upstream artifacts and support metadata.                         |
| Replicated app     | An application with an active site and data replica at more than one site.                                  |
| Site replica       | A site-local materialization of the complete application graph and data namespace.                          |
| Component instance | One ephemeral runtime copy of a component within a site replica.                                            |
| Release authority  | The site allowed to promote a candidate into the desired application release.                               |
| Generation         | A monotonic application revision assigned by its authority.                                                 |
| Authority epoch    | A generation namespace changed only when authority is forcibly broken.                                      |
| Fleet event        | An immutable semantic operation that can be replayed into a site projection.                                |
| Data changeset     | An immutable row/file difference from a shared checkpoint to one site's branch.                             |
| Data checkpoint    | A verified SQLite/filesystem state used as the shared base for future reconciliation.                       |
| Branch base        | The checkpoint from which one site's current writable data diverged.                                        |
| Data sync policy   | Per-app/per-suitcase cadence: automatic, manual, or no site-to-site data sync.                              |
| Artifact           | Content-addressed source, image, backup, release, or other transferable content.                            |
| Materialized       | All data required for an advertised readiness capability exists and verifies locally.                       |
| Docked             | The suitcase can authenticate and synchronize with home.                                                    |
| Away               | The suitcase is operating independently on a non-home network.                                              |
| Rejoining          | The suitcase is synchronizing events and artifacts after returning.                                         |
| Ready offline      | Runtime, identity, routing, data, and required artifacts have passed readiness checks.                      |

“Shard” is useful in engineering discussions. User-facing language should say “keep on suitcase,”
“take with you,” “ready offline,” and “rejoining.”

## The foundational replication choice

An application marked **Keep on suitcase** gains an active replica on that suitcase. Its home
replica remains active unless the user explicitly disables it. Each site serves its local users and
accepts local application data while disconnected.

```text
                         docked synchronization
       +--------------------------------------------------------+
       |                                                        |
Home app replica <---- changesets + immutable blobs ----> Fleet exchange
       ^                                                        ^
       |                                                        |
Home users                                            Suitcase A/B/... replicas
                                                               ^
                                                               |
                                                        travelling users
```

The replicas do not merge database or filesystem pages. deploy.local snapshots each branch,
computes SQLite row changes and uploaded-file differences from a shared base, applies them to a
staging checkpoint with explicit conflict handling, and distributes the verified merged result.
While disconnected, each replica mutates its ordinary local database/files; no application library
is required.

This is an eventually consistent, local-first application data model. Deploy and configuration
releases still use candidates and explicit promotion because code/schema rollout has different
risks from ordinary record synchronization.

Applications whose volume analysis is unsafe remain supported in **Follows one site** mode. Their
opaque managed volume has one writer and reconciles through verified snapshots. They can travel,
but they cannot remain writable at home and on suitcases simultaneously.

## Per-application suitcase sync policy

**Keep on suitcase** controls placement. A separate **Data sync** setting controls what happens to
that app's durable data on each selected suitcase. The app has a default policy and an administrator
may override it per suitcase.

| Policy             | Behavior while docked                                                                                    | Behavior while away                                                                    | Readiness meaning                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Automatic sync** | Continuously exchange changesets/blobs and publish clean validated checkpoints.                          | Record a local branch from the last shared base; reconcile automatically after return. | Green only when the replica has a retained base, required blobs, compatible profile, and no known unsynchronized branch outside the freshness window.                          |
| **Manual sync**    | Detect and summarize changes but do not transfer/apply them until an administrator chooses **Sync now**. | Record a local branch from the retained base.                                          | Runtime may be ready, but **Ready to go** remains amber while known home/suitcase changes are pending.                                                                         |
| **No data sync**   | Releases/configuration may still materialize, but each site keeps a separate local data namespace.       | Continue using only the suitcase-local data.                                           | No reconciliation readiness is claimed; green means the local namespace is initialized, healthy, backed up according to its own policy, and explicitly accepted as site-local. |

During pairing, require the administrator to choose the suitcase's default data policy. New app
replicas inherit that choice and may override it individually. Do not silently choose automatic sync
because a schema happens to be compatible. For unattended/API-created suitcases where no choice was
recorded, fail safe to **No data sync**.

The setup screen may recommend automatic for a personal mirror, manual for controlled/bandwidth-bound
sync, and no data sync for an isolated suitcase, but it records an explicit choice. No data sync is
for intentionally site-local state—not a way to force an incompatible database through the
reconciliation engine.

### Exact policy semantics

- The setting controls application database/files only. Release candidates, fleet configuration,
  application identity, certificates, platform updates, and administrator projection have their own
  synchronization rules.
- Automatic and manual replicas belong to the app's shared data lineage and pin their adopted base
  checkpoint until they advance or are removed.
- A manual replica accumulates a branch summary locally. **Sync now** is bidirectional: exchange the
  current home/replica branches, stage reconciliation, resolve or hold conflicts, publish a verified
  checkpoint, and adopt it on both sites.
- A no-sync replica is not a pending member of the shared data lineage and does not prevent
  checkpoint compaction. It can start empty or from a clearly labelled one-time clone; after that
  fork, neither site's records/files are expected to appear on the other.
- No sync still permits site-local backups. The UI says **Site-local data · never sent home** or
  **Site-local data · backed up locally**, rather than the ambiguous word “current.”
- Stateless replicas effectively have no application data channel; the setting displays **No data
  to sync** instead of asking for a meaningless policy.
- **Follows one site** remains a different topology, not a fourth cadence. It moves one writable
  volume and may automatically or manually copy recovery snapshots. **No data sync** keeps separate
  writable namespaces at multiple sites and promises no convergence.

### Compatibility controls policy availability

The **Suitcase compatibility** panel explains which policies are available and why:

```text
Vacation Suitcase
  Runs on suitcase                 Ready
  Data mechanism                   SQLite replica · conflicts detectable

  Data sync
    ● Automatic sync               Recommended
    ○ Manual sync                  Available
    ○ No data sync                 Site-local data; changes never return home

  Compatibility issues            1 warning
    INTEGER PRIMARY KEY on notes   Concurrent inserts may require resolution
```

If a durable table has no primary key, both automatic and manual reconciliation are disabled because
manual cadence does not repair incompatible semantics. The panel may offer **Follows one site** or
**No data sync** with their exact consequences. A runtime/architecture/security blocker disables all
three policies for that suitcase.

“Suitcase compatibility issues” is therefore a useful problem label, while the normal section title
should be **Suitcase compatibility**. Findings are attached to the affected option: “Automatic and
manual sync unavailable,” “Offline development unavailable,” or “Cannot run on this Pi.”

### Policy transitions

- **Automatic → Manual:** safe immediately; retain the current base and begin accumulating pending
  branch state.
- **Manual → Automatic:** reconcile pending changes first, then begin continuous synchronization.
- **Automatic/Manual → No data sync:** close or archive the current clean lineage position, create a
  site-local namespace, and record the intentional fork.
- **No data sync → Automatic/Manual:** never infer a three-way merge because no maintained shared
  base exists. Require one explicit reset/import choice: replace suitcase data from home, replace
  home from suitcase with protected confirmation, or import the suitcase state as a new app. Preserve
  the displaced state as a backup.
- **Any policy → Follows one site:** coordinate a final checkpoint/snapshot and establish one writer
  before disabling other writable namespaces.

Every policy change is an administrator event. It records the actor, prior/new policy, lineage or
fork checkpoint, affected replicas, and the exact data-loss/convergence consequence shown during
confirmation.

## End-to-end user experience

### 0. Plan a suitcase without a device

The home dashboard provides **Plan a suitcase** before pairing or purchasing hardware:

1. Select the applications to keep portable.
2. Choose whether each app must only run or must also build offline, the expected simultaneous user
   load, the trip-duration/growth horizon, backup retention, and the intended data-sync policy.
3. The home hub analyzes observed application resource peaks, build probes, current data, retained
   artifacts, caches, checkpoints, and growth.
4. The planner returns **Minimum** and **Recommended** RAM, persistent storage, CPU/architecture,
   networking, and device capabilities with confidence and unresolved findings.
5. The administrator chooses any device that meets the result. Before pairing, candidate specs can
   be entered for comparison; after pairing, deploy.local measures the real target and issues the
   final readiness result.

The estimate covers only the selected portable graph, not every application on the home hub. It is
recomputed when app selection, observed load, releases, data growth, retention, or offline-build
requirements change.

### 1. Establish a suitcase target

The Docker MVP path should not require SSH or an operating-system image:

1. Install Docker Engine/Desktop on a macOS, Linux, or Windows target.
2. Run `deploy suitcase target start`; the launcher pulls the matching multi-architecture image,
   creates named volumes/network, and starts it with a restart policy.
3. Connect the target to the home LAN, preferably by Ethernet when available.
4. The home dashboard discovers an unpaired suitcase candidate, or the launcher opens its setup URL.
5. An administrator selects **Pair suitcase**, gives it a name, and confirms the short code shown
   by the device or setup page.
6. Setup requires a default data policy—**Automatic sync**, **Manual sync**, or **No data sync**—and
   configures the security/network capability profile.
7. Home and suitcase create mutually authenticated site identities.
8. The suitcase verifies the compatible deploy.local release and enters **Docked** state.

The same pairing model later applies to native/flashable appliances. deploy.local does not prescribe
one reference device: existing computers, compact x86 systems, and Docker-capable ARM64 boards are
candidate deploy targets whose actual capabilities and calculated capacity determine readiness.

### 2. Make an application portable

The application page exposes one primary control:

> **Keep on suitcase** — Vacation Suitcase

Enabling it starts an orchestrated placement change using the existing retained-source and
managed-volume migration pipeline plus a new replicated-data admission flow:

1. Detect the app's data mode: **Syncs across sites** or **Follows one site**.
2. Inherit the suitcase's explicitly configured data policy, allow an app override, and verify that
   automatic/manual sync is compatible before enabling it.
3. Validate architecture, capacity, custom mounts, privileged requirements, and device health.
4. For sync-capable apps, validate the portability report, SQLite schemas, conflict policies, and
   upload-path classifications.
5. Create the suitcase site replica and initialize its shared or site-local data namespace.
6. Transfer retained source/configuration and build on the suitcase architecture.
7. Materialize referenced uploaded blobs and build artifacts.
8. Start and health-check the suitcase replica without removing the home replica.
9. For automatic/manual sync, verify that both replicas share the initial checkpoint digest.
10. Start the selected reconciliation/change-summary/local-backup behavior.

For a **Follows one site** app, the UI explains that portability requires moving its one writable
opaque volume; the home runtime cannot remain writable. For **Syncs across sites**, both runtimes
stay active and route users to their local replica.

### 3. Understand readiness

Classification and readiness are different:

- **Application class** answers what promises deploy.local can make for the current release and data
  layout: replicated, single-site, adapter-managed, or blocked.
- **Replica readiness** answers whether one specific suitcase has everything necessary right now.

The application page shows four independent capabilities rather than one ambiguous green badge:

- **Runs on suitcase:** compute, architecture, mounts, devices, networking, and health checks pass.
- **Suitcase data ready:** the selected policy is satisfied—automatic is current, manual has no known
  pending changes, no-sync has an initialized acknowledged site-local namespace, or single-site data
  is ready to transfer/backup.
- **Ready to use offline:** runtime, data, identity, secrets, certificates, local routing, recovery
  release, and capacity are materialized.
- **Ready to develop offline:** the current dependency graph has completed a no-network build and
  sufficient build storage remains.

**Ready to go** requires every selected app to be **Ready to use offline** and **Suitcase data ready**
for its selected policy. Development readiness remains separately visible so the UI can say, for
example, “Ready to go · 4/4 apps usable · 3/4 apps development-ready” instead of hiding an uncached
build dependency. A manual app with known pending changes is **Ready to use · Sync required**, not
fully **Ready to go**.

Readiness is computed and evidence-backed, never manually asserted. Each green state is tied to the
exact app release, deploy configuration, reconciliation-profile digest, schema fingerprint, base
checkpoint, suitcase capability set, and analyzer version that was verified. Any material change
invalidates only the affected checks and explains what must be rerun.

### 4. Leave home

No software departure ritual is required.

When moved to a non-home network, the suitcase:

1. recognizes that it is no longer on the paired home network;
2. confirms the home edge presence signal is absent;
3. changes from **Docked** to **Away**;
4. uses the current LAN or user-enabled host hotspot, or starts its configured Wi-Fi access point
   when a validated native host integration is available;
5. provides local name discovery when the host/network supports it and always exposes a concrete
   local access URL;
6. activates its local HTTPS edge and dashboard;
7. advertises `deploy.local`, `discover.local`, and replicated app names with mDNS when that
   capability has passed readiness checks;
8. keeps the same containers and local data projections running;
9. accepts offline authentication and deploys;
10. appends control mutations to its fleet-event journal and application writes to per-app data
    branches rooted at verified checkpoints.

On the remembered home network, loss of the coordinator alone must not automatically activate the
suitcase edge. This avoids duplicate `.local` authorities during a home control-process restart.
The dashboard provides a clearly labelled manual **Operate independently here** override for
recovery.

### 5. Iterate while offline

The CLI remains configured for `https://deploy.local`. On the travel LAN, mDNS resolves that name to
the suitcase, so the normal command remains:

```bash
cd my-app
deploy
```

For a replicated application, the suitcase:

1. authenticates the user against its offline user projection;
2. accepts and retains the source artifact;
3. builds the target-platform image locally, using prewarmed BuildKit layers;
4. activates the release on the local replica and records it as a release candidate for the fleet;
5. starts and health-checks the release;
6. keeps all required artifacts for later synchronization;
7. continues accepting ordinary application database writes and uploaded files locally.

A new application may also be created offline. It receives a globally unique application ID and has
the suitcase as its first replica. Its hostname is an alias, not its identity. If home separately
created the same alias, rejoin keeps both IDs and asks for a rename.

Changing a dependency to one that was never cached cannot be guaranteed without internet access.
The build error should identify offline dependency unavailability rather than implying source or
fleet corruption. A later laptop-builder path can produce `linux/arm64` OCI images and transfer
them to the suitcase, but it cannot conjure an uncached third-party dependency either.

### 6. Continue operating at home

When a suitcase is away:

- all home-only applications continue normally;
- the topology shows the suitcase as **Away** and its last contact/readiness state;
- replicated applications remain active at home and show which suitcase replicas are away;
- each app shows replica bases, pending changesets/blobs, conflicts, and last checkpoint;
- commands for home-only, replicated, and new home applications continue normally;
- deploys and configuration edits execute on the home replica and become candidates for other sites;
- home users continue creating records and uploads locally;
- runtime controls apply only to the local replica while disconnected;
- fleet-wide destructive actions and incompatible schema migrations remain blocked;
- retained history, replica health, and recovery snapshots remain accessible.

#### Build at home while somebody travels

Site replicas and release authorship are site-local while disconnected. Either site may activate
a release locally and offer that immutable release as a candidate for fleet-wide rollout.

For example, while a wife uses the live notes app on the suitcase, somebody at home can still run
`deploy` for notes. Home:

1. records the source/config artifact against the last synchronized suitcase generation;
2. builds it for the suitcase architecture on home compute;
3. deploys it to the active home replica;
4. records the home release as **Waiting for Vacation Suitcase** for cross-site rollout;
5. continues accepting home database writes while its SQLite schema remains compatible;
6. synchronizes the candidate and branch changeset when the suitcase becomes reachable.

The suitcase may independently deploy another release. The CLI states which site-local replica was
updated and which other replicas still run a different release.

Commands are classified explicitly:

| Command class                        | Disconnected multi-site behavior                                      |
| ------------------------------------ | --------------------------------------------------------------------- |
| Source deploy                        | Deploy locally and create a candidate for the other replicas.         |
| Compatible configuration edit        | Apply locally and record it in the site-local release candidate.      |
| New local application                | Execute locally; assign a global ID and reconcile its name later.     |
| Start/stop/restart/terminal/log read | Apply to the site-local replica only.                                 |
| Data record/upload                   | Commit to the local database/files and reconcile from the base later. |
| Delete app/breaking schema migration | Block until required replicas acknowledge or are explicitly removed.  |

On rejoin, SQLite/file changesets and blobs converge independently of the release choice. If both sites
deployed code, the UI compares release lines and their data-schema compatibility before offering a
fleet rollout. Data convergence must never depend on choosing one site's raw volume.

### 7. Rejoin at home

When the suitcase recognizes home again:

1. it enters **Rejoining** but keeps its app replicas running;
2. both sides mutually authenticate and exchange control-event cursors and per-app base checkpoints;
3. each dirty branch produces an immutable SQLite/file changeset from its base;
4. missing uploaded blobs and artifacts transfer resumably by digest;
5. home applies changesets to a staging checkpoint with row/path conflict detection;
6. automatic policies resolve compatible changes and manual conflicts remain explicit;
7. both sides adopt the matching verified merged checkpoint for each replicated app;
8. new apps, configuration, uploads, and records appear across the fleet;
9. release candidates become eligible for compatibility review and fleet rollout;
10. backups and selected aggregates upload according to retention policy;
11. the suitcase disables its local `.local` advertisement;
12. normal docked synchronization resumes and home can reconcile that checkpoint with other suitcases.

Suitcase A and Suitcase B do not need to return together. Home retains the shared base, branch
changesets, merged checkpoints, and blobs: A can return first, then B can reconcile its older branch
when B returns later. Rows and files converge through staged reconciliation; raw managed volumes
never merge.

## Architecture

```text
                                  FLEET

              HOME SITE                      SUITCASE A/B/... SITE
    +-----------------------------+       +--------------------------------+
    | coordinator + exchange hub  |       | portable coordinator + view    |
    | local app replicas          |       | local app replicas             |
    | control event journal       |<----->| control event journal          |
    | checkpoints + changesets    |<----->| checkpoints + changesets       |
    | content-addressed blobs     |<----->| content-addressed blobs        |
    | checkpoints + backups       |<----->| checkpoints + backups          |
    | edge + mDNS                  |       | gated edge + mDNS              |
    +-----------------------------+       +--------------------------------+
                  |                                      |
                  +------- mutually authenticated -------+
                               when docked
```

### Runtime roles

The suitcase is not merely the current execution agent with more cached files. It runs four
cooperating roles:

- **Sync agent:** pairs with home, exchanges control events, SQLite/file changesets, blobs,
  checkpoints, and artifacts, and reports per-replica readiness.
- **Executor:** builds images and owns site-local containers/projections, extending the existing
  agent executor.
- **Portable control:** provides API, dashboard, authorization, deployment admission, and local
  projections without home.
- **Gated edge:** owns HTTPS, routing, WebSockets, TCP proxies, and mDNS only when the site is away
  or explicitly activated.

These roles share one `DEPLOY_DATA_DIR`; the Docker target launches the local control/edge runtime
and an independent sync worker with health-aware restart behavior.

### Implemented code seams

- `deployments.desiredNodeId` and `activeNodeId` already express placement.
- The node job protocol already transfers retained source, backups, progress, logs, and terminal
  sessions.
- The existing move pipeline already preserves the old route until the destination is healthy.
- The edge route table already rebuilds an in-memory graph from SQLite and reacts to route changes.
- The supervisor already keeps edge traffic alive across control-plane restarts.
- The CLI already targets `deploy.local`, supports Linux ARM64, streams artifacts, and upgrades to
  the coordinator build.

Every owned state path uses `DEPLOY_DATA_DIR`, including databases, certificates, recovery content,
portable membership, and managed-volume metadata.

## Identity and storage model

### Stable identities

Offline writes and synchronization use stable IDs:

- `fleet_id`: generated once by home;
- `site_id`: one home site and one per suitcase;
- `node_id`: existing node identity, scoped to the fleet;
- `app_id`: immutable UUID, replacing the application name as distributed identity;
- `event_id`: UUIDv7 or equivalent unique sortable identifier;
- `artifact_digest`: SHA-256 of immutable content.

Application names remain unique aliases in the normal home view and continue powering `.local`
hostnames. Existing rows receive IDs in a migration without changing URLs.

### Implemented schema model

The relational projection implements these conceptual records; additive migrations may continue to
refine physical columns without changing their distributed identities.

#### `fleets`

- `id`, `name`, `created_at`;
- root public identity and protocol version;
- home site ID.

#### `sites`

- `id`, `fleet_id`, `name`, `kind` (`home`, `suitcase`);
- paired public key and credential status;
- platform, architecture, version, capabilities;
- mode (`docked`, `away`, `rejoining`, `recovery`, `revoked`);
- last contact, network fingerprint, readiness summary;
- revocation, replica-removal, and quarantine metadata.

#### `deployments` changes

- add immutable `app_id` and keep `name` as an alias;
- store the desired normalized application-spec digest and active revision ID;
- add release authority/epoch/generation and desired fleet release;
- add data mode (`single-site`, `sqlite-reconcile`, `custom`) and reconciliation profile version;
- add latest source/image/config/snapshot artifact digests;
- distinguish logical application state from site-local runtime state.

#### `application_revisions`

- revision ID, app ID, normalized specification digest, schema/API version, and parent revision;
- origin (`repository`, `ui`, `catalog`, `legacy`, or `offline-site`), actor, origin site, and creation
  time;
- original manifest/source artifact where available and canonical normalized JSON artifact;
- repository commit/ref and declared base digest where available;
- active, candidate, superseded, rejected, or source-converged state;
- semantic diff and the graph-change plan used to validate or materialize the revision.

The normalized artifact is the durable graph definition. Component/resource rows are indexed
projections for runtime and UI queries; deleting or rebuilding those projections must not erase the
application definition or its ancestry.

#### `application_configuration_declarations` and `application_configuration_values`

- stable declaration ID/key, app/spec digest, type, required/default/validation metadata, display
  description, and application/site scope;
- allowed projection as environment variable or mounted file and the consuming component IDs;
- value revision, application/site owner, encrypted secret reference or canonical non-secret value,
  redacted digest/version, and rotation time;
- resolution, validation, expiry, and affected-component restart state.

The manifest owns declarations and wiring, never resolved secret bytes. The configuration digest is
derived from canonical non-secret values plus opaque secret version identifiers; logs, events,
exports, diffs, and support bundles remain redacted.

#### `graph_change_plans`

- plan ID, app ID, base/target revision and specification digests, origin, actor, and expiry;
- ordered create, update, restart, roll, migrate, detach, retain, quarantine, and delete
  operations;
- stable component/resource identity matches based on public logical keys;
- data impact, downtime, capacity, placement, compatibility, backup, and acknowledgement gates;
- validation status, approvals, apply transaction, rollback boundary, and result.

A display-name edit does not change identity. Changing a stable logical key is destructive in public
v1 and plans remove/create. The planner never guesses volume renames from similar paths, images, or
labels.

#### `application_components`

- component ID, app ID, stable name, and role (`web`, `worker`, `proxy`, `scheduler`, `service`,
  `job`);
- image/source/build definition pinned by digest;
- command, health/readiness contract, dependencies, resource limits, and restart policy;
- route/port references rather than globally published service ports;
- platform, architecture, device, privilege, and network requirements.

The current deployment row maps to one `web` component during migration. One-container applications
remain simple in the UI; the graph is revealed only when it adds meaning.

#### `component_placements`, `component_instances`, and `component_services`

- component/site-replica placement, desired instance count, minimum ready count, allowed per-site
  override, spread preference, and capacity admission;
- ephemeral instance ID, component/site/node, active release/config digest, endpoint, lifecycle,
  readiness/liveness, start/drain times, and replacement reason;
- stable private service/interface ID, component selector, port/protocol, affinity policy, and
  current ready/draining endpoint set;
- rollout strategy, maximum unavailable/surge, progress, failure/rollback state, and connection-drain
  deadline.

Component identity and desired count survive instance replacement. Service endpoint membership is a
rebuildable projection of ready instances; it is not distributed application data.

#### `application_resources`

- resource ID, app ID, stable name, and kind (`volume`, `secret`, `route`, `network`, `device`,
  `external-service`);
- desired specification, lifecycle policy, site binding, and capability requirements;
- volume access (`single-writer`, `read-only-many`, or `shared-writers`) and durability
  (`ephemeral`, `rebuildable`, or `durable`), with provider/application evidence for shared writes;
- consistency group, backup, restore, retention, data ownership, and suitcase behavior;
- generated binding names and secret references exposed to dependent components.

PostgreSQL and Redis are ordinary application components attached to volume/secret/network
resources. “Managed” behavior comes from an optional typed lifecycle profile; it never creates a
hidden second runtime primitive. A future cross-application shared-component option requires an
explicit ownership and blast-radius design.

#### `component_lifecycle_profiles`

- component/profile ID, profile type/version, supported image/version range, and capability digest;
- provisioning/default configuration, generated bindings, readiness, backup, restore, upgrade,
  migration, validation, and data-classification contracts;
- implementation provenance, test evidence, target/architecture support, and fallback behavior.

The runtime never branches on “is PostgreSQL?” to start, stop, place, route, log, or inspect a
container. It invokes declared lifecycle capabilities only for operations the component profile
supports.

#### `blueprints` and `blueprint_releases`

- blueprint ID, publisher/trust tier, display metadata, license/trademark notices, and support
  policy;
- release version, application-spec schema version, upstream application version, and support
  status;
- exact OCI digests, architecture manifests, source/provenance/SBOM references, and signature;
- configuration-question schema, generated defaults, upgrade notes, and migration declarations;
- compatibility requirements, security review, test evidence, and deprecation/block reason.

#### `catalog_installations`

- app ID, blueprint/release ID, parameter digest, installed generation, and update channel;
- last successful install/upgrade/backup/restore test evidence;
- managed, detached, or derived status;
- available upgrade, compatibility warnings, and rollback target.

Parameters containing secrets are never stored in the blueprint or installation record. The record
contains references to encrypted generated secrets and a redacted digest for drift detection.

#### `application_bindings` and `application_jobs`

- producer resource/component, consumer component, interface name, and secret/config projection;
- stable private aliases and immutable IDs used for service discovery;
- one-shot init/migration/restore jobs, required base/target version, status, logs, and retry policy;
- execution scope (`per-instance`, `once-per-site`, or `writer-site-only`), lease/lock state, and
  idempotency key;
- rollout gates that prevent traffic or promotion until required jobs and health checks pass.

Ordinary web/worker copies are per-instance. Initialization and compatible migrations are normally
once per site; side-effecting schedulers, billing, outbound mail, and authoritative migrations are
writer-site-only unless the application explicitly accepts duplicated site-local effects.
deploy.local does not claim a fleet-wide exactly-once execution scope while sites can disconnect.

#### `app_replicas`

- app ID, site ID, and replica ID; component placements carry one or more node assignments;
- active/desired release IDs and local runtime status;
- data mode, analyzer/profile version, schema fingerprint, and conflict policy digest;
- per-suitcase data sync policy, shared-lineage membership, site-local namespace/fork checkpoint, and
  last policy-change event;
- base checkpoint, local branch snapshot, pending changeset/blob counts, and conflict count;
- materialization/readiness, last contact, and removal acknowledgement.

An application may have a home replica and any number of suitcase replicas. Placement becomes a
replica-set relationship rather than one `activeNodeId`.

#### `data_reconciliation_profiles`

- app/profile ID and analyzer version;
- managed SQLite files, schema fingerprints, eligible/excluded/rebuildable tables;
- upload/ephemeral/opaque path classifications;
- table/path conflict policies and risk explanations;
- compatibility digest shared by every replica.

#### `data_changesets`

- changeset ID, app ID, origin site, and base checkpoint ID;
- branch snapshot/manifest digest and SQLite schema fingerprint;
- SQLite changeset artifact plus uploaded-file manifest delta;
- merge order, apply status, conflict report, and resulting checkpoint ID;
- signature/authenticated digest and creation/verification times.

Changesets are immutable and idempotent by ID/digest. They are computed from a shared base and a
quiesced branch snapshot, not intercepted from the application's database connection.

#### `data_checkpoints`

- app and checkpoint ID;
- ordered parent checkpoint/merged-changeset lineage;
- SQLite database and filesystem tree artifact digests;
- reconciliation profile/schema fingerprint and verification status;
- acknowledgements/base adoption from every non-revoked replica.

Checkpoints give every replica an exact shared merge base. Historical checkpoints/changesets remain
pinned until all known replicas have advanced beyond them or are explicitly removed.

#### `blob_references`

- app, logical path/identity, immutable content digest, and metadata;
- base/branch manifest lineage, rename/delete markers, and conflict state;
- per-replica materialization/checkpoint state.

Uploaded bytes are immutable and content-addressed. Three-way manifests merge paths; the blob store
deduplicates identical content.

#### `fleet_events`

- `event_id`, `fleet_id`, `origin_site_id`, `origin_sequence`;
- `app_id` where applicable;
- `authority_epoch`, `generation` where applicable;
- actor identity and semantic operation;
- versioned payload and referenced artifact digests;
- parent event/generation where required;
- created-at as informational time;
- signature or authenticated digest;
- applied-at and rejection reason in the local projection.

Unique constraints make replay idempotent. Ordering uses site sequence and application generation,
not timestamps.

#### `artifacts`

- digest, type, byte size, media type, architecture;
- local path and verification state;
- created-by event and retention class;
- last access and pin/materialization references.

Immutable bytes live under a content-addressed directory such as:

```text
.deploy-data/blobs/sha256/ab/abcdef...
```

#### `fleet_recovery_bundles`

- bundle ID, fleet/home identity, format version, creation time, encryption/KDF metadata, and
  verification result;
- control-plane snapshot containing application revisions/spec artifacts, aliases, fleet events,
  catalog installations, policies, site identities, revocations, and sync cursors;
- fleet CA and encrypted secret-store recovery material wrapped for an administrator-controlled
  recovery key;
- artifact, checkpoint, backup, and retention inventory with optional bundled critical artifacts;
- last-known site acknowledgements, authority epochs, generations, and data-lineage boundaries;
- restore rehearsal time/result and replacement-Home adoption status.

The bundle is encrypted, versioned, exportable, and restorable without the failed Home. Large app
backups may remain separate content-addressed artifacts, but the bundle must identify, authenticate,
and locate every required recovery object. A suitcase may reconnect to a restored Home only after
the replacement proves the recovered fleet identity and the suitcase's last-known lineage is
reviewed; raw re-pairing must not silently create a second fleet.

#### `site_sync_cursors`

- local site, remote site, event stream, last accepted sequence;
- transfer attempt and last successful synchronization;
- negotiated protocol version.

#### `artifact_transfers`

- source/destination site, digest, expected size;
- verified byte offset, status, attempts, and error;
- resumable temporary path.

#### `app_materialization`

- app/site/capability (`runtime`, `build`, `backup`);
- desired and available artifact digests/generations;
- health checks and blocking reason;
- computed readiness state and last verification.

#### `release_candidates`

- candidate ID, app ID, origin site, actor, and created time;
- base authority epoch and generation;
- source, image, and configuration artifact digests;
- target architecture and build/site-activation result;
- state (`building`, `active-local`, `waiting`, `ready`, `conflict`, `promoted`, `discarded`);
- optional superseded candidate and promotion event.

Candidates are immutable authored releases. A site may activate one locally; explicit fleet
promotion advances the desired generation after schema/reconciliation compatibility checks.

#### `volume_snapshots`

- snapshot ID, app ID, authority site, and authority epoch;
- monotonic data sequence independent of the application release generation;
- parent snapshot ID and manifest artifact digest;
- consistency mode, logical byte size, unique transferred bytes, and verification state;
- release generation observed when the snapshot was taken;
- created time, latest-home-recovery marker, and retention class.

The manifest describes the complete filesystem tree and references immutable content chunks by
digest. The data sequence orders recovery points without pretending deploy events capture arbitrary
application writes.

### Projection strategy

The existing deploy.local control SQLite database remains each site's operational projection. It is
not copied or merged as application data. Semantic command handlers perform two writes in one local
transaction:

1. append the immutable fleet event;
2. update the site's existing query-friendly deployment/history/build tables.

Portable sync inserts unseen verified events and applies them through the same projectors. This
allows the current dashboard and edge queries to evolve incrementally instead of requiring an
immediate, total event-sourcing rewrite.

Direct store mutations affecting distributed state must gradually move behind a command layer.
High-volume telemetry remains outside the fleet-event log.

## Authority and conflict model

### Separate release and data semantics

Release/configuration state and application data use different consistency models:

- **Release state:** each site may run a local release while offline; one release may be promoted as
  the fleet desired release after compatibility review.
- **Replicated application data:** every active replica may mutate its compatible local SQLite/files;
  replicas converge by three-way changeset reconciliation from shared checkpoints.
- **Opaque managed volumes:** remain single-writer and follow one site through snapshot transfer.
- **Fleet-destructive state:** app deletion, replica removal, checkpoint/event compaction, and
  incompatible schema migration require acknowledgements or an explicit replica-removal decision.

There is no single writable authority for a reconcilable data set. There is an immutable branch
origin/base for every changeset and an adopted-checkpoint record for every replica.

### Candidate releases from any site

A site may accept source, build an image, and activate it on its local replica. That release becomes
a candidate for the other replicas. Promoting it as the desired fleet release remains explicit.

Every candidate records the authority epoch and generation on which it was based. On synchronization:

- unchanged base: candidate becomes **Ready to promote**;
- only unrelated portable events occurred: projector may mark it rebase-safe, but first release
  still asks before promotion;
- source/configuration changed on both sides: candidate becomes **Conflict**;
- authority epoch changed: candidate remains archived and requires a recovery decision;
- candidate promoted for the fleet: assign the next release generation and roll it to connected
  compatible replicas; disconnected replicas retain their local release until rejoin.

Every release declares or is analyzed for its SQLite schema fingerprint/compatibility. deploy.local
blocks a fleet-wide rollout or destructive data migration that would strand an offline replica.
Mixed compatible releases are allowed; incompatible releases require all affected replicas online
or explicitly removed.

### Removing a lost replica

An administrator can remove a lost replica from the app's replica set using its last adopted
checkpoint. This action:

1. clearly states the lost replica's unreceived database/file branch may never be recovered;
2. revokes its site/replica identity;
3. records the last adopted checkpoint and a replica-removal event;
4. removes that replica from checkpoint/tombstone acknowledgement requirements;
5. prevents its later changeset from silently entering the active lineage;
6. preserves them as a quarantined branch if the device eventually returns.

For a single-site opaque-volume app, the existing authority-break/snapshot recovery rules still
apply. There is no automatic filesystem merge.

## Synchronization protocol

### Transport

Use authenticated HTTPS initially, compatible with the existing request model. Large transfers
support range/resume and end-to-end digest verification. A persistent WebSocket or HTTP/2 channel
may later reduce polling and carry forwarded terminal/control traffic, but is not necessary to
prove offline semantics.

Pairing creates site credentials distinct from execution-node credentials. Protocol requests carry
fleet ID, site ID, protocol version, nonce/replay protection, and authenticated body digest.

### Docked synchronization loop

1. Exchange site status, control-event cursors, replica sets, reconciliation profiles, and
   materialization state.
2. Exchange each replica's data sync policy, shared-lineage membership, adopted base checkpoint,
   schema fingerprint, and dirty-branch status.
3. For an automatic dirty compatible branch, create a quiesced snapshot and compute SQLite/file
   changesets from its shared base. For manual policy, update only the pending summary; for no-sync,
   exchange no application data.
4. Transfer changeset, manifest, missing blobs, checkpoints, and artifacts with resume and digest
   verification.
5. Apply the branch changeset to a staging copy of the current merged checkpoint.
6. Return clean/conflict/constraint/schema/rejected results with a structured conflict report.
7. Resolve or hold conflicts, then run database integrity and application health checks.
8. Publish the new verified merged checkpoint and advance participating replica bases atomically.
9. Recompute convergence, runtime/build readiness, and checkpoint retention eligibility.
10. Send backups and selected telemetry according to policy.
11. Exchange release candidates and their referenced artifacts.
12. Publish a compact topology/readiness update to the dashboard.

The loop is safe to restart at every step. A cursor advances only after durable event and artifact
verification.

### Rejoin rules

- Duplicate event/changeset/digest: acknowledge without reapplying.
- Missing base checkpoint: request/preserve the required lineage before merging.
- Compatible SQLite changeset: apply to staging with the official conflict callback.
- Concurrent non-conflicting row/file changes: include both in the merged checkpoint.
- Concurrent conflicting changes: preserve both branch values/content and surface the policy result
  or manual conflict.
- Delete/update concurrency: follow the configured table/path policy; never infer from absence.
- Referenced missing blob: defer checkpoint publication until the digest verifies locally.
- New replica: seed from the latest verified checkpoint.
- Unknown new app ID with free alias: create projection.
- Unknown new app ID with occupied alias: import as pending rename.
- Candidate with unchanged base: mark ready for explicit promotion.
- Candidate with divergent source/configuration base: preserve both and require comparison.
- Operation from a removed/revoked replica: quarantine and require recovery review.
- Invalid signature/hash/protocol: quarantine and show a security error.

## Artifact model

### Artifact types

- deploy.local release bundle;
- CLI/platform binary;
- retained application source;
- OCI image or build result metadata;
- signed catalog blueprint and normalized application specification;
- managed-volume snapshot;
- database logical export, physical recovery artifact, and migration result;
- build cache metadata;
- certificate chain and site identity envelope;
- optional export/support bundle.

## Curated one-click applications and service graphs

### Product boundary

A one-click application is a curated, versioned blueprint that deploy.local knows how to install,
configure, operate, back up, restore, upgrade, and remove. The upstream project does not need to
build against deploy.local. deploy.local supports the packaging recipe and its tested version—not
the upstream application's entire feature set or every configuration users may construct inside it.

This must not become a second deployment system. A catalog install, a source-built project, a legacy
project, and an approved Compose import all produce the same normalized application graph:

```text
deploy.yaml   catalog blueprint   legacy deploy.json   reviewed Compose subset
      \               |                  |                      /
       +--------------+------------------+---------------------+
                              |
                              v
                 normalized ApplicationSpec
                              |
              canonical JSON + immutable digest
                              |
       +----------------------+------------------------+
       |                      |                        |
 graph change plan      indexed DB projection   spec artifact replication
       |                                               |
       +--> placement + runtime + backup + suitcase classification
```

The current runtime's one deployment → one application container relationship therefore needs to
become one application → many components/resources. A one-container app remains the zero-complexity
case; users should not see graph terminology unless there is an actual dependency to understand.

### Public durable application graph

`deploy.yaml` is the human-authored, portable representation of an application. It is a first-class
product contract, not an import format whose meaning survives only in deploy.local's database:

```yaml
apiVersion: deploy.local/v1
kind: Application

metadata:
  name: notes

configuration:
  adminUsername:
    type: string
    required: true
    description: Initial administrator username
  adminPassword:
    type: secret
    required: true
    scope: application
    description: Initial administrator password
  logLevel:
    type: string
    default: info
    allowedValues: [debug, info, warn, error]

components:
  web:
    displayName: Web
    build:
      context: .
    instances: 2
    interfaces:
      http:
        protocol: http
        port: 3000
    health:
      http: /health
    environment:
      ADMIN_USERNAME:
        from: configuration.adminUsername
      ADMIN_PASSWORD:
        from: configuration.adminPassword
      LOG_LEVEL:
        from: configuration.logLevel
      DATABASE_URL:
        from: db.postgres

  db:
    displayName: PostgreSQL
    image: postgres:18@sha256:...
    profile: deploy.local/postgres@1
    interfaces:
      postgres:
        protocol: postgres
        port: 5432
    mounts:
      /var/lib/postgresql/data:
        from: resources.database

resources:
  database:
    type: volume
    access: single-writer
    durability: durable
    dataRole: database

jobs:
  migrate:
    runWith: web
    command: [npm, run, migrate]
    scope: once-per-site
    beforeTraffic: true

routes:
  public:
    hostname: notes.local
    to: web.http
```

The mapping keys (`web`, `db`, `database`, and `public`) are stable logical IDs within the
application graph. `displayName` and other presentation metadata can change without changing
identity. References create typed edges: a route sends traffic to a component interface, a binding
projects configuration or credentials, a mount attaches durable state, and a job creates a
lifecycle gate. Authors do not need to hand-maintain generic `nodes` and `edges` arrays.

Version 1 uses a restricted, deterministic YAML 1.2 profile: reject duplicate and unknown keys,
custom tags, ambiguous scalars, unsafe aliases/merge keys, and invalid references. Repository
projects use `deploy.yaml`; programmatic APIs may submit an equivalent JSON serialization of the v1
schema. If `deploy.yaml` and legacy `deploy.json` both exist, preflight fails with an explicit
migration choice instead of silently selecting one.

Today's unversioned `deploy.json` remains valid compatibility input. Its implicit one application,
one web component, route, and managed volumes compile into `deploy.local/v1`. Existing applications
do not need an immediate repository edit and the UI can export the inferred v1 `deploy.yaml` when an
administrator is ready to adopt it. `deploy.json` does not acquire graph extensions or become a
second versioned public schema.

### Normalization, storage, and identity

The compiler parses and validates the source, resolves schema defaults and typed references, orders
semantically unordered maps, and emits canonical JSON for the normalized `ApplicationSpec`. The
SHA-256 digest of those canonical bytes identifies the specification. YAML comments, indentation,
quoting, and key order do not change application identity; a semantic graph change does.

Both the original source artifact and canonical normalized artifact are retained where available.
The database indexes the graph into application/component/resource tables for fast queries and
stores its desired/active digest, but those projections are not the only surviving definition. The
normalized spec travels to suitcases as a content-addressed release artifact and can recreate the
projection after recovery.

The application specification contains:

- components with stable logical IDs, roles, images/builds, resource budgets, dependencies, health,
  interfaces, scale, and execution semantics;
- non-runnable volumes, secrets, routes, networks, devices, and external dependencies;
- optional lifecycle profiles that add typed provisioning, binding, backup, restore, upgrade, and
  data semantics without changing ordinary component execution;
- declared configuration and bindings that project administrator values, generated credentials, or
  component interfaces into consumers;
- one-shot jobs with explicit execution scope, idempotency, ordering, and rollout gates;
- storage access, durability, ownership, consistency-group, backup, and suitcase data contracts;
- default placement and instance intent, with site-specific runtime overrides stored separately.

Actual secret values, generated credentials, fleet/site identities, live instance IDs, measured
health, placement decisions, per-site scaling overrides, sync cursors, writer leases, checkpoints,
and reconciliation conflicts remain operational state outside the portable manifest.

### Declared configuration and server-side resolution

Every administrator-supplied environment value used by a v1 graph is declared and typed. Supported
initial types include string, secret, boolean, integer/number, URL, enum, and file; declarations may
provide descriptions, validation, defaults for non-secrets, and `application` or `site` scope.
Components consume a declaration explicitly as an environment value or mounted file. Undeclared
arbitrary environment variables are not the normal v1 UI and cannot bypass validation.

The manifest never contains a resolved password, token, generated database credential, or other
secret. deploy.local encrypts values server-side, redacts every read surface, and records only an
opaque value version in revisions/events. Component-to-component bindings such as `db.postgres` use
generated, rotatable credentials without converting them into user-authored configuration.

Resolution is a deployment gate:

- source, images, and build artifacts may prepare before every value exists;
- a component cannot start until all required declarations in its dependency closure resolve and
  validate for that site;
- a required migration or route stays blocked when its consumer is blocked;
- the UI generates a setup form and explains every missing/invalid value instead of reporting a
  generic unhealthy container;
- application-scoped values can be encrypted to selected suitcase identities before departure;
- site-scoped values must resolve separately on every materialized site and participate in that
  site's offline-readiness result.

The specification digest covers declarations and wiring, never values. A separate configuration
digest covers canonical non-secret values and opaque secret version identifiers. Changing a
declaration creates a graph revision; rotating a value creates a configuration revision and only
restarts/re-runs affected components or jobs.

### UI revisions, repository durability, and drift

Every accepted graph is an immutable application revision with a parent digest and origin:
`repository`, `ui`, `catalog`, `legacy`, or `offline-site`. The admin UI edits the same v1 model as
the repository. It may apply a UI-authored revision immediately, but it marks the active revision as
**Not yet in source** and offers:

- **Download complete `deploy.yaml`** for a canonical durable copy;
- **Copy patch** against the declared parent for review and comment-preserving application in the
  repository;
- the normalized semantic diff and materialization plan.

A repository deployment includes the base specification digest it was authored against. If
revision A produced a UI revision B and the repository still submits a change based on A,
deploy.local does not silently erase B. It requires **Rebase**, **Replace active revision**, or
**Cancel**. A later repository revision whose normalized digest equals B clears the drift marker
without restarting the app. Catalog upgrades and offline-site candidates use the same ancestry and
optimistic-concurrency rules rather than separate ownership modes.

### Graph change planning and stable resource identity

Every YAML, UI, catalog, Compose-import, or offline-candidate change passes through one planner
before materialization. The preview classifies and orders configuration-only updates, in-place
changes, component restarts, rolling replacements, new resources, migrations, moves, detach/retain
operations, destructive removals, and unsupported transitions. It also reports capacity, downtime,
data, backup, suitcase, and compatibility effects.

Logical mapping keys are identity, not labels. Renaming `displayName` is safe. Changing `database`
to `postgres-data` means remove/create unless the revision carries an explicit, validated move from
the old resource ID to the new ID. The planner must never infer a volume move because mount paths,
image names, sizes, or content look similar. Destructive or authority-changing operations require a
verified recovery point and explicit confirmation; failure rolls back to the last committed graph
or quarantines newly created data for an administrator decision.

### Execution and volume access semantics

Graph shape alone cannot determine how often side effects should run. Components/jobs declare one
of three initial execution scopes:

- `per-instance`: each desired runtime copy executes independently; normal web/worker default;
- `once-per-site`: one leased execution for each site replica; normal init/local maintenance scope;
- `writer-site-only`: execute only at the current authoritative data-writer site; normal default for
  billing, outbound email, external webhooks, and authoritative migrations.

There is deliberately no fleet-wide exactly-once scope while sites may be disconnected. A blueprint
that allows duplicate site-local effects must say so explicitly and the UI must show that risk.

Volumes separately declare access and durability. `single-writer` permits one writable attachment;
`read-only-many` permits multiple readers; `shared-writers` requires an application/provider
contract that deploy.local has validated. `ephemeral` data may disappear, `rebuildable` data may be
recreated from a declared source, and `durable` data participates in backup, deletion, and suitcase
policy. Writable SQLite is `single-writer` by default even if several stateless web instances share
other resources. Backups and migrations operate on declared consistency groups, not whichever
container happens to be selected.

Use stable internal service names and generated credentials. An application receives a secret-backed
`DATABASE_URL`; the catalog never stores a literal database password, and the database port is not
published unless an administrator explicitly approves it.

### Same-site component scaling and load balancing

A real application graph may run more than one instance of a component inside one site. This is
different from creating a site replica on a suitcase:

- a **component instance** is one replaceable process/container of the same component release and
  site-local data namespace;
- a **site replica** is the complete application graph plus its data namespace at Home or a
  suitcase.

The common scaled shape is:

```text
                                     +--> web instance A --+
users --> deploy.local edge/pool ----|                     |--> PostgreSQL --> database volume
                                     +--> web instance B --+
```

If an application actually requires Nginx for app-specific caching, headers, static assets, or
routing, Nginx is an explicit component rather than an invisible deploy.local convention:

```text
users --> deploy.local edge --> nginx --> web ×2 --> PostgreSQL ×1 --> database volume
```

Do not require every scaled app to ship Nginx merely for load balancing. The deploy.local edge
should normally route to the healthy endpoint set for a public component. A blueprint includes an
Nginx component only when its behavior is part of the application contract; it connects to a stable
internal service endpoint rather than embedding ephemeral container addresses.

The v1 `deploy.yaml` declaration above is the representative public shape. Its required runtime
semantics are:

- every component has a stable identity and desired instance count; every instance gets an
  ephemeral ID, site, node, release/config digest, readiness, and drain state;
- the route targets a stable component service, not one container port;
- only ready instances receive new HTTP/WebSocket connections;
- instance removal first withdraws it from discovery, then drains in-flight connections before a
  bounded shutdown;
- fixed/manual instance counts ship first; autoscaling is later and must remain inside declared
  capacity and minimum/maximum bounds;
- site-local overrides may run two web instances at Home and one on a smaller suitcase when the
  component declares that topology safe;
- metrics/logs aggregate at application and component level while preserving instance drill-down;
- backups include the shared database/files once, not once per stateless instance.

#### Rolling releases and shared state

A release updates the component group, not each instance as an independent release. A health-gated
rolling update may start a new instance, admit it to the pool, drain an old instance, and continue
until the desired count is on the new digest. The blueprint/project declares one of:

- **Rolling:** old and new component versions may overlap, including their shared database schema;
- **Recreate:** stop old instances, run the migration, then start the new group;
- **Maintenance:** withdraw public traffic for an explicitly incompatible data transition.

Database migrations run once as a versioned job with a fleet/site lock—not once in every web
instance. A rolling release is admitted only when the migration contract says the intermediate
schema works with both releases. Failed readiness leaves the old pool serving and never advances the
active release.

Multiple instances also force an application-session declaration. The application must use shared
database/broker sessions, be stateless, or request explicit affinity. Cookie/client affinity may be
supported for compatibility but is not presented as failover or data safety. Long-lived WebSocket
connections drain rather than migrate.

SQLite is generally incompatible with multiple writable app instances unless the application owns
safe serialization and shared-storage semantics. The graph classifier must block `instances > 1`
for an ordinary writable SQLite volume; PostgreSQL is the representative shared database for this
shape.

#### Placement and failure-domain truthfulness

Two instances do not automatically mean highly available:

| Materialization                                     | Honest claim                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| web ×2 on one node, PostgreSQL ×1 on that node      | Process/rolling-update redundancy; node and database remain single failure points. |
| web ×2 spread across nodes, PostgreSQL ×1           | Web node-failure tolerance; database node/storage remains a single failure point.  |
| nginx ×1 in front of web ×2, PostgreSQL ×1          | Web instances are redundant; Nginx and database remain single failure points.      |
| web ×2 plus a later profiled PostgreSQL HA topology | Claim only the exact node/storage/failover behavior that has been tested.          |

The admin graph shows `2/2 ready`, node spread, and single-instance bottlenecks separately. A
placement preference such as **Spread across nodes** is satisfied only when the site has compatible
nodes; otherwise preflight explains that the app can run with process redundancy but not node
redundancy.

Node-local application graphs use private Docker networking. Cross-node component/service placement
requires a site-private authenticated service endpoint and discovery layer. Until that path is
implemented and verified, admission keeps a privately connected dependency closure on one node
rather than publishing PostgreSQL or broker ports to the LAN. The existing edge route table maps one
application to one backend host/port; it must evolve into route → component service → healthy
instance endpoint set with health, selection, affinity, and draining state.

#### Interaction with suitcases

Same-site scaling does not change cross-site data semantics. Home may materialize `web ×2 +
PostgreSQL ×1`, while a suitcase materializes `web ×1 + PostgreSQL ×1`; these are two site replicas
with separate database authority/lineage rules. They must never point across a disconnected boundary
at one supposedly shared database.

Capacity planning includes the chosen instance counts, rollout surge, connection pools, proxy,
database, jobs, and backup/helper overlap per site. **Keep on suitcase** evaluates the entire graph;
the data classifier still decides whether its PostgreSQL-backed site replica is **Follows one site**,
**No data sync**, or adapter-managed.

### Blueprint contract

Every supported catalog release contains:

- human metadata, upstream link, license/trademark notices, and deploy.local support scope;
- exact upstream versions and OCI image digests—never a silently moving `latest` tag;
- architecture/platform, minimum resource, storage, network, device, and privilege requirements;
- a typed question schema for required install choices and safe defaults;
- components, resources, bindings, secrets, routes, and health/readiness checks;
- component count bounds, site overrides, placement spread, rollout/schema compatibility, session,
  affinity, and connection-drain behavior;
- initialization and versioned migration/upgrade jobs;
- backup/restore contracts and a tested rollback boundary;
- suitcase/offline declarations backed by classifier evidence rather than author assertion;
- signed provenance, SBOM references where available, and security-review metadata;
- supported-from/to upgrade paths, end-of-support state, and blocking advisories.

Blueprints should remain small declarative packages plus test fixtures. deploy.local should not fork
or redistribute an upstream application's source merely to list it. A catalog release can be
deprecated while an installed application keeps running; a remotely blocked release is reserved for
known severe security or data-loss conditions and must show a precise reason.

### Trust and support tiers

Catalog origin and operational compatibility are different axes:

| Tier                       | Promise                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| **deploy.local supported** | Maintained recipe, pinned releases, compatibility CI, documented support window, and tested lifecycle. |
| **Community**              | Signed publisher identity and visible test evidence; best-effort recipe support.                       |
| **Local/private**          | User-owned blueprint; no external support promise, but the same preflight and security preview.        |

“Supported” is always scoped to an exact blueprint release, deploy.local version range, platform,
architecture, and declared configuration. The app page links to the upstream support policy and
does not imply that deploy.local is the upstream vendor.

### One-click install and lifecycle

The guided flow is:

1. Browse or search the catalog and select an application release.
2. Choose its initial site and answer the minimum typed configuration questions.
3. Preflight the entire graph against architecture, capacity, ports, storage, devices, network mode,
   privileges, offline dependencies, and conflicting resources.
4. Preview exactly what will run, what can access the host/LAN, what data will persist, which ports
   become public, and what backup/suitcase promises apply.
5. Generate scoped secrets, fetch artifacts by digest, create private networks/volumes, start
   dependency components in graph order, invoke supported lifecycle-profile operations, run
   init/migration jobs, start traffic-serving components, and admit traffic only after health passes.
6. Commit the installation record only after the graph is healthy. On failure, roll back runtime and
   configuration while retaining or quarantining created data for an explicit retry/delete choice.
7. Land on the normal Application page. From this point it uses ordinary placement, logs, terminal,
   backup, upgrade, capacity, and **Keep on suitcase** controls.

Upgrades use the same transaction: preflight target compatibility, create a verified recovery point,
run declared migration jobs, replace components, validate health, and either commit or roll back
within the blueprint's declared data-compatibility boundary. Updates are announced; never mutate an
installed graph merely because an upstream tag moved.

If an administrator changes fields outside the blueprint's supported customization surface, offer
two explicit choices:

- **Derive local blueprint** to retain the graph and own future updates;
- **Detach from catalog** to preserve the current normalized spec without curated upgrades.

Do not silently overwrite drift or permanently disable upgrades after an innocuous supported change.

### Compatibility is a matrix, not one badge

The catalog and application page report these promises separately:

| Promise                     | Meaning                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| **Install supported**       | This blueprint release passed its install and health contract.                                 |
| **Lifecycle supported**     | Its declared upgrade, backup, restore, and uninstall paths passed.                             |
| **Runs on this target**     | The selected node satisfies runtime, architecture, network, device, and capacity requirements. |
| **Works offline**           | Required runtime artifacts and local dependencies exist without internet/home.                 |
| **Can be kept on suitcase** | The complete dependency graph can be placed on that suitcase.                                  |
| **Data can reconcile**      | Its durable state has a safe shared-lineage reconciliation mechanism.                          |

This prevents a green “Home Assistant supported” badge from implying that Bluetooth works on every
target or that two disconnected Home Assistant instances can safely merge state. The capacity
planner includes every selected component—including profiled service components—helper overlap,
image, backup, and data growth contributor.

### PostgreSQL lifecycle profile

PostgreSQL is the representative complex dependency. Its image runs through the same component
executor, placement, health-event, logs, metrics, scaling, and stop/start paths as any other
container. The first supported PostgreSQL lifecycle profile adds operations around that component:

The application graph renders it with the same component node primitive as Nginx or `web`, placed in
the service/state lane because of its declared role. A **Managed PostgreSQL** badge and actions such
as **Back up**, **Restore**, or **Upgrade major version** come from the profile. An unprofiled image
uses the same node without those promises/actions. This is semantic capability discovery, not a
database-specific graph branch.

- creates a per-application PostgreSQL component pinned to a supported major version;
- uses a durable managed volume and a private application network;
- generates separate application, migration, and backup credentials with minimum required access;
- projects connection details into consumers through secret-backed bindings;
- defines health/readiness checks, CPU/RAM/storage budgets, and a disk-free admission floor;
- runs schema migrations as explicit one-shot jobs before traffic or promotion;
- creates portable logical exports with `pg_dump`/`pg_restore` and verifies restores;
- may later add physical backups plus WAL/PITR for faster same-major recovery;
- treats a major-version upgrade as an explicit tested workflow, never a container-image swap.

PostgreSQL's documentation distinguishes portable, internally consistent logical dumps from
version-specific file-level/WAL recovery. Logical dumps can generally load into newer PostgreSQL
versions and across architectures, while log shipping expects compatible primary/standby servers
and major versions. That makes logical export the baseline portability artifact and physical/WAL
recovery a separate optimization, not interchangeable backup labels. See the official
[SQL dump guidance](https://www.postgresql.org/docs/current/backup-dump.html) and
[warm-standby requirements](https://www.postgresql.org/docs/current/warm-standby.html).

Initially, a profiled service component is owned by one application. Sharing one PostgreSQL cluster among
unrelated apps would complicate placement, independent restores, version upgrades, capacity,
security, and suitcase data authority. Shared clusters can be a later explicit cross-application
ownership model with database-level tenancy and blast-radius UX; they should not appear accidentally
through a hostname.

The lifecycle-profile interface should describe capabilities—provision, bind, health, back up,
restore, upgrade, place, and classify—not assume every SQL engine behaves like PostgreSQL. MySQL or
MariaDB, Redis in durable or cache-only mode, and other dependencies receive separate providers and
backup/version contracts later. “Runs an image” is insufficient for calling a dependency managed.

If a project supplies a PostgreSQL image without the supported profile, deploy.local still runs it
as an ordinary component, attaches declared volumes/secrets/routes, checks its generic health, and
can take opaque recovery snapshots. The UI labels it **Unmanaged PostgreSQL** and does not promise
logical backup, verified restore, credential provisioning, major upgrades, or suitcase data
classification. A local/custom profile may add those capabilities without changing the graph type.

Allow an **External service binding** for an administrator-provided database or API. deploy.local
validates connectivity and projects its secret but does not claim to provision, back up, restore, or
upgrade that service. The dependency remains visible in the graph and usually blocks offline or
suitcase readiness unless a proven site-local equivalent and data transition contract exist.

### PostgreSQL and disconnected suitcases

Installing and backing up PostgreSQL does not make it generically reconcilable. PostgreSQL streaming
replication sends one primary's WAL to standbys; promotion creates a new timeline. It does not merge
two independently writable databases after home and suitcase have both diverged. Automatic versus
manual timing cannot make that topology safe.

PostgreSQL-backed applications therefore receive one of these explicit data modes:

| Mode                               | Disconnected behavior                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Follows one site**               | Quiesce and transfer the verified database/export; only the selected site is writable.         |
| **No data sync**                   | Initialize an independent database at each selected site; namespaces never auto-converge.      |
| **Connected standby** (later)      | Maintain a read-only standby while connected; it is not a writable offline replica.            |
| **Adapter-managed reconciliation** | Permit multiple writers only when an app-specific adapter owns semantic diff/merge/validation. |

The generic suitability classifier must inspect the whole graph. An otherwise stateless web
component with a PostgreSQL component and database volume is not a stateless application. A catalog author may describe
the dependency and recommend a mode, but only runtime/data evidence can issue readiness.

### Home Assistant as a capability stress case

The first Home Assistant blueprint should deliberately support **Home Assistant Container**, not
pretend to provide Home Assistant OS, Supervisor, or its app/add-on store. Current upstream
instructions state that the Container installation lacks Home Assistant apps, requires Docker
Engine rather than Docker Desktop, uses host networking and privileged mode, persists `/config`,
optionally mounts D-Bus for Bluetooth, and maps devices for integrations such as Zigbee. See the
official [Home Assistant Container installation](https://www.home-assistant.io/installation/linux).

That yields an honest blueprint contract:

- Linux Docker Engine target only for the supported release;
- host-network and privileged-access warning before installation;
- managed `/config` storage;
- optional D-Bus, Bluetooth, USB/Zigbee/Z-Wave device bindings shown as target-specific choices;
- port `8123` and local discovery checks;
- explicit “Home Assistant Container—no Supervisor apps” product copy;
- architecture support derived from the pinned image manifest and tested target matrix.

Home Assistant is also site-bound: its usefulness depends on the LAN and physical radios/devices it
controls. Its installation can be fully supported while its suitcase status is **Follows one site**
or **No data sync**. Moving a home-automation instance and its radio to a suitcase may be useful;
claiming generic writable home+suitcase convergence is not.

### Docker Compose import

The [Compose Specification](https://compose-spec.io/) is a valuable developer-facing description of
multi-container applications, so deploy.local should offer **Import Compose** as an onboarding tool
for a strict supported subset. The import produces a reviewable normalized `ApplicationSpec` and a
report of ignored, translated, and blocking fields. It is not retained as the runtime source of
truth.

Initial supported fields can cover images/builds, commands, environment references, named volumes,
ports, health checks, dependencies, resource limits, and private networks. Host mounts, host
networking, devices, privilege, Docker socket access, external networks/secrets, and ambiguous
interpolation require an explicit review or block. Full Compose compatibility is not a one-click
catalog promise.

### Catalog maintenance and first validation set

The support burden is primarily lifecycle testing, not writing YAML. For every maintained release,
automation should detect upstream versions and advisories, resolve/pin digests, then test on every
claimed architecture:

- fresh install and configuration validation;
- restart, node reboot, and interrupted install recovery;
- backup, destructive test mutation, restore, and restore health;
- supported previous-version upgrade and rollback boundary;
- uninstall with separate retain/delete-data paths;
- privilege/network/device policy and suitcase classifier output;
- offline start using only materialized artifacts.

The initial catalog should be selected by archetype and supportability, not popularity alone:

| Candidate                        | Why it is useful                                                                                         | Initial stance                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Uptime Kuma**                  | Simple public web component plus one durable local volume; tests the smallest useful recipe.             | Strong first public candidate. Keep Docker-socket monitoring as a separate elevated option; remote monitors may be unavailable offline.                          |
| **Home Assistant Container**     | Exercises LAN discovery, host networking, privilege, USB/radios, and site-bound behavior.                | Validation and Linux-only candidate after exact host/device tests; **Follows one site** or no sync.                                                              |
| **Paperless-ngx**                | Exercises document ingestion/OCR, PostgreSQL, a Redis-compatible broker, and several durable file roles. | Strong lifecycle-profile candidate; app export/restore can complement generic backups, while database plus documents remain one-site/no-sync without an adapter. |
| **Immich**                       | Exercises web/worker/ML/PostgreSQL/cache, large files, architecture, and meaningful capacity planning.   | Later stress candidate, not an initial support promise; its resource and upgrade surface is intentionally demanding.                                             |
| **deploy.local service fixture** | Proves web + worker + migration + PostgreSQL behavior without inheriting an upstream support schedule.   | Required engineering fixture before any complex public recipe.                                                                                                   |

These are candidates, not approved catalog entries. Current upstream material supports the
archetype choices: [Uptime Kuma](https://github.com/louislam/uptime-kuma) documents a single
container with `/app/data`; [Paperless-ngx](https://docs.paperless-ngx.com/setup/) recommends
PostgreSQL for new installations and combines it with a Redis-compatible broker plus data, media,
consume, and export paths; and [Immich](https://docs.immich.app/install/requirements/) documents a
multi-service, storage- and memory-sensitive deployment. Paperless-ngx also provides an
[application-level document exporter/importer](https://docs.paperless-ngx.com/administration/),
which makes it a useful test of blueprint-specific backup semantics alongside generic volume
recovery and the PostgreSQL profile's logical backup/restore. Its documented exports are
version-sensitive, so the blueprint must retain the matching application image for restore and test
any cross-version migration; it must also classify broker state as rebuildable or durable from
evidence rather than assumption. Exact supported versions, tags, architectures, and requirements
must still be resolved and pinned by each catalog release.

A candidate graduates to deploy.local-supported only when it has an unambiguous license and
distribution path, immutable artifacts, deterministic initial configuration, defined durable data,
health checks, supported architecture/target evidence, a repeatable backup/restore path, testable
upgrades, and a maintainer/support window. Popular applications that fail those criteria remain
local blueprints or Compose imports until the gaps close.

Phase 0 should validate three deliberately different blueprints before promising a public catalog:

1. a simple one-container app with a managed volume;
2. Home Assistant Container as the host-network/device/privilege case;
3. a representative web + worker + migration + PostgreSQL fixture as the service-graph case.

The third can be a deploy.local-owned test fixture rather than prematurely committing to a specific
upstream product. The gate is proving the contract, lifecycle, and honest compatibility matrix—not
maximizing catalog size.

## Suitcase application classification

### Classify capability first, readiness second

A classifier must not answer only “portable: yes/no.” It produces three related results:

1. a release-scoped **data mechanism** describing how the application's durable state can travel and
   reconcile;
2. a release-plus-target **eligibility vector** describing which behaviors are possible on one
   suitcase's actual hardware/runtime;
3. a site-scoped **readiness certificate** proving that a particular replica is currently
   materialized for those behaviors.

An application can therefore be “SQLite replica capable” but still “syncing 2.1 GB of uploads,” or
“ready to use offline” but “not development-ready because a base image is missing.” Product copy
must preserve those distinctions.

The data mechanism is intrinsic to the release/profile. Eligibility is target-specific: the same
SQLite replica may run on one suitcase and be blocked on another target that lacks its architecture,
memory, or device. Readiness is more specific still—it describes one materialized replica at one
point in the fleet lineage.

### User-facing application classes

| Class                       | What deploy.local has established                                                                      | Disconnected behavior                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **Stateless replica**       | The container is write-confined, durable managed volumes are mounted read-only, and validation passes. | Run independently at every selected site; only releases/configuration synchronize. |
| **File replica**            | All durable state is in classified managed file paths with deterministic three-way/keep-both behavior. | Accept files locally and reconcile path manifests/blobs.                           |
| **SQLite replica**          | Every durable database/table is covered by a compatible SQLite reconciliation profile.                 | Accept rows/files locally and reconcile from a shared checkpoint.                  |
| **Adapter-managed replica** | A versioned custom adapter owns snapshot, diff, apply, validate, and conflict semantics.               | Follow the adapter contract and retain generic recovery snapshots.                 |
| **Follows one site**        | The runtime is portable, but some durable state is opaque or cannot be reconciled generically.         | Move the one writable runtime/volume; other sites retain recovery snapshots only.  |
| **Not suitcase compatible** | A hard runtime, hardware, security, or offline dependency cannot be satisfied on the target suitcase.  | Do not offer **Keep on suitcase** for that target; show remediation.               |

The first four classes may display **Syncs across sites** when their runtime and dependency checks
also pass. **Follows one site** is a useful fallback, not an error. A class always names its
mechanism—“SQLite replica”—so users can understand why deploy.local believes it.

For **Follows one site**, **Suitcase data ready** means **Ready to transfer/backup**, not
multi-site sync. The UI must not reuse “sync” for a one-writer snapshot copy.

### Capability vector: never a numeric score

Each dimension returns `pass`, `conditional`, `block`, or `unknown`. The overall promise is the
weakest required dimension; deploy.local must never average a hard blocker into an “87% ready”
score.

| Dimension            | Question                                                                      | Examples of a hard block for multi-site sync                                                                   |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Compute              | Can this release execute on this suitcase?                                    | Wrong architecture without a build path, required GPU/device absent, insufficient hard resource floor.         |
| Runtime containment  | Are durable side effects confined to managed state?                           | Writable host bind mount, Docker socket side effects, persistent writes in the container layer.                |
| Checkpointability    | Can deploy.local freeze one internally consistent branch base?                | Cross-volume/database state without atomic snapshot or quiesce behavior; externally committed side effects.    |
| Data coverage        | Can every durable mutation be represented, validated, or explicitly excluded? | Table without a usable primary key, encrypted/unknown database, mutable special file, unclassified new path.   |
| Conflict safety      | Can overlap be detected without dropping either branch?                       | An adapter/policy that overwrites ambiguous state or an excluded table that actually contains durable records. |
| Offline dependencies | Can users exercise the promised app behavior without home/internet?           | Required remote database, SaaS login, license check, or uncarried local service.                               |
| Identity and secrets | Can the replica authenticate and decrypt what it needs?                       | Missing site-encrypted secret, non-portable hardware key, expired delegated identity.                          |
| Materialization      | Does this suitcase possess every required immutable byte and checkpoint?      | Missing image layer, source, current database base, referenced upload, certificate, or rollback release.       |
| Buildability         | Can the current dependency graph rebuild without a network fetch?             | Missing base image/package layer, unsupported native toolchain, inadequate build storage.                      |
| Verification         | Has the exact release/profile combination passed real validation?             | Stale evidence, failed health/reconciliation probe, changed schema or deploy configuration.                    |

`unknown` fails closed for the affected promise. For example, an unknown data format blocks **Syncs
across sites** but may still allow **Follows one site**. A missing build dependency blocks **Ready to
develop offline** but does not take a healthy runtime offline.

### Evidence and trust model

Every finding records where its evidence came from:

- **Observed:** filesystem inventory, image metadata, Docker inspection, schema introspection,
  network trace, open-file/rootfs diff, or resource measurement.
- **Declared:** an optional `deploy.yaml` classification such as “cache is ephemeral” or “this
  service is optional offline.” Declarations narrow intent but do not override contradictory
  observation.
- **Validated:** a no-network build, suitcase health probe, quiesced snapshot, trial diff/apply,
  integrity check, or restore test succeeded.
- **Enforced:** the runtime makes the claim true, for example a read-only root filesystem, tmpfs
  scratch paths, read-only stateless volumes, denied undeclared mounts, or scoped network policy.

Enforced and validated evidence is stronger than naming heuristics. A file named `cache.db` is not
ephemeral because of its name; a UUID-looking column is not proven collision-resistant merely
because it is called `id`. Heuristics may lower or raise predicted conflict frequency, but never
silently convert uncertainty into safety.

Evidence is scoped to all inputs that could change the conclusion:

- application/release and image digest;
- normalized `ApplicationSpec` and configuration digests;
- target site capability digest;
- volume-tree and schema fingerprints;
- reconciliation-profile and analyzer versions;
- offline probe/build proof;
- base checkpoint and referenced-blob set.

### Classification pipeline

The classifier operates on a temporary replica and immutable snapshots, not the live volume:

1. **Freeze inputs:** resolve the exact release, image/source, configuration, mounts, secrets,
   desired target site, and current managed-volume snapshot.
2. **Admit compute:** inspect platform/architecture, image manifest or build path, CPU/memory/disk,
   GPU/devices, privileged mode, ports, Docker arguments, and networks.
3. **Prove state containment:** run the candidate with a read-only container root, explicit tmpfs
   scratch paths, and only managed durable mounts writable; run health and representative probes.
4. **Inventory state:** enumerate every managed path, recognize SQLite/WAL/journal sets, classify
   ordinary files, detect special/opaque content, and fingerprint schemas.
5. **Build the data profile:** assign every database table and file path a durable, site-local,
   derived, immutable, upload, or blocked role; reject gaps.
6. **Exercise reconciliation:** fork a checkpoint into temporary home/suitcase branches, make
   representative inserts/updates/deletes/uploads where possible, apply the changes to staging, and
   run database plus application validation.
7. **Exercise offline operation:** deny home/internet access, restore projected identity/secrets,
   route a synthetic request through the suitcase edge, and record required outbound dependencies.
8. **Exercise offline build:** rebuild the exact current dependency graph without network access and
   health-check the output.
9. **Issue the report:** persist structured findings, remediations, class, capability vector, and
   evidence digests.
10. **Seed the replica:** create/adopt a shared base checkpoint, transfer every required artifact and
    blob, verify them locally, and issue the site-specific readiness certificate.

Steps 1–7 decide whether the application can safely run and synchronize. Step 8 decides the separate
development promise. Step 10 decides whether a specific suitcase is ready now.

### Runtime and state-containment rules

The existing `/app/data` and `/app/uploads` mounts are the default durable boundary, but their
existence alone is not proof. The classifier must account for all other ways an app can create state:

- **Container root filesystem:** validate with a read-only root; provide tmpfs for declared scratch
  paths such as `/tmp` and `/run`. A secondary container diff reports attempted/observed writes, but
  observation without enforcement is insufficient for a permanent guarantee.
- **Managed volumes:** writable only under a complete data profile. An empty volume is **Needs
  initialization**, not automatically stateless, unless the production runtime enforces those mounts
  read-only.
- **Custom read-only mounts:** allowed only when equivalent immutable content is materialized on the
  target or the app is verified to tolerate its absence.
- **Custom writable mounts:** block generic multi-site sync until deploy.local manages and analyzes
  them. They may permit **Follows one site** if the target path/device is present.
- **Docker socket/privileged side effects:** treat as external mutable state. `privilegedDocker`, a
  Docker-socket mount, host PID/network namespaces, or arbitrary device writes block generic sync
  unless a specific adapter proves containment.
- **Named Docker networks and local services:** follow the dependency edge. Every required local app
  or service must also have a suitcase replica, or the parent app is only conditionally offline.
- **Remote services:** classify required remote databases, OAuth, object storage, APIs, DNS, and
  license checks. Optional integrations may be declared degraded offline; required ones block **Ready
  to use offline**.

This makes the classifier graph-aware. An app is not ready merely because its own container starts;
its required dependency closure must be ready on the same detached site.

Automatic validation proves startup, health, routing, and only the workflows it actually exercises.
It cannot prove that a rarely opened screen has no hidden cloud dependency. The report therefore
states coverage explicitly:

- **Starts offline:** automatic boot, health, authentication, and representative edge request pass;
- **Validated offline workflows:** optional ordinary HTTP/command probes pass with home/internet
  denied;
- **External dependency observed:** destination, evidence, and whether it is required or declared
  optional;
- **Unverified feature coverage:** visible as a limitation, never silently described as “the whole
  app works offline.”

This needs no deploy.local library. A standard health route may be enough for simple apps; additional
probes are declarative or captured from normal test traffic.

### Data-role classification

Every mutable database table and filesystem path receives exactly one role:

| Role                   | Rejoin treatment                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Durable replicated     | Include in changesets/manifests and conflict detection.                                           |
| Site-local ephemeral   | Preserve per site or clear locally; never distribute as shared truth.                             |
| Derived/rebuildable    | Exclude from merge, rebuild deterministically, then validate.                                     |
| Immutable release data | Verify against the release digest; changes are configuration/release drift, not application data. |
| Uploaded content       | Merge immutable blobs and path manifests, keeping both on ambiguous collisions.                   |
| Blocked/unknown        | Stop automatic multi-site reconciliation and retain the branch for review.                        |

An exclusion is safe only when deploy.local also knows what happens when a merged checkpoint is
installed. A `sessions` table may be preserved site-locally or cleared; an FTS table needs a tested
rebuild; immutable seed data must match the release. Merely omitting a table from a changeset is not
enough.

For SQLite, durable-replicated eligibility additionally requires:

- a declared primary key whose columns cannot become NULL;
- compatible table name, column order, primary-key definition, SQLite features, collations, and
  required extensions on every replica;
- no durable virtual table unless it has an excluded base table plus a deterministic rebuild;
- successful `integrity_check`, `foreign_key_check`, changeset apply, and application health probe;
- explicit handling for triggers, generated columns, foreign-key cascades, custom collations/functions,
  attached databases, SQLite system/shadow tables, and cross-database/file invariants;
- schema stability for the entire time any replica may remain away.

Before applying any changeset, the helper preflights every encoded table against the target schema
and treats a missing/incompatible table as fatal. This is stricter than relying on permissive apply
behavior that may skip an incompatible table. Virtual-table shadow tables are never treated as
ordinary durable tables independently of their rebuild policy, and `sqlite_sequence`/autoincrement
state is validated rather than blindly merged.

Key shape predicts—not proves—conflict frequency:

- application-generated random/site-prefixed keys: normally low collision risk after validation;
- natural/composite keys: safe to detect, with intentional same-key conflicts expected;
- integer/autoincrement keys cloned from one base: high collision risk for concurrent inserts and
  therefore **Reconcile with conflicts**;
- mutable primary keys or relationships that would require generic ID remapping: high risk and never
  auto-renumbered.

deploy.local retains both branch records as conflict evidence, but it must not pretend it can insert
both colliding integer IDs into the merged database without understanding and remapping every
reference.

### File-layout classification

File paths receive a predicted conflict mode:

- content-addressed or immutable unique-name paths: low-risk union/deduplication;
- append-only unique paths: union, subject to collision detection;
- mutable well-known paths: supported with explicit keep-both/manual conflict behavior;
- delete/rename-sensitive directory trees: conditional and always three-way from the base;
- cache/temp paths: excluded only with a validated reset/rebuild rule;
- lock files, sockets, FIFOs, devices, escaping symlinks, nested databases, encrypted containers, or
  unknown mutable binary formats: block generic file reconciliation.

A database hidden under `/app/uploads` remains a database; directory names never override content
inspection.

### Structured findings and remediation

The report is a rule-engine result, not prose assembled ad hoc. Every finding has a stable ID,
dimension, severity, evidence, affected promise, and remediation. Examples:

```text
DATA.SQLITE.TABLE_NO_PRIMARY_KEY
  blocks: Automatic sync, Manual sync
  evidence: /app/data/app.db table audit_log
  fix: add a stable non-null primary key, classify the table as rebuildable, or use Follows one site

RUNTIME.CUSTOM_WRITABLE_MOUNT
  blocks: Syncs across sites
  evidence: /srv/photos -> /photos (read-write)
  fix: import it into managed storage, make it read-only and materialize it, or follow one site

OFFLINE.REQUIRED_REMOTE_SERVICE
  blocks: Ready to use offline
  evidence: validation requests postgres.internal:5432 after home/network denial
  fix: replicate the dependency, add an offline mode, or change the promised capability

BUILD.MISSING_LAYER
  blocks: Ready to develop offline
  evidence: no-network build requested node:24 layer sha256:...
  fix: dock and prewarm the current dependency graph
```

The UI groups findings under **Runtime**, **Data**, **Offline dependencies**, **Identity**, **Sync**,
and **Development**, with the most direct available fix. It never asks the user to interpret a raw
SQLite pragma dump.

### Readiness certificate

A green readiness result is a signed/materialized fact record, conceptually:

```text
app + replica + suitcase
release/config/capability digests
application class + data profile digest
schema fingerprints + shared base checkpoint
required and locally verified artifact/blob set
runtime/offline/build validation proofs
identity/certificate/secret envelope versions
disk reserve + evaluator version
issued sequence + latest verified sync sequence
```

For **Automatic sync**, **Suitcase data ready** is true only when:

- the class supports multi-site sync;
- the exact release/profile combination remains valid;
- the suitcase has adopted a retained shared base checkpoint;
- all referenced blobs and conflict/tombstone metadata are local;
- no schema drift, unknown path, unresolved conflict, or incompatible release is pending;
- home has acknowledged the suitcase's latest synchronized branch within the configured freshness
  window.

For **Manual sync**, the same compatibility/profile/base requirements apply, but pending changes are
expected and visible. It becomes fully **Suitcase data ready** for departure only after **Sync now**
publishes and adopts a clean checkpoint; otherwise it is **Ready to use · Manual sync pending**. For
**No data sync**, data readiness instead proves that the site-local namespace and its backup policy
are initialized and that an administrator acknowledged the no-convergence consequence.

Readiness uses checkpoint/sequence state rather than wall-clock time for correctness. The UI still
shows human freshness such as “verified 4 seconds ago.” Continuous docked reconciliation should keep
this green most of the time; a very busy app may briefly show **Catching up**.

When network loss occurs, deploy.local automatically freezes the last mutually verified readiness
certificate as the departure manifest—there is still no departure command. New writes on home and
the suitcase become branches from its retained base. A home release/data change after detachment
does not retroactively make the suitcase unsafe; it changes convergence state from **In sync** to
**Diverged safely**.

### Drift and reclassification

Re-run only affected classifier rules when any of these change:

- active release/image, application-spec digest, or configuration digest;
- runtime settings, custom mounts, devices, networks, environment, or secrets;
- SQLite schema version/fingerprint, database set, or required extension;
- a new mutable file type/path or a path changes assigned role;
- suitcase platform/capacity or deploy.local analyzer version;
- offline build dependency graph;
- dependency-app placement.

While docked, a new unclassified database/path immediately makes automatic/manual sync **Needs
analysis** before the next departure. If drift first appears while away, keep the local app running,
preserve its complete branch snapshot, and pause automatic merge on rejoin. Never discard away data
or silently downgrade it to an old profile. A no-sync replica records the drift locally but does not
pretend that another site will receive it.

## Portable application data

The default path should require no deploy.local SDK. deploy.local inspects the application's managed
volume and produces a **Portability report**. It offers multi-site mode only for content it can
reconcile without silent data loss.

### Volume portability analyzer

The analyzer runs against a quiesced read-only snapshot and inventories every mutable path:

- recognize SQLite databases by file header, include their WAL state in the checkpoint, and run
  integrity checks;
- fingerprint schemas, tables, columns, primary keys, constraints, indexes, triggers, foreign keys,
  virtual tables, and SQLite version/features;
- classify upload directories and other ordinary files using a three-way filesystem merge model;
- detect unknown database formats, sockets, device files, caches, and mutable opaque files;
- compare the result with every existing replica's compatibility report;
- explain exactly which tables/paths prevent multi-site use.

The dashboard reports capability, not a vague Boolean:

```text
Portable data
  SQLite /app/data/app.db          Reconcile with conflicts
    11/11 ordinary tables have declared primary keys
    9 tables use collision-resistant text keys
    2 INTEGER PRIMARY KEY tables may conflict on concurrent insert
    search_index is FTS5            Must exclude/rebuild
    schema fingerprint              Matches all replicas

  /app/uploads                     Safe · keep both on path conflict
  /app/cache                       Excluded · rebuild locally

Result: Ready after confirming 2 table policies
```

Readiness levels:

- **Safe to reconcile:** supported content; conflicts are detectable and no row/file is silently
  ignored.
- **Reconcile with conflicts:** supported, but key/constraint analysis predicts manual conflicts may
  be common.
- **Follows one site:** opaque or unsupported mutable content prevents safe multi-writer operation.

“Safe” means lossless and conflict-detecting, not conflict-free.
Schema inspection proves mechanical coverage: deploy.local can account for every row/file change and
refuse or surface overlaps. It cannot infer application-specific business invariants that are not
expressed as SQLite constraints or health checks. Apps with cross-database, cross-file, or external
side effects may need a stricter rating, annotations, or a custom adapter.

### SQLite reconciliation engine

deploy.local uses the official SQLite Session Extension exposed by the Node 26 runtime in the core
image. Applications keep using their existing SQLite library and schema; deploy.local works from
quiesced immutable database checkpoints and emits the native binary changeset format.

For each period of disconnection:

1. Every replica starts from a shared verified SQLite checkpoint `B` and schema fingerprint.
2. Home and each suitcase independently produce database states `H`, `S1`, `S2`, and so on.
3. On rejoin, deploy.local attaches a session to a private copy of `B` and deterministically applies
   the admitted branch rows, producing a native row-level changeset with old values for every
   compatible table in the reconciliation profile. It replays that binary changeset against another
   copy of `B` and requires an exact row match before declaring the branch captured; a rare valid
   branch that SQLite cannot replay losslessly remains local and is blocked for adapter/manual
   recovery instead of being acknowledged as synchronized.
4. Home applies clean changesets to a staging copy of its current checkpoint through the Session
   Extension. A deterministic three-way preflight records the exact row values before policy or
   administrator-directed conflicts are materialized into that staging checkpoint.
5. Clean inserts/updates/deletes apply; primary-key, before-value, unique/check, not-found, and
   foreign-key conflicts are retained with both versions.
6. Resolved changes are rebased or emitted as a new merged checkpoint lineage.
7. deploy.local runs `integrity_check`, `foreign_key_check`, schema verification, and an app health
   check against the staged database.
8. Only a verified result becomes the new shared checkpoint and is distributed to every replica.

Suitcases do not need to return together. If A merges first, home advances from `B` to `M1`. When B
later returns with a changeset based on `B`, applying it to `M1` detects overlap through the old row
values embedded in the changeset. The verified result becomes `M2` and B receives that checkpoint.

SQLite's session facility only handles tables with declared primary keys, ignores rows with NULL in
any primary-key column, does not support virtual tables, and requires compatible table definitions.
The analyzer must treat those as blockers unless the table is explicitly classified as ephemeral or
rebuildable. The rebase API is experimental, so the first implementation may create and distribute
a complete verified merged checkpoint instead of depending on rebase for correctness.

### SQLite safety rules

Automatic eligibility requires:

- every durable mutable table has a declared non-null primary key;
- all replicas have the same compatible schema fingerprint;
- unsupported virtual/derived tables are excluded only when a deterministic rebuild check exists;
- no unknown mutable database or state file remains in the managed volume;
- constraints and foreign keys pass after staging merge;
- the application passes a health check on the merged checkpoint.

Key analysis predicts conflict risk:

- UUID/random text or other site-unique keys: suitable for independent inserts;
- natural/composite keys: supported, with same-key insert conflicts detected;
- `INTEGER PRIMARY KEY`/autoincrement: supported only as **Reconcile with conflicts** unless
  deploy.local can prove disjoint allocation; cloned replicas may generate the same next ID;
- tables without a primary key or with nullable primary-key rows: unsafe because changes may be
  omitted by the session engine.

Triggers, foreign-key cascades, unique indexes, CHECK constraints, BLOB-heavy rows, and schema
migrations are not automatically rejected, but raise the validation level and must succeed in the
staging apply/integrity tests. A schema change while any replica is away blocks automatic data merge
until release/schema reconciliation is resolved.

Technical basis:

- SQLite's [Session Extension introduction](https://www.sqlite.org/sessionintro.html) documents
  changesets, conflict handling, and rebase behavior.
- The [session module](https://www.sqlite.org/session.html) documents the declared-primary-key and
  virtual-table limitations that drive the analyzer's hard blockers.
- [`sqlite3session_diff()`](https://www.sqlite.org/session/sqlite3session_diff.html) defines the
  compatible-table requirements for checkpoint-to-branch comparison.
- [`sqlite3changeset_apply_v2()`](https://www.sqlite.org/session/sqlite3changeset_apply.html) provides
  the conflict callback and optional rebase output used by staged reconciliation.

### Uploaded-file reconciliation

Ordinary files use the same shared-base checkpoint idea. For each path, compare base, home, and each
returning site by type and content digest:

- created on one or several sites at different paths: union;
- identical digest at the same path: deduplicate;
- modified on only one side: take the modification;
- same path changed differently: keep both and record a naming conflict;
- delete versus unchanged: apply deletion;
- delete versus modify or rename: retain content and require a policy/decision;
- directory/permission/symlink conflicts: preserve both manifests and block unsafe activation.

The safe default for uploaded content is **keep both**. Files transfer through the content-addressed
chunk store, so home and every suitcase only fetch missing bytes.

### Optional annotations and escape hatches

Most compatible apps need no changes. When analysis cannot infer intent, `deploy.yaml` may annotate
data without requiring a library:

```yaml
resources:
  application-data:
    type: volume
    durability: durable
    dataRole: database
    reconciliation:
      excludeTables: [sessions, search_index]
      excludePaths: [cache, tmp/previews]
      conflictPolicy: collect
```

Annotations are scoped to the stable volume resource key, so they remain unambiguous when several
container mount paths point at the same managed data. `collect` preserves ambiguous branches for an
administrator; `prefer-home` and `prefer-suitcase` are explicit application-wide policies. An
annotation can omit derived/local-only rows or paths, but cannot waive integrity, identity, schema,
or opaque-format blockers.

A custom adapter remains available for non-SQLite databases or application-specific invariants,
but it is the exception rather than the default portability path.

## Opaque managed volumes and backups

This section applies to **Follows one site** compatibility mode and to recovery backups/checkpoints.
It is not the convergence mechanism for **Syncs across sites** applications.

An opaque managed volume lives on its one authoritative site. Other sites receive scheduled
verified recovery snapshots, but never mount a recovery copy for production writes while that
single-site authority is valid.

The portable Docker backend cannot assume filesystem snapshots. For a named volume, a narrowly
scoped helper container creates a quiesced, immutable checkpoint through the volume-provider
interface. A checkpoint operation:

1. runs an optional application `preSnapshot` hook;
2. pauses/quiesces the application container;
3. copies and hashes the named-volume state into a new immutable checkpoint while writes remain
   stopped;
4. verifies the checkpoint tree and resumes the container;
5. runs an optional `postSnapshot` hook;
6. stores the portable manifest and chunks in the content store.

The manifest records paths, types, permissions, sizes, symlinks, chunk digests, and a deterministic
tree digest. This baseline may impose a longer write pause for a large opaque volume, which the UI
must measure and disclose. Hooks let databases request a stronger application-consistent checkpoint.
A native Linux provider may use Btrfs/ZFS/LVM snapshots to shorten the pause, but it produces the
same provider-neutral manifest so another site can reconstruct it without that filesystem.

### Reconcile suitcase data to home

Reconciliation is an incremental snapshot fast-forward, not a merge:

1. Home and suitcase compare the last verified snapshot ID/data sequence for the application.
2. Suitcase creates or selects a newer immutable snapshot from its canonical volume.
3. Suitcase sends the signed snapshot manifest first.
4. Home returns the chunk digests it already has from earlier snapshots and other artifacts.
5. Suitcase uploads only missing chunks, with range resume and per-chunk verification.
6. Home reconstructs the snapshot into a staging recovery directory.
7. Home verifies every file and the manifest's complete tree digest.
8. One atomic metadata transaction advances `latest_verified_home_snapshot`.
9. Older manifests/chunks remain pinned by retention policy and are garbage-collected later.

For example, if home has snapshot data sequence 42 and suitcase returns at 57, home advances to 57
by receiving the new manifest and only chunks that changed since its retained snapshots. It does not
replay filesystem mutations or compare two writable directories.

Chunking strategy is a Phase 0 benchmark: compare fixed-size and content-defined per-file chunks on
SQLite, media, and source-like workloads. The correctness contract is content-addressed immutable
chunks plus a complete tree digest; the selected chunker is a performance detail.

### Transfer authority back home

If the application should run at home again, deploy.local first performs the large reconciliation
while suitcase remains live. It then establishes a short write barrier:

1. quiesce suitcase writes and take a final snapshot with the next data sequence;
2. transfer only its final missing chunks;
3. reconstruct and verify the home volume in staging;
4. start and health-check the home container against that volume;
5. commit the authority/route change;
6. retain the suitcase snapshot/container for a rollback window.

If transfer or health check fails, suitcase remains authoritative and resumes writes. A coordinated
move never leaves both volumes writable.

Candidate preview volumes are created from the latest verified home snapshot or as empty volumes.
Their writes are disposable by default and are never reconciled into production. They may be
exported as a named backup for manual/application-specific use.

If authority was forcibly broken, home and suitcase snapshots have different authority epochs and
lineages. Both are preserved; the user keeps one, restores one as a separate app, or performs an
application-specific export/import. deploy.local never presents a generic merge button.

Custom host mounts are not automatically portable. Enabling **Keep on suitcase** must either:

- verify the equivalent path/device exists on the suitcase; or
- block readiness with a precise explanation.

GPU, privileged Docker, architecture-specific images, host networking, and extra TCP ports receive
the same capability admission treatment.

### Retention

Initial recommendation:

- retain every semantic deployment/config/authority event;
- retain source and image artifacts referenced by current and rollback releases;
- retain the latest successful home backup plus configured historical backups;
- synchronize build logs and activity history;
- synchronize request aggregates, not every raw request;
- do not synchronize raw stdout/stderr history by default;
- keep captures local unless explicitly exported.

## Offline builds and iteration

Offline iteration is a core acceptance criterion, not a follow-up convenience.

### First build path: suitcase builder

Suitcase replicas already build on the suitcase while docked, so their architecture-correct
images and BuildKit layers naturally remain there. Readiness performs a no-network validation build
for the current source and lockfile. Ordinary source-only changes should reuse dependency layers.

### Dependency truthfulness

Readiness is specific to the current dependency graph. Adding a package that has never been cached
cannot be guaranteed offline. UI and CLI distinguish:

- **Runtime ready:** current release can run and be managed offline;
- **Build ready:** current dependency graph can rebuild offline;
- **Build cache incomplete:** runtime is safe, but some builds may need internet.

### Laptop builder

This is an optional later performance feature, not part of the portability contract. The suitcase
must be able to build independently. A future CLI may invoke Docker Buildx for the suitcase target
architecture, export an OCI image, and upload content-addressed layers, but the suitcase remains the
activation target and records the site-local release only after health-checking the received image.

### deploy.local platform iteration

Suitcase releases use A/B slots:

- current known-good release;
- candidate/previous release;
- signed manifest and checksums;
- health-gated activation;
- automatic rollback if edge/control readiness fails.

While docked, release bundles pre-stage automatically. A local development bundle can be installed
offline through an explicit developer command without weakening normal signature verification.

## Docker suitcase deploy target — MVP

### Product boundary

The minimum viable suitcase is a multi-platform **deploy target**, not a custom SBC distribution.
Publish one multi-architecture Linux OCI image for `linux/amd64` and `linux/arm64`; run it through
Docker Engine on Linux or Docker Desktop on macOS/Windows.

```text
macOS / Linux / Windows host
  deploy CLI launcher
    pairing, trust, host capability checks, optional mDNS helper

  Docker Engine / Docker Desktop
    deploy.local suitcase-core container
      portable control + edge + sync + executor
      Docker API access
      core state/content volume

    app containers (siblings, not nested Docker)
      per-app data/uploads named volumes

    volume-helper containers
      snapshot + analyze + diff + reconcile + backup
```

Do not use Docker-in-Docker. The suitcase-core container controls sibling application/helper
containers through the host Docker API. Mounting the Docker socket grants effectively
administrator/root-equivalent control of that Docker host, so setup requires a prominent security
warning and the target should be treated as a trusted deploy.local machine.

### One-command target setup

The host-facing journey should be:

```text
deploy suitcase target start
  checks Docker/version/platform/resources/ports
  pulls the matching linux/amd64 or linux/arm64 image
  creates persistent volumes and the suitcase Docker network
  starts suitcase-core with restart policy
  opens or prints the pairing page + short code
```

Equivalent Docker Compose output remains available for inspection and automation. A Windows
PowerShell launcher and macOS/Linux standalone CLI must normalize host paths, Docker contexts, port
availability, and restart behavior so users do not assemble a long `docker run` command.

Pairing then requires the suitcase name, default data sync policy, security mode, and network
capability acknowledgement. No repository checkout, Node/pnpm install, SSH, or OS reflash is
required.

### Storage model for Docker targets

Prefer Docker-managed named volumes for control state and per-app `/app/data`/`/app/uploads` on all
three host platforms. Docker Desktop databases should not depend on slow or case-different host bind
mounts by default.

The controller cannot assume a Linux host path is visible identically from inside Docker Desktop.
Introduce a volume-provider abstraction:

- create one or more named volumes per app;
- start a narrowly scoped helper container when snapshot/analyze/reconcile access is required;
- stream immutable checkpoint/manifest artifacts into the suitcase content-store volume;
- quiesce/stop the app around consistency boundaries rather than copying a live volume;
- support an explicit host bind directory only as an advanced, platform-validated option.

This Docker backend cannot require Btrfs. It uses portable quiesced SQLite/file checkpoints and
content-addressed artifacts. A later native Linux appliance may add Btrfs as an optimized snapshot
provider behind the same interface.

### Platform capability matrix

| Host                                                         | MVP capabilities                                                                        | Expected limitation                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Linux Docker Engine (`amd64`/`arm64`)                        | Full control/build/data sync; host networking and native service integration available. | Automatic Wi-Fi AP depends on the host adapter/driver and a host-side helper.                                                            |
| macOS Docker Desktop (`arm64`/`amd64`)                       | Control/build/data sync, published HTTPS ports, persistent named volumes.               | Cannot configure macOS Internet Sharing/Wi-Fi from the container; `.local` advertisement and CA trust may require the host launcher.     |
| Windows Docker Desktop with Linux containers (`amd64` first) | Control/build/data sync, published HTTPS ports, persistent named volumes.               | Cannot configure Windows Mobile Hotspot from the Linux container; host networking/mDNS/trust require launcher checks and may be reduced. |

Docker Desktop host networking is an opt-in capability on supported versions, not a universal
assumption. The baseline uses published ports and a generated local/LAN access URL. The launcher
tests mDNS and TLS trust and reports **Native `.local`**, **Host-helper `.local`**, or **IP/localhost
only** honestly.

A Docker target can be a complete offline suitcase on an existing LAN or user-enabled host hotspot.
Automatic creation of the travel Wi-Fi network is an appliance/native-host enhancement; the
container cannot directly reconfigure the physical Wi-Fi adapter on macOS or Windows.

### Docker target artifacts

Each release publishes:

- signed multi-architecture `suitcase-core` image (`linux/amd64`, `linux/arm64`);
- matching volume-helper image and protocol version;
- Docker Compose template and generated resolved configuration;
- standalone host launchers through the existing deploy CLI platform binaries;
- image digests, SBOM, provenance, minimum Docker/Desktop versions, and upgrade/rollback metadata;
- platform capability/support matrix.

The image contains the exact deploy.local runtime, native SQLite helper, Docker client/API support,
offline dashboard/docs, current/rollback platform slots, and health watchdog. Application images and
build caches materialize during docked preparation.

## Hardware sizing without a prescribed device

### Non-decision: no reference model

deploy.local does not choose a Raspberry Pi, Radxa board, Beelink-class mini PC, or any other retail
model as the suitcase. Hardware pricing, availability, dimensions, architecture, and memory tiers
change too quickly, while different portable application graphs have materially different needs.

These remain valid, non-chosen target forms:

| Form                       | Advantage                                                              | Tradeoff                                                              |
| -------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Existing laptop/desktop    | No acquisition cost; battery/display may improve recovery              | May be larger and Docker Desktop has reduced host-network integration |
| Compact x86 system         | Broad image/native dependency compatibility and ordinary Linux support | Complete unit and power supply may occupy more packed space           |
| ARM64 SBC                  | Smallest physical envelope and often USB-C powered                     | Board-specific OS/networking work and ARM image compatibility         |
| Native/flashable appliance | Simplest eventual setup and automatic host integration                 | Separate support artifact for each validated hardware configuration   |

Retail models are examples in a compatibility matrix, never protocol dependencies or the answer to
“how much hardware does a suitcase need?” The user chooses after seeing a workload-derived estimate.

### Capacity model

The planner derives two profiles from home-hub evidence:

- **Minimum:** enough to run the selected replicas with the requested concurrency, preserve current
  data and one recovery path, and complete only the offline operations the administrator selected.
- **Recommended:** minimum plus the selected trip/growth horizon, desired backup/checkpoint
  retention, useful build cache, conflict/rejoin working space, and safety headroom.

RAM is estimated as:

```text
suitcase platform/OS reserve
+ observed/declared high-water working set at each selected component instance count
+ maximum admitted rolling-release surge and shared-service connection-pool growth
+ largest allowed concurrent offline-build peak
+ largest sync/reconciliation/helper peak that may overlap runtime
+ safety headroom
```

If builds are serialized, the planner budgets the largest selected build rather than summing every
build. It distinguishes **Runs offline** from **Builds offline** so a smaller device can be an honest
runtime suitcase even when it cannot develop every selected app.

Persistent storage is estimated as:

```text
selected app databases and uploaded files
+ retained source and current/rollback application images
+ platform current/rollback releases
+ requested build-cache budget
+ shared bases, pending branches, reconciliation staging, and conflict retention
+ backup policy and projected growth for the selected horizon
+ free-space safety floor
```

Use observed high-water marks and growth windows rather than container limits or a single current
sample. Report both the calculated quantity and the important contributors—for example,
“9.4 GB recommended RAM: 4.1 GB replicas, 2.8 GB largest build, 1.0 GB reconciliation, 1.5 GB
headroom.” Round the purchase-oriented recommendation up to common device capacities without
pretending the rounded tier was directly measured.

### Confidence and validation

Each input is **Measured**, **Declared**, **Estimated**, or **Unknown**. Missing build probes,
unrepresentative home traffic, opaque external services, a target architecture change, or uncertain
data growth reduce confidence and produce a range rather than false precision.

The pre-purchase planner is advisory because the home hub cannot fully predict target-specific CPU,
thermal, storage, driver, or architecture behavior. After pairing, deploy.local runs resource,
storage, native build, no-network, and access-mode probes on the actual target. That evidence can
confirm the estimate, lower concurrency, or block only the unsupported readiness promise.

Regardless of capacity, managed suitcase data requires durable storage; microSD-only data storage is
not recommended. Networking, automatic-start behavior, cooling, power, and Wi-Fi access-point mode
remain independent capability checks rather than consequences of having enough RAM or disk.

## Later flashable appliance image strategy

### Current repository state

There is not yet a deploy.local Raspberry Pi or Orange Pi disk image, image-builder configuration,
or first-boot appliance flow in this repository.

Useful ingredients already exist:

- the CLI build produces a standalone `linux-arm64` binary;
- Linux agent/server service installation already generates systemd units;
- the built server/supervisor/edge artifacts run as ordinary Linux processes;
- the execution-node path already understands ARM64 platform identity and Docker capability.

Those pieces do not install an operating system, bootloader/kernel/device tree, Docker, Btrfs tools,
Wi-Fi access-point services, DHCP/DNS, mDNS, firewall policy, first-boot identity, pairing UI, storage
layout, or recovery environment. They are not a flashable suitcase today.

### Do not build one universal SBC image

The deploy.local appliance should have one common userspace/appliance layer and board-specific boot
images:

```text
deploy.local suitcase package
  supervisor + control/edge/executor/sync helper
  systemd units + first-boot/pairing service
  networking/AP/DNS/firewall configuration
  Docker/BuildKit + storage/checkpoint tooling
  current + rollback deploy.local release
  diagnostics, recovery, and update metadata

board image
  boot firmware + bootloader + kernel + device tree
  board Wi-Fi/storage/thermal configuration
  common deploy.local suitcase package
```

Raspberry Pi and Orange Pi families do not share one boot stack, and “Orange Pi” is not one hardware
target. Support and artifacts must name the exact board and revision.

Recommended builders:

- **Raspberry Pi 4/5:** build a minimal 64-bit Raspberry Pi OS image with Raspberry Pi's
  [`rpi-image-gen`](https://github.com/raspberrypi/rpi-image-gen) and a deploy.local configuration/layer.
- **Specific Orange Pi boards:** build Debian/Ubuntu-based images through the official
  [Armbian build framework](https://github.com/armbian/build), which owns the board-specific U-Boot,
  kernel, firmware, and device-tree work.

The common deploy.local layer should also be packaged so developers can install it onto an already
supported Debian/Armbian system. That bootstrap path is useful for hardware bring-up. For this later
appliance flavor—not the Docker MVP—the intended user experience is download, flash, boot, and pair.

### First supported artifacts

When appliance images become a priority, start with one fully validated image rather than several
nominally supported boards. Candidate order is decided from measured price, availability, storage,
thermal behavior, and networking at that time—not from brand preference:

1. One exact board or x86 appliance configuration that meets its published compatibility and
   workload-capacity requirements.
2. Raspberry Pi 4/5 only after complete-system price, thermal, storage, and build validation.
3. An explicitly selected Orange Pi model after verifying mainline/Armbian support, Docker,
   storage, and a Wi-Fi chipset capable of stable access-point mode. Boards without suitable Wi-Fi
   are **Ethernet/USB-Wi-Fi only**, not falsely advertised as self-contained suitcases.

Each release publishes:

- compressed raw image (`.img.xz` or equivalent);
- SHA-256 digest and signed release manifest;
- exact board/revision, OS/kernel, deploy.local, and protocol versions;
- minimum media/storage requirements;
- software bill of materials and licenses;
- flashing instructions compatible with Raspberry Pi Imager, Armbian Imager, or raw-image tools;
- recovery/rollback image or documented recovery path.

Hardware support states are **Validated**, **Experimental**, and **Unsupported**. “Linux ARM64” alone
is not sufficient for a validated appliance because Wi-Fi AP, boot recovery, thermal behavior, and
storage durability are board-specific.

### Image contents and first boot

The image should include:

- minimal headless OS with automatic filesystem expansion;
- pinned deploy.local runtime/native dependencies and two platform release slots;
- Docker Engine/BuildKit and the exact daemon/storage configuration validated by the project;
- NetworkManager or validated hostapd/dnsmasq equivalent, mDNS, nftables/firewall policy, and local
  recovery portal;
- Btrfs/checkpoint/content-store tools and a storage-migration service for the USB SSD;
- systemd services for first boot, portable supervisor, networking, health watchdog, and updates;
- no shared default password or fleet credential; SSH disabled by default or gated behind an explicit
  developer setting;
- a device identity generated on first boot, never baked into the image.

First boot should:

1. expand/verify the boot filesystem and discover the supported USB SSD;
2. initialize or offer to initialize the suitcase data volume without erasing an ambiguous disk;
3. generate the device identity and short-lived pairing claim;
4. advertise an unpaired candidate over Ethernet and start a temporary
   `deploy-suitcase-<short-code>` setup network when supported;
5. expose only the pairing/recovery page until home confirms the short code;
6. require the administrator to select the suitcase default data policy, away SSID/credential, and
   security profile;
7. receive fleet/site credentials, current release, administrator projection, and selected app
   materialization;
8. run hardware/storage/network self-tests before showing **Docked**.

The image never contains a pre-paired fleet identity. Reflashing plus restoring an encrypted
site/recovery bundle may recover a suitcase; cloning the raw factory image must create a new device.

### Image delivery phases

- **Hardware bring-up only:** install the common appliance package onto stock Raspberry Pi OS or a
  board's supported Armbian image; validate Docker, storage, AP mode, thermals, and first boot.
- **Developer image:** reproducible board image with serial/SSH diagnostics explicitly enabled and a
  visible experimental warning.
- **Beta image:** signed artifact, no SSH requirement, pairing flow, update/rollback, recovery,
  destructive-disk confirmation, and 24-hour docked/away tests.
- **Supported image:** release pipeline, SBOM/security updates, board revision matrix, flash/upgrade
  tests, power-loss tests, and a documented support lifetime.

An install script is an implementation bridge. A flashable image remains a later convenience and
support milestone; it is not the Docker-target MVP gate.

## Networking and discovery

### Docker MVP topology

The baseline Docker suitcase joins an existing local network or a hotspot enabled through the host
operating system. The launcher publishes the dashboard and app ports, verifies the reachable LAN
address, and prints or opens one concrete HTTPS URL. This works offline: the network supplies local
connectivity but does not need an internet uplink.

The Docker container cannot directly reconfigure the physical Wi-Fi radio on macOS or Windows.
Those targets therefore use an existing LAN, macOS Internet Sharing, or Windows Mobile Hotspot.
The host launcher should detect the current state, explain one platform-native action when needed,
and re-check reachability instead of pretending the container created the network.

A dedicated Linux suitcase may add a small privileged host networking helper. On an explicitly
validated adapter/driver combination, that helper can start a deploy.local access point, DHCP/local
DNS, and firewall policy automatically. Access-point support is a hardware capability with a test
result—not an assumption based on the presence of a Wi-Fi interface.

A travel router remains an optional upgrade for range, more clients, or convenient internet uplink;
it is not required when the user already has a LAN/host hotspot or when the dedicated Linux target
passes access-point validation. Random guest Wi-Fi may isolate clients or suppress multicast, so
readiness must verify the actual route rather than treating association with an SSID as success.

### Discovery capability levels

Every suitcase reports one of these tested access modes:

- **Native `.local`:** host networking and mDNS make `deploy.local` and app aliases reachable.
- **Host-helper `.local`:** a trusted launcher/helper advertises names and forwards traffic to
  published container ports.
- **IP/host name:** the launcher exposes a stable generated URL and QR code without promising mDNS.

Published ports are the portable baseline. Docker host networking is an optional capability because
support and behavior differ between Linux Docker Engine and Docker Desktop. A port collision or
failed advertisement is a readiness blocker with a concrete remediation, not a silent fallback.

### Edge ownership

- Docked on home LAN: home edge advertises all fleet names; suitcase edge is gated off.
- Away on a recognized non-home LAN: suitcase advertises only its dashboard and local app replicas.
- Rejoining: suitcase keeps local routes until home state verifies, then withdraws advertisements.
- Remembered home LAN with coordinator outage: suitcase remains standby unless explicitly
  overridden.

Home network recognition should combine a paired home-edge presence signal with locally stored
network characteristics. No single SSID, IP range, gateway MAC, or wall-clock lease is sufficient
alone. Incorrect classification must surface visibly and be manually correctable.

### TLS and time

The fleet root CA private key stays home. Pairing issues the suitcase a constrained intermediate
identity so it can create leaf certificates for offline-created `.local` applications without
copying the root key. Existing clients continue trusting the fleet root.

Sequence and generation drive ordering, not timestamps. Readiness still checks host time because TLS
validity and session expiration depend on it. Targets without a dependable battery-backed clock,
including many SBCs, need a tested persisted-clock fallback, optional RTC guidance, and a recovery
screen for invalid time.

## Authentication, secrets, and loss

### Offline authorization

The first release projects administrator users only. It stores their password verifiers so those
administrators can log in without home, then issues site-local sessions. Home session tokens do not
need to be copied wholesale. A later suitcase-operator role can reduce privilege without expanding
the first authorization model.

Offline-created audit events retain actor identity and origin site. User/role changes made at home
apply when docked; revocation cannot reach an already disconnected device, which the UI must state.

### Site identity

Pairing establishes independent signing and transport keys for the suitcase. Home can revoke the
site for future synchronization and mark its applications for recovery. Keys should be rotated
without re-pairing when possible.

### Secrets at rest

Portable environment secrets are encrypted to the suitcase device identity during transfer.
Because an unattended suitcase must retain a usable decryption key, this protects replication and
casual storage inspection but does not fully protect a stolen, bootable device.

Offer two appliance security profiles:

- **Automatic start:** simplest experience; boots and restores apps without a passphrase.
- **Locked suitcase:** encrypted data volume requiring a passphrase or external unlock key after
  power loss.

Automatic start is the developer-beta default. The setup flow clearly explains the physical-loss
tradeoff and offers the locked profile as an opt-in. Regardless of profile, the dashboard must
provide **Mark suitcase lost**, revoke its identity, show exposed app and secret scope, rotate
supported credentials, and guide snapshot recovery.

## Failure behavior

| Failure                                             | Required behavior                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| One of two web instances fails                      | Remove it from the ready endpoint set, keep serving if minimum-ready holds, show degraded capacity, and replace it safely.          |
| Shared database fails                               | Mark the root dependency failed and its consumers/serving promise affected; do not emit a separate unexplained alert per instance.  |
| New instance fails rollout readiness                | Keep the old healthy endpoint set serving, stop rollout, retain diagnostics, and offer safe retry/rollback.                         |
| Power loss while draining an instance               | Reconcile desired versus actual instances on restart; never route to an unready or wrong-release endpoint.                          |
| Unplug during event/changeset sync                  | Resume from the last durable acknowledgement; do not duplicate effects.                                                             |
| Unplug during artifact transfer                     | Keep verified partial bytes and resume by digest/range.                                                                             |
| Power loss during deploy                            | Keep or recover the previous healthy container on boot.                                                                             |
| Power loss during projection/checkpoint publication | Commit the control transaction or checkpoint pointer atomically, or leave the prior state selected.                                 |
| Corrupt artifact                                    | Quarantine, request again, and block the affected readiness capability.                                                             |
| Database/file conflict                              | Preserve every branch artifact and withhold merged-checkpoint publication until policy resolves it.                                 |
| Disk nearly full                                    | Stop materialization before the runtime safety margin is consumed.                                                                  |
| Invalid clock                                       | Keep running existing apps where safe; block certificate/session operations with recovery instructions.                             |
| Home control restarts                               | Keep the suitcase docked/standby on the remembered home network.                                                                    |
| Suitcase disappears                                 | Keep home replicas active; show the missing replica, its base checkpoint, and its potentially unreceived branch.                    |
| Replica is removed while away                       | Stop waiting for its acknowledgement; quarantine its branch if it later returns.                                                    |
| Duplicate offline app name                          | Preserve both app IDs and require alias resolution.                                                                                 |
| Version/schema mismatch                             | Sync compatible records, preserve both states, and require a staged upgrade or explicit replica removal before incompatible writes. |
| Suitcase is stolen                                  | Revoke the site, expose the affected secret list, and recover from the last verified checkpoint/backup.                             |

## APIs and CLI

The implementation exposes the application graph through
`/api/deployments/:name/application-spec` and `/api/deployments/:name/application-plan`, the Catalog through
`/api/catalog`, fleet administration through `/api/fleet`, Suitcase pairing/sync through
`/api/suitcases`, and Home recovery through `/api/operations/recovery-bundles`. The capability lists
below describe those implemented endpoint families rather than proposed names.

### Catalog and application-graph APIs

- list/search catalog releases with trust, support, and compatibility metadata;
- resolve a blueprint plus administrator answers into a redacted normalized-graph preview;
- preflight an install/upgrade against one site without mutating runtime state;
- install, retry, upgrade, roll back, detach, derive, and uninstall transactionally;
- inspect components, resources, bindings, jobs, health, and exact privilege/network/device grants;
- create/rotate a generated binding secret without exposing it in normal API responses;
- invoke a component lifecycle profile's backup/restore operation and return verification evidence;
- import a supported Compose subset and return translated, ignored, review-required, and blocking
  fields.

### Component runtime and service-routing APIs

- inspect desired/ready instance counts, instance/node/release state, service endpoint membership,
  failure-domain coverage, and rollout/drain progress;
- set a fixed component instance count or allowed site override through capacity/compatibility
  preflight;
- restart/replace/drain one instance or roll a component group without restarting unrelated managed
  services;
- resolve one stable internal service/interface to its current authenticated ready endpoint set;
- update route/service endpoint sets atomically and preserve the old healthy set on failed rollout;
- configure supported affinity and drain policy, with explicit WebSocket/long-request behavior;
- return application/component/instance-correlated logs, metrics, events, and health evidence.

### Site administration APIs

- discover/pair/confirm/revoke suitcase;
- list topology and site readiness;
- add/remove an application replica;
- test offline readiness;
- mark lost, revoke, and remove a replica from acknowledgement requirements;
- inspect/resolve conflicts.

### Candidate release APIs

- create/build a candidate against a base epoch/generation;
- inspect build/activation status, schema compatibility, and referenced artifacts;
- list candidates waiting for any replica;
- promote, supersede, compare, or discard a candidate;
- activate a candidate only on the requesting site unless fleet promotion is explicit.

### Data portability APIs

- scan a quiesced volume and return its reconciliation capability report;
- confirm table/path classifications and optional conflict policies;
- set the app default/per-suitcase data sync policy and initialize shared or site-local state;
- return pending manual change summaries and perform an administrator-authorized **Sync now**;
- inspect checkpoint lineage, replica bases, pending changesets/blobs, and conflicts;
- resolve a structured row/file conflict and validate the resulting staging checkpoint.

### Sync APIs

- exchange protocol/capabilities/cursors;
- push/pull control-event batches, profiles, changesets, and checkpoint acknowledgements;
- query artifact presence;
- upload/download artifacts with range support;
- publish materialization/readiness;
- publish verified merged checkpoints and replica adoption state.

### CLI surface

Normal deployment remains `deploy`. The graph, Catalog, Suitcase, and recovery commands are
administrative or diagnostic rather than required ceremony for every deployment:

```text
deploy validate
deploy plan --app <name>
deploy schema
deploy catalog list
deploy catalog inspect <catalog-id> [release]
deploy catalog install <catalog-id> [release]
deploy catalog installations|status|upgrade|rollback|retry|recovery-point|uninstall|detach|derive
deploy suitcase target compose|start|status|diagnose|upgrade|rollback|stop
deploy suitcase pair create
deploy suitcase pair <home-url> --code <code>
deploy suitcase topology
deploy suitcase dock|away|rejoin
deploy suitcase sync status|now
deploy suitcase access
deploy suitcase revoke --site <site-id>
deploy recovery readiness|create|verify|rehearse|restore|list|support
```

The server provides a POSIX installer at `/install` and a Windows PowerShell installer at
`/install.ps1`, so these administrative commands are available on macOS, Linux, and Windows without
a source checkout.

When connected to a suitcase, ordinary CLI output states the context without requiring a flag:

```text
Deploying notes to Vacation Suitcase (offline)
Build cache: ready for current dependencies
...
Deployment recorded locally; fleet sync will resume at home.
```

When home receives a deploy for an away suitcase app, it is equally explicit:

```text
Vacation Suitcase is away; deploying notes to the Home replica.
Building from fleet generation 17...
Home release is healthy. Vacation Suitcase still runs generation 17.
This release will be offered for fleet promotion when sites synchronize.
```

The CLI config should ultimately store fleet identity and known site endpoints rather than assuming
one immutable coordinator URL, while preserving the default `https://deploy.local` experience.

## Admin information architecture

The dashboard should present a useful topology, not a physics simulation or decorative web of
lines. Nested site planes and application placement encode real ownership and status; dense tables
remain available for operations.

Recommended navigation:

```text
Fleet
  Overview        topology, health, readiness, problems
  Apps            sortable operational table
  Catalog         curated and local one-click applications
  Sites           Home, nodes, and suitcases
  Activity        fleet and portable event history
  Logs
  Shared apps

Account
  Settings
```

The current Nodes page can evolve into Sites, with tabs or grouped sections for Home compute and
Suitcases. Do not add separate top-level pages for every infrastructure noun.

### Overview

Lead with a structured fleet map:

```text
+ Home --------------------------------------------------+
| Main Host                  Studio Mac                  |
| photos · automation        development                 |
| 3 healthy                  1 healthy                   |
+--------------------------------------------------------+

+ Vacation Suitcase ------------------- READY OFFLINE ---+
| notes · maps · family-dashboard                         |
| runtime ready · build ready · backup 4m ago             |
+---------------------------------------------------------+
```

Selecting a site/node/app filters or opens the corresponding operational detail. Status edges show
only meaningful relations: routing, replication, active sync, and a problem. The table remains the
accessible fallback and mobile representation.

### Three related graph views

Do not place fleet topology, application dependencies, and data lineage on one canvas. They answer
different operational questions and become unreadable when their edges are combined:

| View                  | Primary question                                  | Nodes and edges                                                                            |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Fleet topology**    | Where does each application/replica run?          | Sites, nodes, application replicas; placement, routing, and synchronization edges.         |
| **Application graph** | What must work for this application to serve?     | Entry points, runtime/service components, jobs, volumes, devices, external dependencies.   |
| **Data lineage**      | Where is authoritative state and can it converge? | Databases/files, checkpoints, branches, backups, site authority, and reconciliation edges. |

They share stable application/resource/site IDs and deep-link to one another. A site selection on
the application graph overlays placement and materialization without duplicating every graph node.
The data view opens only when the app has durable state or an actionable portability problem.

### Suitcase detail

The page's primary job is to answer “Can I unplug this now?” It includes:

- unmistakable **Ready to go**, **Syncing**, **Away**, **Rejoining**, or **Needs attention** state;
- runtime and build readiness separately;
- replicated applications, automatic/manual/no-sync policy, convergence state, and per-app blockers;
- release candidates waiting for this suitcase and their base generations;
- portability profiles, adopted checkpoints, pending changesets/blobs, and conflicts;
- storage/capacity and last verified backup;
- last contact, active network mode, version, and rollback health;
- test offline mode;
- manage apps;
- recovery, revoke, and lost-device actions in a protected danger area.

### Application detail

The application—not a container—is the durable admin object. Its header contains name, aggregate
health, source/catalog support, active/available release, selected site, entry-point **Open** action,
and the one most relevant lifecycle action. Placement evolves from a node dropdown into a concise
replication panel.

The page follows progressive disclosure:

1. **Application promise:** Can users reach it? Is its current release healthy? Is its data
   protected? Where does it run? Is there an actionable blocker?
2. **Application graph:** Which required/optional components and resources produce that result?
3. **Resource detail:** Exact container, service, volume, binding, device, network, job, site, logs,
   metrics, and diagnostic evidence.

A normal one-container application still looks like today's application page. Its graph collapses
to “Web · one volume · one route” rather than showing a ceremonial one-node canvas.

#### Application overview

The first viewport contains four independent summaries; do not compress them into one status badge:

- **Serving:** entry-point health and user-visible availability;
- **Release:** desired versus active release, rollout/migration state, and upgrade availability;
- **Data protection:** durable resources, last verified backup, sync/authority, and conflicts;
- **Placement:** active sites/nodes, suitcase readiness, and target compatibility.

Below that, show the semantic dependency graph and current problems before charts. Recent activity,
aggregate request/resource trends, and common actions follow. A database outage should appear once as
the root problem with its affected dependants—not as five unrelated container alerts.

#### Semantic application graph

Lay out the logical graph in readable lanes:

```text
Entry points          Runtime                    Services/state

notes.local ────────> web ───── SQL ──────────> PostgreSQL ──> database volume
                         └──── queue ──────────> broker
upload/API ─────────> worker ── files ─────────> uploads volume
                         └──── optional ───────> external mail API
```

A scaled component remains one stable graph node with an instance-count badge:

```text
app.local --> nginx 1/1 --> web 2/2 --> PostgreSQL 1/1 --> database volume
                                  └--> broker 1/1
```

Expanding `web 2/2` shows the ephemeral instances, node placement, release, readiness, connection
drain, resource usage, and scoped actions. Instance churn must not rearrange the logical graph.

- Nodes represent things with an independent lifecycle or health contract: web/worker/scheduler,
  profiled or unprofiled service component, job, durable volume, external service, or device.
- Routes, ports, secret bindings, and ordinary environment values are labels/badges or drawer
  details unless they have an actionable status; they are not graph nodes by default.
- Edges name the dependency/interface—HTTP, SQL, queue, mount, device, or external API—and whether it
  is required, optional, or allowed to degrade.
- Color communicates health only alongside icon/text. Edge animation is reserved for a live rollout
  or transfer and respects reduced motion.
- Selecting a node opens a side drawer with health, site, release, resource use, logs, actions,
  dependencies, and evidence. It never navigates away merely to inspect one fact.
- A logical/site toggle overlays **Home**, **Suitcase**, or **Compare sites** state. The logical
  graph remains stable while badges show missing, stale, stopped, or differently versioned site
  materializations.

The graph is not a free-layout infrastructure diagram. deploy.local controls lane/order semantics so
the same application remains recognizable after upgrades and on mobile. Its accessible equivalent
is a dependency-ordered tree/table with the same status and actions.

#### Implemented application navigation

The application layout uses these graph-aware tabs:

```text
Overview     graph, runtime/service health, release/data/placement summaries, problems
Releases     source/builds, artifacts, migrations, rollout, site versions, upgrades
Logs         application stream with site/component context and filters
Terminal     explicitly selected runtime component/instance shell
Traffic      routes, requests, latency, errors, network exposure
Data         databases, volumes, backups, restore, authority, portability, reconciliation
Activity     correlated application/component/service events
Settings     desired graph, supported configuration, secrets, privileges, devices, placement
```

Logs and terminal remain directly deep-linkable, but their controls require explicit site and
component context for a multi-component app. Never attach an “application terminal” to whichever
container happens to be first. The default log stream interleaves the whole application with clear
site/component labels and filters.

Legacy **Build**, **Requests**, **Resources**, and **History** links resolve to **Releases**,
**Traffic**, **Data**, and **Activity** respectively. **Logs** and **Terminal** retain stable direct
routes while gaining graph context.

#### Status propagation and actions

Every dependency declares `required`, `optional`, or `degraded-allowed` plus a health/readiness
contract. Aggregate application health is computed from the critical path:

- a failed required database blocks/degrades every consumer and the serving promise;
- one failed instance in a `minimumReady: 1` web group reports **Serving · degraded capacity 1/2**;
  zero ready instances reports unavailable;
- a single Nginx or database in front of/behind a redundant web group remains a visible single
  failure point rather than allowing the `×2` badge to imply end-to-end high availability;
- an optional integration may show degraded without declaring the application unavailable;
- a completed migration job remains evidence, not an always-running unhealthy component;
- a stopped site replica does not mark a healthy home app down, but it does block that site's
  placement/readiness promise;
- stale backup or unsafe data sync affects data protection, not request-serving health.

App-level actions operate on the dependency closure:

- **Deploy/upgrade** plans services, jobs, components, routes, and rollback as one transaction;
- **Restart application** restarts runnable components in dependency-aware order and does not
  restart a healthy database by surprise;
- **Back up application** creates a consistency group across its databases and files;
- **Move/Keep on suitcase** includes every required resource and blocks on an unsatisfied
  dependency;
- **Stop application** withdraws traffic and stops runnable components while stating which managed
  services remain available for recovery;
- **Delete application** inventories catalog ownership, shared/external resources, backups, and
  retain/delete-data choices before acting.

Component/service actions—restart this worker, rotate this database binding, rerun this job, open
this component's logs—live in the selected graph node and are advanced operations.

#### Apps list and fleet operations

One row/card continues to represent one logical application, never one row per component. Add a
compact graph summary such as `2 runtimes · PostgreSQL · 3 volumes`, aggregate serving/release/data
states, active sites, origin/support, and the highest-priority problem. Filters include dependency
type, site, catalog/source origin, target requirement, suitcase capability, data mechanism, and
support status.

Bulk restart, backup, move, upgrade, or delete operates on selected applications and previews the
number of affected components/resources. Fleet logs and activity retain application grouping, then
allow site/component drill-down.

#### Application detail fields

The graph-aware page exposes the specified suitcase fields:

- catalog/source origin, support scope, installed/available release, and detach/derive state;
- exact target compatibility, privileges, devices, networks, service/profile versions, backup and
  restore evidence;
- runs-on sites/nodes and the release selected at each site versus the fleet desired release;
- **Keep on suitcase** controls for every paired suitcase;
- data mechanism, per-suitcase **Data sync** setting, and portability report;
- runtime/build readiness, last fleet sync, shared checkpoint, branch status, and recovery backup;
- current generation/epoch only in advanced diagnostics;
- **Away on ...** state without disabling home mutations for reconcilable applications.

### Catalog

Catalog cards answer **what it does**, **who maintains this recipe**, and **will it work here** before
showing an install button. Filters cover target/site, architecture, offline use, local hardware,
service-component/profile requirements, trust tier, and suitcase capability.

Selecting an app opens its support matrix and graph preview. The install action remains disabled
until a site is selected and every blocking requirement is resolved. Elevated privileges, host
networking, device access, and public ports receive an explicit review step; common safe installs do
not acquire extra confirmation screens.

Installed catalog apps leave the catalog workflow and appear in the normal Apps view. The catalog
entry shows **Installed on Home**, upgrade availability, and other compatible sites instead of
creating a parallel operations dashboard.

### Conflict resolution

Data conflict UI groups by database row or file path, shows the base and every site version, and
offers explicit actions such as **Keep both uploads**, **Use home value**, **Use suitcase value**, or
**Edit merged value**. It never makes the user choose one whole volume when only one row conflicts.

Release comparison is separate: show release lines, origin sites, deploy actors, source revisions,
schema compatibility, and actions such as **Promote for fleet**, **Keep site releases**, **Compare
changes**, and **Discard candidate**. Reserve danger styling for data loss, incompatible schemas, or
removed-replica recovery.

## Visual direction

Subject: a self-hosted personal application fleet for technically capable people.  
Single job of the admin visual system: make topology, replication, portability, and readiness
understandable at a glance.

### Design system

Retain the existing offline-bundled Inter and JetBrains Mono fonts. Bundled typography is itself an
offline product requirement. Use Inter for navigation and prose, a more assertive Inter display
treatment for the marketing thesis, and JetBrains Mono for identities, generations, transfer
progress, commands, and telemetry.

Retain the violet-tinted dark system while assigning topology colors narrowly:

| Token        | Value     | Role                                     |
| ------------ | --------- | ---------------------------------------- |
| Night        | `#0f0c16` | Base canvas                              |
| Site plane   | `#1a1624` | Grouped home/suitcase surfaces           |
| Fleet violet | `#9c6bfc` | Identity, selection, primary action      |
| Transit cyan | `#35d3e6` | Active synchronization and graph links   |
| Ready green  | `#24d99b` | Verified offline/runtime readiness       |
| Away amber   | `#f2aa4c` | Healthy disconnected state, not an error |

Danger remains reserved for data risk, invalid identity, and conflict. “Away” must not look broken.

### Signature interaction

The memorable element is the **detachment seam**: home and suitcase appear as two structured site
planes joined by a narrow live sync tether. On the homepage, one deliberate motion lets the
suitcase plane separate while both sides remain healthy. On the dashboard, the same visual grammar
is static and operational. Reduced-motion mode switches states without spatial animation.

This is the one aesthetic risk. Everything around it stays restrained: no generic floating metric
cards, random constellation lines, draggable physics graph, or ambient motion unrelated to state.

### Accessibility and scale

- Every topology relationship has a textual/table equivalent.
- Color never carries authority/readiness alone.
- Keyboard focus order follows site, node, then application hierarchy.
- Away/ready/conflict status is announced through text.
- Motion respects `prefers-reduced-motion`.
- Mobile uses nested site lists rather than shrinking a canvas.
- Large fleets collapse app groups and progressively disclose details.

## Homepage plan

The homepage becomes a product story instead of a feature inventory.

### Hero thesis

Headline:

> **Your cloud is wherever your nodes are.**

Supporting copy:

> Install supported apps or deploy your own code across the machines you own. Take selected
> applications offline, keep building while you travel, and reconnect when you return.

The hero's detachment seam demonstrates the thesis: a home site and suitcase begin connected, the
suitcase moves away, and both continue showing healthy applications. A concise terminal reinforces
that `deploy` remains unchanged in both states.

### Story sequence

1. **Run what you need** — install a supported application or deploy your own code through the same
   application model.
2. **Build your own cloud** — the machines you own form one application fleet.
3. **See the whole application** — web processes, workers, databases, volumes, devices, and routes
   stay one understandable graph.
4. **Place applications anywhere** — complete app graphs move to the compute/storage they need.
5. **Take part of it with you** — selected apps gain ready-to-go suitcase replicas.
6. **Keep deploying offline** — the writable dashboard and CLI travel with them.
7. **Reconnect naturally** — clean records and uploads converge; real conflicts stay visible.

The existing dashboard preview should evolve into the actual topology model. Infrastructure details
and feature depth follow the core story rather than competing with it above the fold.

## Documentation plan

Reorganize the docs around the mental model:

### Concepts

- Your application graph;
- components, resources, bindings, lifecycle profiles, and lifecycle jobs;
- catalog blueprints, trust tiers, support scope, and the normalized application specification;
- fleets, sites, nodes, and suitcases;
- placement, replicas, release authority, and data reconciliation;
- readiness and materialization.

### Workflows

- install, upgrade, detach, and remove a catalog application;
- scale a component, inspect instance/node placement, drain one instance, and roll a release;
- add PostgreSQL to a source-built application and restore it from a verified backup;
- import the supported subset of a Compose application;
- pair a suitcase;
- keep an application on a suitcase;
- verify readiness and leave;
- deploy and create apps offline;
- return and rejoin;
- add/remove an app replica;
- recover a lost suitcase;
- resolve row, file, schema, and release conflicts.

### Reference

- blueprint and `ApplicationSpec` schema;
- PostgreSQL component lifecycle profile, credentials, backups, restore, and major upgrades;
- catalog publishing, signing, compatibility matrix, and support policy;
- control-event and data-reconciliation protocols;
- artifacts and retention;
- offline build behavior;
- security and certificate model;
- networking and mDNS;
- hardware guidance;
- CLI/API reference;
- troubleshooting by suitcase state.

Architecture diagrams should show authority and data flow, not only processes. The built-in docs
must themselves remain available on the suitcase.

## Implemented integration plan and release evidence

These phases were the internal engineering gates for the `codex/v1-integration` release train, not
separately shipped previews, betas, or public schema versions. Their software work is integrated;
the checklists below remain as design provenance and regression/acceptance coverage. Imperative
“work” items describe what the integration implemented, while physical-device, real-trip,
abrupt-power, thermal, and soak items describe evidence that must be attached to a release or exact
target support claim. They do not place the implemented v1 graph, runtime, Catalog, Suitcase,
reconciliation, or recovery contracts back into roadmap status.

### Phase 0 — Validate the foundation

Purpose: retire the highest technical risks before schema and product commitments spread.

Work:

- define the restricted `deploy.local/v1` YAML schema, canonical JSON normalization/digest, retained
  source/spec artifacts, and deterministic UI exporter/semantic patch;
- compile today's unversioned one-container `deploy.json`, the v1 `deploy.yaml`, a catalog blueprint,
  and the supported Compose subset into the same normalized `ApplicationSpec` without legacy
  behavior changes;
- prototype immutable application revision ancestry, repository/UI optimistic concurrency, drift
  convergence, and stale-base rebase/replace/cancel handling;
- prototype typed configuration declarations, encrypted secret resolution, application/site scopes,
  environment/file projection, missing-value start gates, configuration digests, and rotation of an
  affected component;
- prototype graph change planning for create/update/restart/roll/migrate/retain/delete, including a
  resource-key rename that is explicitly reported as destructive remove/create;
- prototype transactional graph installation, health-gated traffic, generated secret bindings, and
  failure rollback/quarantine;
- prototype the three catalog validation blueprints: simple volume, Home Assistant Container, and an
  Nginx/`web ×2`/worker/migration/PostgreSQL fixture;
- prototype stable component services, health-aware endpoint pools, fixed/manual instance counts,
  connection draining, and a no-downtime rolling release with one injected bad instance;
- prototype profiled PostgreSQL component creation, private binding, logical export, destructive mutation,
  verified restore, migration job, and explicit major-version upgrade boundary;
- import a representative Compose file through a strict subset and produce a complete unsupported
  and security-review report;
- publish prototype `suitcase-core` and volume-helper images for `linux/amd64` and `linux/arm64`;
- implement the one-command launcher and generated Docker Compose configuration;
- validate Docker Engine on Linux and Docker Desktop on macOS/Windows, including restart, upgrade,
  resource limits, port collisions, and Docker-daemon-unavailable states;
- run application containers as siblings through the host Docker API and document/enforce the
  root-equivalent Docker-socket trust boundary;
- validate named-volume creation, helper-container snapshot/analyze/restore, and recovery after
  interrupted Docker/Desktop restarts without relying on a shared host path or Btrfs;
- test published-port access, native/host-helper mDNS, TLS trust, existing LANs, and user-enabled
  macOS/Windows hotspots; prototype automatic AP mode only on a validated Linux adapter/driver;
- implement the pre-purchase capacity planner and measure build, image, backup, restore, boot,
  dashboard, power, and thermal performance across constrained and recommended-capacity `amd64` and
  `arm64` targets;
- test invalid/no-network clock behavior;
- verify the Node 26 Session Extension used by the core image and its binary changeset fixtures;
- run the portability analyzer against representative SQLite, upload, cache, media, and opaque
  volumes;
- build classifier fixtures for empty-but-later-writing volumes, container-root writes, custom
  writable/read-only mounts, Docker-socket side effects, architecture mismatch, missing hardware,
  required remote services, and local app dependency chains;
- validate a temporary replica with read-only root/read-only stateless volumes, explicit tmpfs, and
  denied home/internet access;
- create a shared SQLite/filesystem checkpoint `B`, diverge home plus two suitcase branches, and
  reconcile them in different return orders;
- exercise independent inserts, same-row updates, deletes, integer-key collisions, constraints,
  foreign keys, virtual tables, and schema mismatch;
- prototype the three-way file-manifest merge and keep-both conflict behavior;
- prototype resumable content-addressed artifact transfer;
- benchmark portable quiesced checkpoints and fixed/content-defined chunking with representative
  SQLite, media, and mixed-file volumes; evaluate Btrfs only as an optional Linux provider;
- audit all state paths for `DEPLOY_DATA_DIR`;
- produce low-fidelity fleet topology, one-component and complex application graph, resource drawer,
  data-lineage, portability-report, suitcase-readiness, away, and conflict screens.

Gate:

- YAML, legacy JSON, UI, catalog, and Compose-subset inputs produce the same deterministic normalized
  graph and lifecycle behavior; YAML formatting/comments/key order do not change the digest;
- exporting a UI-authored graph produces valid `deploy.yaml` and a semantic patch; committing an
  equivalent repository revision clears drift, while a stale source revision cannot overwrite a UI
  revision without an explicit replace;
- unresolved required values block only the affected dependency closure with a precise setup form;
  secret bytes never appear in YAML, canonical specs, diffs, events, logs, or support exports;
- changing a display label preserves identity, while changing a logical resource key is planned as
  remove/create with explicit data-loss/retention impact;
- the same PostgreSQL image uses the ordinary component executor with or without a profile; attaching
  the profile changes only validated lifecycle capabilities and promises;
- all three blueprint fixtures install transactionally, become healthy, back up, restore, upgrade,
  restart, and uninstall on every claimed target class;
- Home Assistant is admitted only on tested Linux Docker Engine targets and exposes its exact host
  networking, privilege, storage, device, and Container-edition limitations;
- the PostgreSQL fixture receives a verified portable export and restore but is never classified as
  generic disconnected multi-writer data;
- the scaled fixture distributes traffic only to two ready instances, remains serving/degraded when
  one fails, replaces it, and returns to `2/2` without restarting PostgreSQL;
- a failed new instance leaves the old endpoint set serving; a migration job runs exactly once and
  rolling overlap is allowed only with an explicitly compatible schema contract;
- the UI distinguishes process redundancy, node spread, and remaining Nginx/database single failure
  points;
- Compose import never silently drops a field and never grants host/device/security capabilities
  without review;
- `deploy suitcase target start` reaches unpaired setup without a repository checkout, SSH, or OS
  image on supported macOS, Linux, and Windows hosts;
- targets at the planner's calculated minimum and recommended profiles run their admitted
  representative applications for 24 hours and survive host/container restart;
- planner output identifies RAM/storage contributors, confidence, and unknown evidence; actual
  target probes confirm the estimate or downgrade only the unsupported readiness promise;
- both OCI architectures pull by digest, create a unique first-start identity, and keep state in
  named volumes;
- each tested platform reports its true discovery/network capability and exposes a working offline
  access URL on an existing LAN or user-enabled hotspot;
- a forced disconnect/power cycle loses no acknowledged local change or healthy release;
- clean SQLite/file changes from home and two suitcase branches converge regardless of return order;
- row/path conflicts retain every branch and are never silently resolved as data loss;
- the analyzer accepts supported schemas, explains risky ones, and blocks unsupported mutable state;
- an empty volume is never classified stateless without runtime enforcement, and unknown evidence
  fails closed only for the affected promise;
- the same app can be ready to use but not ready to develop, with the exact missing build evidence;
- interrupted transfers and duplicate changesets resume or replay safely;
- the team approves the ownership and UX decision register below.

### Phase 1 — Application graph, fleet identity, and reconciliation foundation

Purpose: make today's one-container application and single-coordinator data model safe to extend.

Work:

- add fleet, home site, and stable application IDs through migrations;
- preserve existing names and URLs;
- persist immutable application revisions, parent/origin metadata, source/canonical spec artifacts,
  configuration declarations/value revisions, and graph change plans;
- ship the restricted v1 YAML parser/schema, canonical normalizer/digester, legacy `deploy.json`
  compiler, and full-manifest/patch exporters;
- implement repository/UI/catalog/offline-site revision ancestry, optimistic concurrency, drift
  states, and explicit rebase/replace/cancel commands;
- add components, non-runnable resources, optional component lifecycle profiles, bindings,
  lifecycle jobs, and normalized-spec identity;
- add typed required/default configuration, application/site scope, encrypted secret or ordinary
  value storage, environment/file projection, resolution gates, configuration digests, rotation,
  and affected-subgraph restart planning;
- add execution scopes for components/jobs and access/durability/consistency-group semantics for
  volumes; reject topologies that violate declared attachment or side-effect rules;
- make every graph mutation use a previewable transactional planner with stable identity matching,
  remove/create key-change semantics, data/backup/downtime impact, and destructive acknowledgement;
- add component placements, ephemeral instances, stable services, endpoint membership, rollout, and
  drain state;
- migrate every existing deployment to one web component plus its current routes and managed
  volumes without changing user-facing behavior;
- make placement, health, logs, backups, capacity, and application deletion operate on the complete
  graph while preserving a simple one-component UI;
- add graph summary/query APIs, required/optional/degraded dependency semantics, critical-path status
  propagation, and correlated app/component/resource events;
- evolve the edge route projection from one backend host/port into a health-aware component endpoint
  set with atomic membership changes, request selection, supported affinity, WebSocket handling, and
  connection draining;
- make existing app URLs resolve stable application IDs while preserving name aliases and deep links;
- add release authority/epoch/generation and site-local release fields;
- add site, app-replica, fleet-event, sync-cursor, artifact, transfer, and materialization records;
- add release-candidate identity, base generation, state, and artifact records;
- add reconciliation profiles, data changesets, checkpoints, blob references, conflicts, and replica
  acknowledgement records;
- add release-scoped classification reports, structured findings/evidence, validation proofs, and
  site-scoped readiness certificates;
- add local resource samples, workload assumptions, capacity plans, evidence confidence, and
  predicted-versus-measured target results;
- retain volume snapshot lineage for backups and **Follows one site** applications;
- implement the content-addressed store and verification API;
- implement quiesced snapshot capture and portability-report persistence;
- create versioned event schemas and projectors;
- route distributed mutations through transactional command handlers;
- keep telemetry outside the event stream;
- expose a read-only topology API;
- fix data-directory consistency.

Gate:

- existing deployments migrate without URL/runtime changes;
- every migrated application can export an equivalent `deploy.yaml`; its normalized artifact can
  rebuild the application projection without reading legacy configuration rows;
- UI and repository edits round-trip without secret disclosure or silent last-writer-wins loss;
- the same runtime path executes a current source project, normalized multi-component project, and
  blueprint-created graph;
- deleting/restarting one application cannot accidentally affect another application's private
  service or volume;
- missing required configuration cannot start an affected component, site-scoped values gate only
  the relevant materialization, and rotating one secret restarts only its dependent closure;
- per-instance, once-per-site, and writer-site-only jobs execute at their declared scope under
  restart/failover tests; no UI or docs claim fleet-wide exactly-once while disconnected;
- single-writer/read-only-many/shared-writers attachment checks and ephemeral/rebuildable/durable
  deletion rules fail closed with an explicit change plan;
- fixed component scaling, failure replacement, and rolling release preserve minimum-ready traffic,
  run migrations once, and never route to an unready/wrong-release instance;
- every distributed control mutation produces one replayable semantic event;
- replay into an empty projection produces equivalent logical app state;
- checkpoints and changesets remain pinned until every live replica acknowledges a newer base;
- legacy one-coordinator and node tests remain green.

### Phase 2 — Curated catalog and component lifecycle profiles

Purpose: deliver one-click applications without creating a second deployment or operations model.

Work:

- implement blueprint schema validation, signatures, digest pinning, trust/support tiers,
  compatibility metadata, and release deprecation/blocking;
- add catalog browse/detail/preflight UI and exact graph/security/capability preview;
- implement transactional install/retry/upgrade/rollback/uninstall with retain/delete-data choices;
- add supported customization, drift detection, local derivation, and detach-from-catalog flows;
- implement generated secrets, private component discovery, bindings, and one-shot lifecycle jobs;
- ship the first per-application PostgreSQL lifecycle profile, portable logical export, verified
  restore, backup retention, migration gating, and explicit major-version upgrade flow;
- implement strict Compose import into a reviewable normalized spec;
- build multi-architecture compatibility CI for install, restart, backup, restore, upgrade,
  uninstall, offline start, and privilege/capability assertions;
- show every installed catalog application in the ordinary Apps, topology, backup, and capacity
  surfaces;
- ship the progressive application Overview/Runtime/Data/Traffic/Releases/Activity/Settings model,
  semantic dependency graph, site overlay, resource drawer, and accessible tree/table equivalent;
- make graph/settings edits create immutable UI revisions, preview the exact runtime/data plan, and
  offer complete `deploy.yaml` plus parent-relative patch export with **Not yet in source** status;
- generate typed setup/configuration forms from manifest declarations, show resolution/site scope,
  rotate secrets without revealing them, and gate activation on required values;
- render a scaled component as one `ready/desired` graph group with instance/node/release drill-down,
  manual scale, drain/replace, rolling-restart, placement-spread, and failure-domain explanations;
- migrate current Build/Requests/Resources/Logs/Terminal views into graph-aware application views
  while retaining compatible deep links;

Gate:

- a new administrator installs each validation blueprint from the UI without editing YAML or using
  a terminal;
- an install becomes visible/routable only after all required services, jobs, and health checks pass;
- failure leaves no falsely healthy app and presents an explicit retry, retained-data, or cleanup
  decision;
- upgrades use pinned artifacts, preserve a verified recovery point, and respect declared rollback
  compatibility;
- a PostgreSQL-backed developer app and catalog app use the same service, binding, backup, and
  placement code;
- the UI never collapses install, target, offline, suitcase, and reconciliation compatibility into
  one supported badge;
- a UI-created or catalog-created application can be exported into a repository as v1 YAML without
  losing graph, configuration declarations, lifecycle, data, or placement intent; resolved values
  remain server-side;
- one-container applications remain as simple as the current page, while the PostgreSQL fixture
  exposes its complete graph, root-cause health, scoped logs/terminal, consistency-group backup, and
  site materialization without container-level navigation leaking into the main IA.

### Phase 3 — Pair and operate Docker suitcase targets

Purpose: create each suitcase once and make it a normal fleet site on supported Docker hosts.

Work:

- add suitcase discovery, pairing, site credentials, capabilities, and revocation;
- configure the suitcase default data policy, access-mode acknowledgement, and security profile
  during pairing;
- ship `deploy suitcase target start|stop|status|upgrade|rollback` and inspectable Docker Compose
  output with immutable image resolution, health-gated A/B activation, and automatic restoration;
- add portable supervisor and the four runtime roles;
- add the named-volume provider and narrowly scoped helper-container lifecycle;
- implement per-site sync cursors, checkpoint negotiation, and artifact replication;
- add offline user projection and delegated certificate identity;
- stage current and rollback deploy.local releases;
- implement suitcase detail/readiness UI;
- evolve Nodes into the initial Sites/topology view;
- add Docker host/resource/network/storage diagnostics and explicit capability degradation;
- add platform launchers for macOS, Linux, and Windows plus startup/restart integration;
- add published-port, mDNS/host-helper, TLS trust, and host-hotspot readiness guidance.

Gate:

- a fresh Docker target pairs without SSH, repository checkout, or OS reflash;
- pairing cannot complete without a recorded default data policy; unattended/API omission resolves
  to no data sync;
- Docker/Desktop restart and host power loss preserve pairing and resume sync;
- two independently paired suitcase identities remain distinct and can synchronize through home;
- home shows trustworthy role/version/storage/readiness data;
- revoked identity cannot synchronize;
- the same release runs on validated `amd64` and `arm64` hosts through the multi-architecture image.

### Phase 4 — Replicated applications and continuous readiness

Purpose: make **Keep on suitcase** real while still connected at home.

Work:

- add the application portability control and volume portability analyzer;
- implement the capability rule engine, temporary validation replica, offline dependency probe, and
  dependency-closure evaluation;
- show table/path findings and require confirmation for **Reconcile with conflicts** policies;
- add per-app defaults and per-suitcase overrides for automatic, manual, and no data sync;
- create the initial shared checkpoint and reconciliation profile;
- add an active replica to every selected suitcase without disabling the home replica;
- resolve required configuration per selected site, encrypt allowed application-scoped values to
  each suitcase identity, and require site-scoped values locally without placing them in release
  artifacts;
- reuse the existing migration pipeline to seed runtimes and data from the verified checkpoint;
- synchronize release candidates, control events, changesets, checkpoints, and missing blobs while
  docked;
- implement immutable snapshot manifests, chunk negotiation, reconstruction, tree verification, and
  periodic recovery backups;
- compute runtime/build readiness and blockers;
- run target-local no-network validation builds for the current dependency graph;
- show replica placement, schema compatibility, checkpoint lag, and conflicts on app, overview,
  activity, and site pages;
- continuously invalidate only affected readiness checks when release, configuration, schema, path,
  secret, dependency, or suitcase capability inputs drift;
- keep **Follows one site** available for unsupported volumes.

Gate:

- a supported SQLite app runs and accepts writes at home and on a docked suitcase;
- changes made at either replica reconcile into a verified shared checkpoint;
- automatic policy reconciles continuously, manual policy transfers nothing until **Sync now**, and
  no-sync policy never sends application data;
- an unsupported volume receives a precise report and cannot accidentally enable multi-site writes;
- `deploy` targets the current site-local replica and publishes a candidate for other sites;
- a suitcase cannot become **Ready offline** with a missing, invalid, expired, or undecryptable
  required value; secret rotation invalidates only dependent readiness/materialization evidence;
- **Ready offline** is reproducible after restart and catches missing artifacts/data.

### Phase 5 — Away mode and independent operation

Purpose: unplug and continue using deploy.local normally.

Work:

- implement home-network/presence recognition and gated edge activation;
- activate the validated access mode when away: existing LAN, user-enabled host hotspot, or a
  supported native Linux access point;
- advertise portable `.local` routes only when the target has proven native/host-helper discovery;
- serve local dashboard/API/docs/auth entirely from suitcase;
- accept lifecycle/config/deploy commands for each site-local replica;
- let home and suitcase activate independent compatible releases and retain them as candidates for
  other replicas;
- let home, Suitcase A, and Suitcase B continue accepting SQLite records and uploaded files from
  their local users;
- enforce writer-site-only side effects and per-site job leases while disconnected; expose any
  explicitly accepted duplicate site-local scheduler/webhook behavior;
- preserve manual branches without auto-applying them and keep no-sync namespaces explicitly local;
- support offline-created applications and alias conflict preparation;
- retain control events, branch bases, quiesced snapshots, release artifacts, and uploaded blobs;
- require target-local no-network builds and display dependency-cache limitations;
- add away-mode UI/CLI context and local recovery controls;
- add A/B portable platform upgrades.

Gate:

- unplug requires no preceding software action once readiness is green;
- on the configured offline LAN or host hotspot, the advertised URL and suitcase apps resolve and
  pass TLS without internet; validated Linux AP targets additionally require no travel router or
  manual hotspot step;
- a source change can deploy successfully with the tested offline-ready dependency graph;
- a second administrator can deploy a compatible release and continue using the home replica;
- both disconnected sites can insert database records and upload files without contacting home;
- once-per-site jobs run at most once for their site/idempotency key, writer-site-only jobs do not
  execute on non-authoritative replicas, and no component implies a disconnected fleet singleton;
- a new self-contained app can be created offline;
- repeated power/network loss does not lose the previous healthy release;
- home-only applications remain unaffected.

### Phase 6 — Multi-site reconciliation and conflicts

Purpose: reunite the graph safely.

Work:

- implement cursor/base negotiation, changeset exchange, artifact resume, and control-event
  projection;
- enforce per-replica sync policies during negotiation and expose pending manual summaries without
  transferring no-sync data;
- import offline-created apps;
- implement SQLite diff/apply against staging checkpoints with structured conflict collection;
- implement three-way uploaded-file manifest reconciliation and keep-both naming;
- validate merged databases with integrity, foreign-key, schema, and application health checks;
- publish verified merged checkpoints and distribute them to every connected replica;
- reconcile suitcases returning in different orders from older bases;
- synchronize, compare, promote, supersede, and discard release candidates independently of data;
- fast-forward opaque single-site volume snapshots into verified recovery copies;
- synchronize activity, build logs, backups, and chosen telemetry aggregates;
- implement duplicate-name resolution;
- implement lost-replica removal, restore, schema divergence, row/file conflict, and quarantine flows;
- add security quarantine and protocol compatibility handling;
- perform repeated dock/away/rejoin cycles under fault injection.

Gate:

- ordinary rejoin needs no user action and is idempotent;
- non-conflicting database records and files from home and multiple suitcases converge;
- same-row, same-key, path, delete/update, constraint, and schema conflicts preserve all evidence and
  require the declared policy or an administrator decision;
- Suitcase A may reconcile first and Suitcase B later without requiring A to return again;
- all release candidates and referenced artifacts appear at home in order;
- interrupted rejoin resumes without duplication or loss;
- candidates based on stale generations cannot silently replace other site-local releases;
- lost-replica removal clearly states and enforces the last adopted checkpoint boundary.

### Phase 7 — Product integration, Home recovery, and release hardening

Purpose: prove the complete architecture is understandable, recoverable, and safe to ship as one
deploy.local 1.0 cutover.

Work:

- complete the structured topology overview and Sites information architecture;
- deliver the homepage detachment-seam story;
- rewrite docs and onboarding around the application graph;
- add command-palette and activity support for suitcase concepts;
- finish accessible mobile/table fallbacks;
- harden one-command Docker setup, signed multi-architecture images, update/rollback, diagnostics,
  support bundle, SBOM, provenance, and platform compatibility CI;
- implement encrypted, versioned Home recovery bundles containing the control-plane projection,
  canonical specs/revision ancestry, fleet CA/secret-store recovery material, site trust/revocation,
  artifact/checkpoint inventory, policies, and lineage boundaries;
- add recovery-bundle creation, offline verification, scheduled freshness/retention, restore onto a
  clean replacement Home, and controlled re-adoption of existing suitcases;
- rehearse the additive database cutover: snapshot legacy state, compile all legacy apps, compare
  shadow projections, switch admin/CLI/edge/runtime together, and retain a tested rollback/recovery
  boundary through the soak period;
- run real-trip, lost-suitcase, destroyed-Home, stale-source, secret-rotation, graph-rename, and
  interrupted-upgrade drills;
- define the v1 compatibility/support matrix and local-by-default telemetry;
- produce one release candidate from `codex/v1-integration`, install it on the Home server, and soak
  the complete workload before the first npm/public release.

Gate:

- a new user can explain fleet/site/node/suitcase after onboarding;
- pairing, portability, readiness, offline deploy, and rejoin pass documented end-to-end tests;
- destroying Home and restoring the latest verified bundle onto another host preserves fleet
  identity, application revisions, aliases, CA trust, secret decryption, site revocations, desired
  releases, backup/checkpoint inventory, and data-lineage boundaries;
- two existing suitcases authenticate to the replacement Home, reconcile from their last-known
  cursors without becoming a second fleet, and require explicit review for any stale authority or
  lineage conflict;
- every legacy application preserves its URL, data, secrets, route, runtime behavior, and rollback
  path through the coordinated cutover and soak period;
- the marketing promise matches measured product behavior;
- no critical open data-loss or identity issues remain.

### Later expansions

- policy/metric-driven component autoscaling after fixed counts and capacity admission are proven;
- authenticated cross-node private service networking and failure-domain-aware component spread;
- profiled PostgreSQL standby/failover topologies with explicit recovery-point objectives;
- laptop OCI builder;
- native Linux automatic-access-point helper and validated adapter matrix;
- signed flashable/installer appliances for exact boards or x86 configurations where demand and
  complete-system value justify the support burden;
- stateless mirrored apps;
- suitcase sites containing multiple nodes;
- richer application-specific data replication adapters;
- direct peer-to-peer suitcase reconciliation without home as the exchange hub;
- optional managed upstream internet sharing while the suitcase access point remains active;
- app-aware replication integrations for databases that support it;
- encrypted hardware-backed unlock where supported.

## Suggested code ownership map

This is an architectural direction, not a required exact file list.

- `server/schema.ts` and Drizzle migrations: applications, components, resources, catalog records,
  identities, sites, events, artifacts, and materialization.
- `server/application-spec.ts`: restricted v1 YAML parsing, versioned normalized graph, validation,
  canonical JSON/digest, legacy JSON/catalog/Compose compilers, and redacted rendering/export.
- `server/application-revisions.ts`: immutable ancestry, origins, source convergence, optimistic
  concurrency, semantic diffs, and full-manifest/patch export.
- `server/application-config.ts`: typed declarations, scope/value resolution, configuration digests,
  environment/file projection, start gating, and affected-subgraph invalidation.
- `server/application-plan.ts`: stable identity matching, key-change remove/create semantics, and
  ordered semantic impact plans.
- `server/application-runtime.ts`: private networking, ordered lifecycle,
  health-gated activation, transactional rollback, and deletion.
- `server/component-runtime.ts`: desired/actual instance reconciliation, placement, health,
  replacement, drain, fixed scaling, and rolling-release state machine.
- `server/service-routing.ts`: stable component services, authenticated endpoint discovery,
  ready/draining membership, selection/affinity, and atomic edge route-pool projection.
- `server/catalog/`: blueprint validation/signatures, trust/support policy, release resolution,
  preflight, installation, upgrades, drift, derivation, and Compose import.
- `server/component-profiles/postgres.ts`: provisioning, roles/bindings, health, logical
  export/restore, retention, and version transitions behind a generic lifecycle-profile interface.
- `server/application-jobs.ts`: execution scopes/leases, idempotency, init/migration/restore job
  state, logs, retries, and rollout gates.
- `server/secrets.ts`: generated encrypted secrets, component projections, rotation, and redaction.
- `server/home-recovery.ts`: encrypted fleet bundle export/verification, control-plane restore,
  secret/CA recovery, artifact inventory, replacement-Home activation, and suitcase re-adoption.
- `server/fleet-events.ts`: versioned event append, verification, and projection.
- `server/release-authority.ts`: release epoch/generation, promotion admission, and recovery.
- `server/content-store.ts`: digest paths, pins, verification, retention.
- `server/data-checkpoints.ts`: quiesced branch snapshots, checkpoint lineage, acknowledgement, and
  retention.
- `server/volume-providers/`: named-volume helper backend first; optional native Linux/Btrfs backend
  behind the same checkpoint interface.
- `server/suitcase-classifier.ts`: capability-vector rule engine, evidence/findings, dependency
  closure, invalidation, and readiness certificates.
- `server/offline-validation.ts`: temporary contained replica, no-network runtime/build probes, and
  representative health checks.
- `server/portability-analyzer.ts`: volume inventory, SQLite schema analysis, compatibility report,
  and profile versioning.
- `server/sqlite-reconcile.ts`: helper orchestration, diff/apply, conflict collection, validation,
  and merged-checkpoint publication.
- `server/file-reconcile.ts`: file manifests, three-way merge, keep-both conflicts, and blob
  references.
- `server/site-sync.ts`: pairing-independent control/data sync state machine and cursors.
- `server/data-sync-policy.ts`: policy admission, per-replica overrides, transition workflow,
  pending summaries, and no-sync lineage isolation.
- `server/site-identity.ts`: site keys, request authentication, rotation, revocation.
- `server/materialization.ts`: runtime/build readiness computation.
- `server/suitcase-capacity.ts`: selected-graph RAM/storage model, observation windows, growth and
  overlap assumptions, confidence, explanations, candidate comparison, and post-pair validation.
- `server/release-candidates.ts`: site-local releases, compatibility, comparison, and promotion.
- `server/volume-sync.ts`: opaque-volume backups, manifests, chunks, reconstruction, and recovery
  cursor.
- `server/portable/`: supervisor role, mode detection, local projection, edge gating.
- `server/edge/runtime.ts` and mDNS: site-aware advertisement ownership.
- `server/edge/routes.ts`, HTTP proxy, and upgrade proxy: route to component endpoint sets instead of
  one deployment port; health-aware selection, retries, affinity, and draining.
- `server/api.ts`: split large new domains into mounted handlers rather than extending one file.
- `bin/deploy.js`: thin suitcase/topology commands, Docker target lifecycle, and endpoint context;
  extract reusable executor code before portable runtime duplicates it.
- `app/components/dashboard/application-graph/`: deterministic semantic layout, graph nodes/edges,
  site overlays, resource drawer, accessible dependency tree/table, and status propagation UI.
- `app/components/dashboard/`: topology/site/suitcase/readiness and aggregate application-status
  components.
- `app/routes/dashboard/detail/`: migrate the current deployment/container tabs into graph-aware
  Overview, Runtime, Data, Traffic, Releases, Activity, and Settings views while keeping old deep
  links valid.
- `app/routes/dashboard/`: catalog, suitcase planner/candidate comparison, Sites and suitcase
  details, and placement/authority integration.
- `app/routes/home.client.tsx`: application-graph and detachment narrative.
- `app/routes/docs/`: concepts, suitcase workflows, architecture, security, troubleshooting.
- `docker/suitcase/`: multi-architecture core/helper Dockerfiles, Compose template, health checks,
  entrypoints, and release metadata.
- `scripts/`: Docker launcher/install, service, release staging, support bundle, and later appliance
  image automation.
- `appliance/common/`: common Debian package/layer, first-boot service, systemd units, networking,
  storage, recovery, and diagnostics.
- `appliance/raspberry-pi/`: `rpi-image-gen` configuration and validated board manifests.
- `appliance/armbian/`: Armbian extension/configuration and exact Orange Pi board manifests.

## Testing strategy

### Unit tests

- normalized-spec validation, canonicalization, stable IDs/digests, schema upgrade, and identical
  output from equivalent developer/catalog inputs;
- graph dependency order, cycle rejection, health admission, rollback, retained-data quarantine, and
  application-scoped deletion;
- desired/actual instance reconciliation, stable service selection, readiness membership, affinity,
  drain deadlines, replacement, minimum-ready, surge/unavailable, and rollback invariants;
- failure-domain calculation for instance/node/service/data single points and site-specific count
  overrides;
- blueprint signature, digest pin, support/version range, deprecation/blocking, drift, detach, and
  derivation rules;
- Compose subset translation with complete blocking/review/ignored-field reporting;
- generated-secret redaction/rotation and least-privilege binding projection;
- lifecycle-profile capability/version admission, unsupported-operation rejection, and identical
  ordinary component runtime behavior for profiled versus unprofiled images;
- PostgreSQL version admission, role isolation, backup metadata, restore verification, migration
  gates, and explicit rejection of generic multi-writer suitability;
- stable identity migration;
- release authority admission, epoch/generation monotonicity, and stale candidate rejection;
- classifier weakest-dimension behavior, unknown handling, evidence precedence, input invalidation,
  stable finding IDs, and remediation;
- stateless proof with enforced read-only root/volumes and tmpfs scratch paths;
- dependency-closure handling for local apps, required remote services, optional degradation, and
  site-encrypted secrets;
- SQLite header/WAL recognition and deterministic schema fingerprinting;
- analyzer classification for primary keys, nullable keys, integer-key collision risk, constraints,
  triggers, foreign keys, virtual tables, unknown mutable files, and exclusions;
- SQLite changeset generation, duplicate apply, conflict types, and staging validation;
- base/home/suitcase file-manifest rules for create, update, delete, rename, and keep-both;
- checkpoint lineage, replica acknowledgement, removal, and retention safety;
- volume manifest determinism, data sequence, lineage, chunk verification, and tree reconstruction;
- event validation, signatures, versioning, duplicate replay, and gap detection;
- deterministic projection;
- artifact digest, pinning, partial transfer, and corruption handling;
- readiness blocker calculation;
- capacity-plan runtime/build overlap, observation-window aggregation, storage growth/retention,
  safety headroom, confidence propagation, rounding, and contributor explanations;
- readiness-certificate digest/provenance, latest-sync freshness, and automatic departure-manifest
  freezing;
- data-sync policy defaults/overrides, option admission, manual pending state, no-sync isolation, and
  guarded policy transitions;
- network-mode state machine;
- alias collision behavior;
- retention and garbage collection safety.

### Integration tests

For the application graph and catalog:

- install the simple, Home Assistant, and PostgreSQL fixtures from signed blueprint releases;
- fail each transaction boundary and prove that no partial graph receives traffic or a healthy
  installation record;
- start components in dependency order, run migrations exactly once, rotate bindings, and retain
  logs/evidence;
- route sustained HTTP and WebSocket traffic through Nginx/`web ×2`/PostgreSQL; verify only ready
  endpoints receive new connections and request/log attribution retains instance identity;
- kill one web instance, remain serving/degraded at `1/2`, replace it, and return to `2/2` without
  restarting or duplicating the database;
- scale `1 → 2 → 3 → 1`, drain removals, preserve in-flight requests, and reject counts outside
  capacity/blueprint/site bounds;
- roll a compatible release with surge and zero unavailable; inject bad readiness and prove the old
  endpoint set remains active; run its migration exactly once;
- require recreate/maintenance for incompatible schema transitions and block ordinary writable
  SQLite from multiple component instances;
- back up, destructively mutate, restore, and health-check a profiled PostgreSQL component;
- upgrade from every supported prior blueprint release and enforce the rollback compatibility
  boundary;
- detach and derive a catalog app without changing its current runtime/data;
- import supported Compose fields and block/review all security-sensitive or unsupported fields;
- prove private database ports and secrets never appear in public routes or ordinary API output;
- classify the whole graph so a stateless web component plus PostgreSQL never becomes a stateless
  application.

Run home and two suitcases with separate temporary `DEPLOY_DATA_DIR` values:

- collect representative home metrics, plan a selected portable graph, compare candidate specs,
  pair constrained/recommended targets, and verify predicted-versus-measured readiness behavior;
- pair, independently identify, remove, and revoke replicas;
- synchronize interrupted event batches;
- transfer/resume/corrupt artifacts;
- analyze a volume, create the initial checkpoint, and seed multiple replicas;
- prove that empty managed volumes, container-layer writes, writable bind mounts, Docker-socket
  access, and required remote databases cannot receive a false sync-ready result;
- reclassify after release/schema/path/dependency drift without invalidating unrelated capabilities;
- disconnect all three sites, accept rows/uploads on each, and reconcile them in both suitcase return
  orders;
- verify that automatic replicas reconcile, manual replicas only summarize until **Sync now**, and
  no-sync replicas transfer zero application database/file content;
- switch automatic ↔ manual safely; require reset/import when switching no-sync back into a shared
  lineage; preserve every displaced namespace as a backup;
- collide primary-key inserts, update the same row, delete versus update, violate constraints, and
  preserve each conflict branch;
- reject missing-primary-key, virtual-table, opaque-file, and incompatible-schema cases unless an
  explicit safe classification exists;
- disconnect, deploy different compatible releases, create an app, reconnect, and converge data
  separately from release promotion;
- build a candidate at home while a suitcase is away, then compare/promote it on rejoin;
- advance a stale home recovery snapshot using only missing chunks;
- remove a lost replica and quarantine its late-returning branch;
- transfer a **Follows one site** volume with a final delta and rollback on failed health check;
- protocol version skew;
- disk-full and invalid-clock behavior;
- edge/mDNS ownership transitions.

### End-to-end target and hardware release evidence

This matrix qualifies exact builds, operating systems, architectures, and hardware targets. It is
release/support evidence over the implemented product, not a list of missing product code:

- macOS Docker Desktop on Apple Silicon and, while supported, Intel;
- Linux Docker Engine on `amd64` and `arm64`;
- Windows Docker Desktop with Linux containers on `amd64`;
- multiple hardware forms at the capacity planner's calculated minimum and recommended profiles,
  including at least one `amd64` and one `arm64` target;
- estimate on the home hub, enter candidate specifications, pair the target, and compare predicted
  versus measured RAM, storage, build time, thermal, and networking readiness;
- named-volume persistence through Docker/Desktop upgrades, restart, resource pressure, and abrupt
  host power loss;
- published-port baseline, port-collision handling, every discovery capability level, and CA trust;
- existing LAN and user-enabled macOS/Windows hotspot operation without internet;
- automatic Linux access point and no-travel-router operation only on explicitly validated hardware;
- cold boot without internet;
- unannounced unplug and repeated power loss;
- runtime/build readiness for Node, static, and custom Docker examples;
- fixed multi-instance routing, failure replacement, connection draining, and rolling release on
  both `amd64` and `arm64`, including a constrained suitcase count override;
- catalog install/backup/restore/upgrade/uninstall for each claimed target/architecture;
- Home Assistant Container installation on Linux Docker Engine with host networking plus optional
  device mapping, and an explained compatibility block on Docker Desktop;
- developer and catalog PostgreSQL graphs with migration, disk pressure, interrupted backup,
  verified restore, and **Follows one site** suitcase behavior;
- ordinary SQLite application plus uploaded files, without a deploy.local data library;
- two-suitcase branch simulation with distinct physical targets and architectures;
- multi-hour offline deployment session;
- return/rejoin during an interrupted upload;
- CA trust from macOS, Linux, iOS, and other intended clients;
- 24-hour docked and 24-hour away soak;
- thermal, memory, disk, and build latency measurement.

Raspberry Pi, Orange Pi, and other ARM boards join this matrix as deploy targets after their exact
model/storage/network configuration is validated; they are not a prerequisite for the Docker v1
implementation.

### UI tests

- catalog browse/filter/detail, target compatibility, graph/security preview, install progress,
  failure recovery, upgrade, detach/derive, and uninstall data-retention choice;
- multi-component application graph and profiled-service health without overwhelming the
  one-component app view;
- deterministic graph layout across release changes, required/optional/degraded edge semantics,
  critical-path root-cause rollup, and site overlay/compare behavior;
- scaled component group `ready/desired` summary, stable layout under instance churn, instance/node
  drawer, manual scale/drain/rollout progress, and honest failure-domain labels;
- every graph node/edge/status/action through the dependency-ordered accessible tree/table;
- explicit site/component selection for logs and terminal, app-wide correlated logs, and preserved
  legacy deep links;
- application actions preview the complete affected dependency/data closure and never restart,
  move, or delete a service component implicitly;
- screen-reader rendering of trust versus install/lifecycle/target/offline/suitcase/data promises;
- all suitcase states and blockers;
- large topology and long names;
- keyboard-only topology navigation;
- screen-reader relationships/status;
- mobile nested representation;
- reduced-motion detachment transition;
- conflict and destructive recovery confirmation;
- stale/offline status that does not falsely look healthy.

## Operational release-evidence targets

These targets are measured for release/support claims. The code paths exist independently of
whether a particular physical target has accumulated enough evidence to advertise the measurement.

- Away-mode dashboard and routes available within 30 seconds of joining a non-home LAN.
- Existing healthy suitcase replicas survive a control-process restart.
- A scaled route never selects an unready/drained instance; one instance failure remains serving
  when minimum-ready holds and a compatible rolling release preserves acknowledged connections.
- No committed semantic event is lost after acknowledged local deployment success.
- No acknowledged SQLite/file change is silently lost; every incompatible overlap becomes a
  structured conflict.
- Every transfer can resume without retransmitting verified completed content.
- A merged checkpoint publishes atomically only after database, manifest, and health verification.
- Readiness changes within 10 seconds of a local blocker appearing.
- Rejoin needs no user input when schemas match and all data changes are conflict-free.
- Home-only applications incur no availability dependency on suitcase state.
- Topology remains usable with at least 100 apps and 20 nodes through grouping/progressive detail.

## Risks and mitigations

| Risk                                                  | Mitigation                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application graph becomes a Kubernetes-style hairball | Use deterministic semantic lanes, hide labels/resources that lack lifecycle state, collapse the one-component case, and provide task-oriented tabs plus a tree/table. |
| Dependency failure produces alert cascades            | Propagate health through required/optional edges and present the root failing resource once with affected dependants.                                                 |
| App-level action has surprising resource scope        | Preview the dependency/data closure, define per-resource lifecycle policy, and keep service/component actions explicitly scoped and advanced.                         |
| Lifecycle profile becomes a hidden runtime primitive  | Keep image execution/placement/health/logs generic; profiles expose versioned capabilities and emit ordinary jobs/resources rather than special scheduler branches.   |
| `×2` creates a false high-availability promise        | Report process count, ready minimum, node spread, proxy/database single points, and tested failure domains separately.                                                |
| Rolling release corrupts shared schema/session state  | Require declared rollout/schema compatibility, run migrations once, support recreate/maintenance, and require shared/stateless/affinity session semantics.            |
| Cross-node private service leaks onto the LAN         | Use authenticated site-private service endpoints; keep the dependency closure node-local until that transport is implemented and verified.                            |
| Catalog becomes a parallel orchestrator               | Compile every blueprint and developer config into one normalized spec and use one runtime, lifecycle, backup, placement, and classifier path.                         |
| “Supported” overpromises upstream behavior            | Scope support to the exact recipe/version/configuration and show trust, lifecycle, target, offline, suitcase, and data promises separately.                           |
| Mutable upstream image changes silently               | Resolve and sign exact digests; announce/test a new catalog release before updating an installation.                                                                  |
| Catalog update breaks durable data                    | Require declared migrations, pre-upgrade recovery points, restore tests, compatibility boundaries, health-gated commit, and retained rollback data.                   |
| Blueprint grants dangerous host access                | Preview and separately approve host networking, devices, privilege, Docker socket, host mounts, and public ports; sign/test the reviewed spec.                        |
| Profiled service creates cross-app blast radius       | Own PostgreSQL per app initially, isolate network/roles/volume/backup, and defer shared clusters to an explicit tenancy design.                                       |
| PostgreSQL is mistaken for offline multi-writer       | Classify the complete graph and allow only one-writer, no-sync, connected-standby, or app-adapter modes; never equate transfer cadence with safety.                   |
| Compose import silently changes semantics             | Support a strict subset, normalize into an inspectable spec, and report every translated, ignored, review-required, or blocking field.                                |
| Schema analysis creates false confidence              | Define **Safe** as lossless/conflict-detecting, inspect every mutable path, stage every merge, and require an app health check.                                       |
| SQLite session limitations omit data                  | Require declared non-null primary keys, block unsupported tables/files, and test the compiled helper rather than assuming host SQLite features.                       |
| Integer primary keys collide after cloning            | Rate the app **Reconcile with conflicts**, detect same-key inserts, retain both rows, and recommend UUID/site-unique keys.                                            |
| Schema migration strands an offline replica           | Fingerprint every release/schema and block incompatible fleet rollout until replicas rejoin or are explicitly removed.                                                |
| Constraint/trigger behavior changes merge meaning     | Apply only to staging, collect constraint conflicts, run integrity/foreign-key/application checks, and retain the prior checkpoint.                                   |
| Multi-suitcase lineage grows without bound            | Pin bases until every live replica acknowledges a successor; compact only after acknowledgement or explicit removal.                                                  |
| Reconciliation or transfer is too slow                | Use atomic snapshots, row changesets, manifest-first missing-blob transfer, and benchmark realistic SQLite/media volumes in Phase 0.                                  |
| Planner understates target requirements               | Use high-water windows and overlap rules, expose confidence/unknowns, add headroom, and require actual target probes before readiness.                                |
| Home measurements do not represent travel load        | Let admins declare concurrency/trip horizon, retain multiple observation windows, and show how changing assumptions changes the result.                               |
| Storage growth exhausts the suitcase while away       | Project selected-app growth, include branch/backup/build-cache policy, reserve a free-space floor, and alert before departure.                                        |
| Low-power target builds feel too slow                 | Benchmark on the actual target; prewarm BuildKit, serialize builds, and deny only development readiness when runtime remains safe.                                    |
| New dependencies fail offline                         | Separate runtime/build readiness and test the current lockfile without network.                                                                                       |
| Docker socket compromise controls the host            | Treat the target as a trusted deploy machine, warn during setup, minimize exposed helpers, and publish a precise threat model.                                        |
| Docker/Desktop stops or changes behavior              | Pin minimum versions, use restart policies, detect daemon/resource-saver states, test upgrades, and preserve all durable state in named volumes.                      |
| Named-volume checkpoint is inconsistent/corrupt       | Quiesce the app, create immutable verified checkpoints through helpers, retain the prior base, and rehearse restore.                                                  |
| Host networking or `.local` differs by platform       | Use published ports as baseline, test capability levels, show the concrete URL, and fail readiness honestly when the promised route is absent.                        |
| Host hotspot requires a manual OS action              | Detect and explain the single host action; reserve automatic AP mode for validated native Linux integrations.                                                         |
| Split `.local` advertising at home                    | Gate on home-network recognition and signed edge presence; never auto-activate on a remembered home LAN.                                                              |
| Stolen suitcase exposes secrets                       | Scope user/secret projection, provide site revocation/loss UI and a locked profile, and document the threat model.                                                    |
| Root CA compromise                                    | Keep the root key home and delegate a constrained suitcase intermediate identity.                                                                                     |
| Existing name primary key causes app collision        | Introduce immutable app IDs before accepting offline app creation.                                                                                                    |
| Clock drift breaks TLS                                | Provide hardware/persisted clock guidance, readiness checks, sequence-based ordering, and recovery UI.                                                                |
| `server/api.ts` and CLI become monoliths              | Split new site/data-sync handlers and extract executor functionality before adding portable roles.                                                                    |

## Approval decision register

Confirmed decisions below describe the implemented v1 contract. Later changes require an explicit
contract revision rather than an implicit implementation deviation.

### D1 — Replica ownership

**Confirmed:** Turning on **Keep on suitcase** adds an active runtime/data replica and keeps it
continuously synchronized while docked. For **Syncs across sites** applications, home and every
selected suitcase remain writable. For **Follows one site** applications, the UI requires an
explicit single writable placement.

Why: the suitcase stays ready to grab while home users and other suitcases are not forced offline.

### D2 — Behavior while away

**Confirmed:** Home and suitcase replicas continue serving local users and accepting compatible
data while disconnected. Show each branch base, lag, release, and last contact. Runtime commands
affect only the local replica; fleet-destructive commands wait for acknowledgement or explicit
replica removal.

Why: both sites are intentionally active, so there is no hidden failover or unreachable remote
control dependency.

### D3 — First-release scope

**Confirmed:** One home site and multiple paired suitcase sites are represented in the first-release
protocol and data model. The first runtime artifact is one signed multi-architecture Linux OCI image
that runs through Docker Engine/Desktop on macOS, Linux, and Windows. Hardware remains user-chosen
from workload-derived capacity and compatibility evidence; there is no dedicated physical reference
model. Home remains the durable exchange hub when suitcases rejoin.

Why: multiple detached branches are a core use case, while Docker makes the suitcase role available
without coupling the protocol to one board or waiting for an appliance-image program. Deferring
peer-to-peer exchange still bounds the first release.

### D4 — Away activation

**Confirmed:** The background loop marks the local target **Away** after repeated Home exchange
failures, keeps probing without blocking local apps, and returns it to **Docked** after a successful
authenticated exchange. Manual Docked/Away/Rejoining controls remain available for diagnosis and
override. Network-fingerprint-specific edge suppression is capability-gated rather than inferred.

Why: preserves “unplug and go” while reducing duplicate mDNS authority during home restarts.

### D5 — Offline build promise

**Confirmed:** The suitcase target must build independently; another computer is not required for
the first release. Guarantee current runtime offline and advertise build readiness separately for
the current dependency graph. Do not promise uncached new internet dependencies.

Why: this is technically honest while supporting the normal iteration loop.

### D6 — Commands on both sides while disconnected

**Confirmed:** Every connected administrator may deploy to their site-local replica and that
immutable release becomes a candidate for the other sites. Home and suitcases also accept local
SQLite/file data changes when the portability report allows multi-site reconciliation. Runtime
commands affect only the local replica; destructive fleet commands and incompatible schema changes
remain blocked until affected replicas acknowledge or are explicitly removed.

Candidate promotion is explicit in the first release, even when its base is still current. A stale
candidate can never silently replace another site's active release. Data reconciliation is a
separate process and must not depend on selecting a release winner.

Why: both people can keep building and using the application without coupling code rollout to data
convergence.

### D7 — Portable certificate authority

**Confirmed:** The fleet root CA private key remains at Home. Pairing signs a constrained suitcase
intermediate so new offline app names receive valid leaf certificates without copying the root key.

Why: pre-issued leaf certificates would prevent meaningful offline creation/iteration; copying the
root key would make suitcase loss a fleet-wide trust compromise.

### D8 — Security profile default

**Confirmed:** Version 1 uses automatic container restart and an explicit physical-loss warning,
with prominent lost-device revocation/recovery. It does not claim powered-off volume encryption or
a locked appliance profile; those require host-specific key custody that the portable Docker target
cannot honestly provide.

Why: unattended recovery and strong powered-off theft protection are in direct tension on portable
target hardware.

### D9 — Telemetry synchronization

**Confirmed:** Sync semantic activity, builds, backups, and request aggregates. Keep raw
request/container logs and captures local by default.

Why: protects storage and rejoin time while retaining useful fleet history.

### D10 — Product language

**Confirmed:** Use **Suitcase** as the product noun and **Ready offline**, **Docked**, **Away**,
and **Rejoining** as visible states. Use shard/replica only in technical documentation.

Why: the vocabulary explains the benefit without exposing implementation mechanics.

### D11 — Offline users

**Confirmed:** Project administrator users only in the first release. The suitcase stores their
password verifiers and issues site-local sessions.

Why: it gives the intended operators full offline access without solving distributed fine-grained
authorization in the first release.

### D12 — Default data compatibility path

**Confirmed:** Do not require a deploy.local data SDK. Analyze a quiesced volume snapshot,
use built-in SQLite changesets plus three-way file manifests where structurally safe, and expose
optional `deploy.yaml` annotations for exclusions and conflict policies. The legacy compiler maps
supported old annotations into the same normalized contract. Custom adapters are an
escape hatch, not the normal path.

Why: ordinary applications should become portable because their durable state is understandable,
not because their authors adopted a proprietary mutation API.

### D13 — Automatic data conflict policy

**Confirmed:** Automatically publish a merged checkpoint only when every change applies and
all validation checks pass. For same-row/key/path, delete/update, constraint, or schema conflicts,
retain every branch and require the configured keep-both policy or an administrator decision.

Why: routine independent inserts and uploads should converge without ceremony, while ambiguous
intent must never be guessed silently.

### D14 — Application classification and readiness

**Confirmed:** Classify the exact release with a non-numeric capability vector and one named
mechanism: **Stateless replica**, **File replica**, **SQLite replica**, **Adapter-managed replica**,
**Follows one site**, or **Not suitcase compatible**. Separately issue per-suitcase **Data ready**,
**Ready to use offline**, and **Ready to develop offline** states backed by versioned evidence.

Unknown evidence fails closed only for the affected promise. An empty volume never proves
statelessness; write containment must be enforced or validated. **Ready to go** requires use and the
selected data policy's readiness, while development readiness remains explicit.

Why: this prevents one vague badge or percentage from hiding a fatal blocker, while preserving useful
fallbacks and precise remediation.

### D15 — Per-suitcase data sync policy

**Confirmed:** Give each suitcase app an administrator-controlled **Data sync** policy:
**Automatic sync**, **Manual sync**, or **No data sync**. Require an explicit suitcase default during
pairing, let new app replicas inherit it, and allow per-app overrides. If no choice exists in an
unattended/API flow, fail safe to no data sync. Scope this setting to application databases/files;
release and platform synchronization remain separate.

Automatic and manual require the same reconciliation compatibility—manual timing cannot make an
unsafe schema mergeable. No data sync creates an acknowledged site-local namespace that neither
joins nor blocks the shared lineage. Switching a no-sync namespace back to sync requires an explicit
reset/import choice; never invent a missing common base.

Why: this gives administrators control over bandwidth and merge timing, supports intentionally local
apps, and keeps the automatic “grab and go” path simple without weakening compatibility guarantees.

### D16 — Docker suitcase packaging

**Confirmed:** The minimum supported suitcase artifact is one signed multi-architecture Linux OCI
image plus a matching volume-helper image, launcher, and inspectable Compose configuration. It runs
through Docker Engine on Linux and Docker Desktop on macOS/Windows, creates sibling application
containers through the host Docker API, and stores portable state in Docker named volumes.

Flashable images and native installers are later deploy-target conveniences, not a first-release or
beta gate. When added, they share the same protocol/runtime and validate exact hardware rather than
claiming generic SBC support.

Why: this lets an existing computer become a suitcase immediately, keeps one application/runtime
artifact across `amd64` and `arm64`, and avoids binding the product to volatile board pricing and
board-specific boot/network support.

### D17 — Hardware selection and capacity

**Confirmed:** Do not choose one reference suitcase device or fixed retail RAM/storage tier. The home
hub sizes the selected portable application graph and reports minimum/recommended RAM, persistent
storage, architecture, networking, and other capabilities before purchase or pairing. The
administrator chooses the device; actual target probes make the final readiness decision.

The estimate includes observed concurrent runtime peaks, the requested offline-build profile,
reconciliation/helper overlap, current data and artifacts, cache/rollback/checkpoint/backup policy,
projected trip-horizon growth, and safety headroom. It shows evidence quality and remains explicit
about unknowns.

Why: a runtime-only suitcase with a few small apps and a development suitcase with large builds are
different products of the same graph. Workload evidence answers “8 GB or 16 GB?” better than a board
preference, while keeping hardware choice with the administrator.

### D18 — One application graph and curated blueprints

**Confirmed:** The runtime uses a versioned normalized `ApplicationSpec` with ordinary runnable
components, non-runnable resources, optional component lifecycle profiles, bindings, jobs, health,
lifecycle, and placement. Developer configuration and curated blueprints compile into that graph. A
catalog application becomes an ordinary deploy.local application
immediately after installation; it does not use a parallel Compose or marketplace runtime.

Why: multi-service developer apps, one-click third-party apps, capacity planning, and suitcase
dependency closure all need the same missing abstraction. Building it once prevents support,
security, and lifecycle behavior from drifting between product surfaces.

### D19 — Component lifecycle profiles and disconnected database boundary

**Confirmed:** PostgreSQL runs as an ordinary application component with the first supported
lifecycle profile around it: private networking, generated bindings, explicit migrations,
portable logical export, verified restore, and version-aware upgrades. An unprofiled PostgreSQL image
still runs but receives only generic container/volume capabilities and an explicit unmanaged label.
v1 does not offer generic active-active suitcase reconciliation for PostgreSQL; it classifies the
database as **Follows one site**, **No data sync**, or **Adapter-managed
reconciliation** when an application owns merge semantics.

Why: operating a database well and merging two offline database branches are different capabilities.
This gives complex apps a genuinely one-click lifecycle without making a false data-convergence
promise.

### D20 — Catalog support and compatibility language

**Confirmed:** Support is scoped to signed, immutable blueprint releases and exposes separate trust
plus install, lifecycle, target, offline, suitcase, and data-reconciliation results. The bundled v1
validation set is deploy.local-signed and evidence-scoped. Local/private is represented as a trust
boundary; the public Community tier is not enabled by the launch allowlist.

Why: one “supported” badge would collapse upstream responsibility, host compatibility, privileged
requirements, and data safety. A small maintained catalog is more trustworthy than a large list of
unverified Compose files.

### D21 — Docker Compose relationship

**Confirmed:** A strict Compose subset imports into a reviewable normalized application
specification. The importer reports every translated, ignored, review-required, and blocking field
and requires explicit approval for host/device/security access. Arbitrary Compose is not retained as
deploy.local's runtime source of truth, and v1 does not claim full Compose compatibility.

Why: Compose is useful input and ecosystem leverage, but its breadth and host escape hatches are too
large to define one-click support, portable data semantics, or long-term deploy.local behavior.

### D22 — Admin application object and graph views

**Confirmed:** The logical application is the durable admin object, with progressive disclosure of
its components and resources. Fleet topology, application dependencies, and data lineage are linked
views. The admin uses a deterministic semantic application graph with required/optional edges,
critical-path status propagation, site materialization overlays, scoped resource drawers, and an
equivalent dependency-ordered representation. One-container apps retain a compact page rather than
a forced graph canvas.

Application navigation is consolidated around **Overview**, **Releases**, **Logs**, **Terminal**,
**Traffic**, **Data**, **Activity**, and **Settings**. Runtime graphs and component controls live in
Overview and the component-specific surfaces; logs and terminals remain deep-linkable with explicit
site/component context. Application actions preview and operate on their full dependency/data
closure.

Why: administrators think “Paperless is down” or “move Notes to my suitcase,” not “container 4 is
unhealthy.” The graph explains root cause and scope without exposing orchestration internals as the
primary navigation model.

### D23 — Same-site component scaling and service routing

**Confirmed:** Each scalable component has a fixed desired instance count, minimum ready count,
rollout strategy, and optional per-site override. A public component routes through the
deploy.local edge's stable health-aware endpoint set by default; Nginx is an explicit app component
only when its behavior is part of the application. v1 ships manual/fixed scaling,
readiness-gated membership, connection draining, failure replacement, and rolling/recreate/
maintenance release strategies rather than autoscaling.

Migrations run once as versioned jobs, and rolling overlap requires a declared compatible shared
schema/session contract. Writable SQLite remains single-instance unless an application proves safe
serialization. Runtime reporting separates process count, node spread, and proxy/database failure
points. Private dependency closures remain node-local until authenticated cross-node service
networking is implemented; managed database ports are never exposed merely to spread web instances.

Why: `nginx → web ×2 → PostgreSQL ×1` is a normal application shape, but `×2` only proves web-process
redundancy. Stable service routing and explicit failure-domain semantics let deploy.local provide
useful rolling availability without making a false end-to-end HA claim.

### D24 — Public v1 application manifest

**Confirmed:** Make `deploy.yaml` with `apiVersion: deploy.local/v1` and `kind: Application` the
human-authored, portable, source-controlled graph format. Parse a restricted deterministic YAML 1.2
profile, compile it into canonical JSON, and identify the normalized `ApplicationSpec` by digest.
Retain the source and normalized spec as artifacts; treat relational component/resource rows as
rebuildable projections. Keep today's unversioned `deploy.json` unchanged as legacy one-container
compiler input and fail explicitly when both repository files exist.

Why: version 1 needs one durable public contract that can survive export, import, recovery, and
suitcase replication. YAML is reviewable for multi-component graphs, while canonical JSON prevents
formatting/comments/key order from changing runtime identity.

### D25 — UI/repository revision ancestry and drift

**Confirmed:** Every graph edit creates an immutable revision with a parent digest and origin. The
admin UI edits the same v1 graph, may apply its revision immediately, and exports either a complete
`deploy.yaml` or parent-relative patch for the repository. Mark UI/catalog/offline revisions **Not
yet in source** until a repository revision normalizes to the same digest. Reject stale-base source
deployments with explicit rebase, replace, or cancel choices; do not create permanent UI-managed and
repository-managed application classes.

Why: the UI remains a useful visual editor while Git remains the optional durable copy. Revision
ancestry prevents last-writer-wins loss when another administrator or disconnected site is also
building the application.

### D26 — Declared configuration and secret resolution

**Confirmed:** Put typed configuration declarations, validation, scope, and consumer wiring in
`deploy.yaml`; keep resolved values server-side. Support application/site scope, environment/file
projection, encrypted secret values, generated component credentials, separate configuration
digests, and value rotation. Build preparation may continue, but gate each component and dependent
route/job until its required values resolve and validate for that site. Never include secret bytes
in specs, revision patches, artifacts, logs, events, or support bundles.

Why: v1 replaces arbitrary environment-variable guesswork with an explicit application contract,
lets the UI generate trustworthy setup forms, and makes suitcase readiness prove required secrets
exist locally without putting them in source control.

### D27 — One graph change planner and stable identity

**Confirmed:** YAML, UI, catalog, Compose-import, and offline-candidate changes use one
previewable transactional planner. Stable logical mapping keys identify components/resources;
display labels are freely renameable. In public v1 a key change means remove/create; state is
preserved by keeping the stable key. The planner classifies configuration-only, in-place, restart,
rolling, creation, migration, retention/quarantine, destructive, and unsupported effects, including
capacity, downtime, backup, data, and suitcase impact.

Why: a relational diff or naming heuristic cannot distinguish “rename my database volume” from
“delete it and make an empty one.” One planner gives CLI, UI, catalog upgrades, and offline
promotion the same safety and rollback boundary.

### D28 — Execution scopes and volume access contracts

**Confirmed:** Give side-effecting components/jobs explicit `per-instance`, `once-per-site`, or
`writer-site-only` execution scopes and do not claim fleet-wide exactly-once while sites can
disconnect. Give volumes independent `single-writer`, `read-only-many`, or validated
`shared-writers` access plus `ephemeral`, `rebuildable`, or `durable` lifecycle semantics and
consistency groups. Block materializations that violate either contract; writable SQLite defaults
to single-writer.

Why: replica count, site count, and job ownership are different dimensions. These declarations stop
a scale operation from duplicating migrations/webhooks or mounting a single-writer database through
multiple writable instances.

### D29 — Home disaster recovery

**Confirmed:** Make Home replaceable from an encrypted, versioned, independently verified recovery
bundle. Recover fleet identity/CA, secret-store access, application specs/revision ancestry, aliases,
site identities/revocations, authority generations, policies, artifact/checkpoint/backup inventory,
and data-lineage boundaries. Restore onto a clean Home and re-adopt existing suitcases only after
identity and lineage validation; never treat raw re-pairing as equivalent recovery.

Why: Home is the first-release exchange hub and authority coordinator. Suitcase recovery is not a
complete product if losing Home also loses trust, desired state, secret access, or the ability to
reconcile retained branches.

### D30 — One deploy.local 1.0 integration release

**Confirmed:** All phases are integrated on `codex/v1-integration` as internal engineering gates for
one coordinated deploy.local 1.0 cutover. Independently reviewable changes, additive migrations,
shadow validation, and a tested recovery boundary are preserved. The complete
Home/Suitcase/recovery acceptance run and soak qualify the release installed on the Home server;
they do not imply the integrated subsystems are still proposals.

Why: the manifest, graph runtime, admin model, catalog, suitcase, reconciliation, and recovery model
only deliver their product promise together. Internal gates keep that integrated change debuggable
and protect the home installation used for final dogfood.

## Implemented approval resolutions

The narrower Phase 0 questions are resolved in the integrated v1 implementation:

1. Every site-authored release arrives at Home as a reviewable candidate, even when its base is
   current. Home imports its immutable specification and artifacts but does not activate it until an
   administrator explicitly promotes it.
2. The portability analyzer distinguishes stateless, file, SQLite, adapter-managed,
   follows-one-site, and incompatible mechanisms. Only a completely clean validated row/file merge
   publishes automatically; ambiguous row, path, constraint, or schema conflicts retain every
   branch for policy or administrator resolution.
3. The public manifest and UI export use human logical map keys and do not emit opaque runtime object
   IDs. The v1 planner never infers a stateful rename: changing a logical resource key is
   remove/create. Preserve state by retaining the stable key; a future public move syntax would be an
   explicit schema addition rather than a naming heuristic.
4. There is no undeclared-environment escape hatch. Values are declared through YAML/UI with type,
   scope, sensitivity, and consumers so validation, export, rotation, and Suitcase readiness remain
   complete.
5. Home recovery uses an administrator-supplied passphrase of at least 12 characters. The encrypted
   bundle contains the secret-store recovery material; create, verify, rehearsal, and clean-directory
   restore are separate recorded operations, and passphrases are never returned by the API.
6. Writer-site jobs run only when the authoritative writer site is known and matches the local site.
   They remain blocked rather than independently electing a writer while authority is unavailable.
7. The bundled launch Catalog is deploy.local-signed and evidence-scoped. The trust model represents
   Local/private publishers, but the public Community tier is not enabled by the launch allowlist.
   Compose import accepts only the strict reviewed subset and reports every unsupported or
   security-sensitive field.

## Definition of deploy.local 1.0

This is one release acceptance contract. The subsections are test suites for the same release
candidate, not independently shipped foundations.

### Manifest, revision, and graph-change foundation

The public v1 contract is successful when this scenario works reliably:

1. Upgrade an existing unversioned `deploy.json` application without changing its URL, volumes,
   secrets, route, runtime behavior, or repository; export its inferred `deploy.yaml` and reproduce
   the same normalized specification digest from that file.
2. Reformat/reorder/comment the YAML and prove the canonical digest does not change; introduce a
   semantic graph edit and prove that it does.
3. Add PostgreSQL, a migration job, required username/password declarations, and a second web
   instance through the visual editor. Preview the exact graph/data/runtime plan, apply the UI
   revision, and receive a valid complete YAML export plus parent-relative patch containing no
   resolved values.
4. Attempt to deploy a repository edit based on the revision before the UI change. deploy.local
   detects the stale base and requires rebase, explicit replace, or cancel; committing the exported
   equivalent clears **Not yet in source** without an unnecessary restart.
5. Leave a required value unresolved and observe the build complete while the affected component,
   migration, and route remain precisely gated. Set/rotate application- and site-scoped secrets,
   verify only consumers restart, and prove no secret bytes appear in artifacts, events, diffs,
   logs, or support bundles.
6. Rename only a volume display label with no runtime/data operation; change its logical key and see
   a remove/create warning with the exact durable-data impact rather than an inferred rename.
7. Reject web ×2 with two writable attachments to a single-writer SQLite volume, accept a safe
   PostgreSQL-backed shape, and prove per-instance, once-per-site, and writer-site-only work executes
   at the declared scope across restart, disconnect, and rejoin.

### One-click application foundation

The catalog/application-graph foundation is successful when this scenario works reliably:

1. An administrator opens Catalog, selects a signed release, chooses Home, and sees target,
   lifecycle, offline, suitcase, and data compatibility as separate results.
2. A simple app installs without YAML. The preview and resulting Application page name its image,
   route, volume, privileges, backup policy, support scope, and pinned release without forcing a
   graph canvas.
3. A developer adds a PostgreSQL service and migration job to a source app; a catalog fixture uses
   the same ordinary component executor plus PostgreSQL lifecycle profile and binding implementation.
   The Application page expands into the same stable semantic graph and separates runtime, data,
   traffic, and release operations.
4. Both PostgreSQL apps receive private networking, generated credentials, health gating, portable
   logical exports, destructive restore tests, storage/capacity accounting, and explicit upgrades.
5. The fixture runs `nginx 1/1 → web 2/2 → PostgreSQL 1/1`; the graph groups web instances, exposes
   the remaining Nginx/database single points, stays serving at `web 1/2`, replaces the failed
   instance, and rolls a compatible release while its migration runs exactly once.
6. A database failure appears once as the root cause with every affected component; logs and a
   terminal open only after choosing the intended site/component.
7. An injected migration or health failure publishes no route and preserves a precise retry,
   rollback, and retained-data decision.
8. Home Assistant Container installs on a compatible Linux Docker Engine target only after its host
   network, privilege, `/config`, and optional device requirements are accepted. Docker Desktop
   receives an explained block rather than a failed install.
9. The complete Home Assistant and PostgreSQL graphs are evaluated for a selected suitcase. Both may
   be runtime-portable, but neither receives generic multi-writer reconciliation status.
10. A supported Compose file imports into the same graph with no silent field loss; an unsupported
    or security-sensitive field produces a visible block or approval.
11. A catalog upgrade uses immutable artifacts and a verified recovery point; detach/derive retains
    the current app and data without pretending curated upgrades still apply.

### Suitcase and multi-site foundation

The first release is successful when this scenario works reliably:

1. On the home hub, a user selects the intended portable apps, offline-build requirement, load,
   retention, and trip horizon. The planner explains minimum/recommended RAM and storage, important
   contributors, confidence, and unknowns without naming a required retail device.
2. The user chooses a compatible Mac, Linux, Windows, x86, or ARM64 device, runs
   `deploy suitcase target start`, and pairs it without SSH, repository checkout, or OS reflash; the
   actual probes confirm or precisely revise the plan. The same fleet can pair a second suitcase
   identity on a different host/architecture.
3. They turn on **Keep on suitcase** for an ordinary SQLite notes app with uploaded files and no
   deploy.local data library.
4. The analyzer explains its tables and paths, assigns a reconciliation capability, and produces an
   initial verified checkpoint.
5. Home and each selected suitcase become **Runtime ready** and **Build ready**, with matching schema,
   checkpoint state, named-volume persistence, and an evidence-backed local access mode.
6. They unplug without running a departure command and use the configured offline LAN, host hotspot,
   or validated Linux access point without internet; the advertised URL and TLS continue working.
7. Home and suitcase users independently create notes and upload files; each site remains locally
   available.
8. Home and suitcase users may each deploy a compatible code release through the normal CLI; each
   release remains an explicit candidate for the other sites.
9. Suitcase A returns first. Its clean records/files reconcile automatically into a validated merged
   checkpoint while all replicas continue running.
10. Suitcase B later returns from the older base. Its independent changes also merge, and a
    deliberate same-row/path collision appears with both versions preserved for an administrator
    decision.
11. The resolved checkpoint, uploads, new apps, build history, and backups distribute to every
    connected replica; release promotion remains a separate explicit choice.
12. A second app in manual mode reports pending changes and transfers nothing until **Sync now**; a
    no-sync utility keeps its suitcase data local and sends no database/file content home.
13. An unsafe schema or opaque mutable file is blocked from multi-site mode but remains usable in
    **Follows one site** mode with verified recovery snapshots.
14. Repeating the trip after power loss and interrupted synchronization produces the same correct
    result without manual database or file repair.

### Home-server cutover and disaster recovery

The integrated release is ready for the Home server only when this scenario works reliably:

1. Create and independently verify an encrypted recovery bundle, legacy database/volume backup, and
   rollback instructions before upgrade.
2. Install the single v1 release candidate, migrate legacy apps additively, compare the compiled
   shadow graph, and switch admin, CLI, edge routing, and runtime reconciliation together.
3. Run the complete existing Home workload through restart, backup/restore, deploy, UI edit/export,
   catalog install, suitcase detach/rejoin, and a meaningful soak period without URL, data, secret,
   certificate, or behavior regression.
4. Destroy the Home control-plane state and restore the verified bundle on a clean replacement host.
   Recover the same fleet/application identities, revision/spec history, aliases, CA, secret-store
   access, desired releases, policies, revocations, artifact/backup inventory, and checkpoint
   lineage.
5. Reconnect two existing suitcases from different cursors. They authenticate to the recovered fleet,
   preserve local candidate/data branches, reconcile clean evidence, and surface stale
   authority/lineage conflicts without silently re-pairing or creating duplicate application IDs.
6. Restore one application backup, rotate a recovered secret and fleet credential, revoke a lost
   suitcase, and export every active application as valid `deploy.yaml`.
7. Keep the pre-upgrade recovery boundary until all acceptance checks and the soak pass; only then
   publish deploy.local 1.0 as the first npm/public compatibility contract.

Together these scenarios are the product promise. Work that does not advance them should not delay
the one integrated release.
