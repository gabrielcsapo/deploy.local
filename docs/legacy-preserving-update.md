# Groffee same-host legacy code update

Implementation and disposable testing only. No controller installation, publication,
production deployment, credentials, trust settings or live data were changed.
Combined installation candidate branch: `release/groffee-legacy-preserving-ser`,
based on serving revision `a832a5f9034390ca89d34e166d26ad716ca7a26c` plus its
byte-preserved eight working edits (`8d2f867`). The scoped compatibility change
comes from `5fd22c8f807684fb09c11d7bcd17d55897ea8fdd`; its API import conflict was
resolved by preserving both serving Docker-inspection and compatibility imports.
Serving TLS OS-CA trust, source rebuild/retry/reporting and tracked edge-cache
invalidation are retained. No generic improvements-branch replacement occurred.

Gabriel approved preparation, controller installation and Groffee deployment,
including interruption and the narrow baseline SQLite exception. Installation is
currently blocked by `sudo -n` requiring interactive administrator authentication;
the executor cannot write the service unit. Do not bypass that boundary.

## Supported boundary and choice

Use a narrow legacy code update rather than graph adoption. The current legacy
container already owns the physical database, uploads, SSH host keys and public
Git route. Graph creation would introduce empty storage and does not preserve the
existing SSH mapping; graph restore also cannot consume the old backup format.
This path retains the exact Docker settings and immutable rollback image, without
creating graph resources or changing active graph state.

Only an authenticated administrator who owns the existing canonical Groffee
legacy deployment on the coordinator may use the API. Reject active graph state,
selected suitcase replicas, topology/identity drift, missing or empty durable
data, absent host keys, unsupported mounts and competing writable containers.
Writable mounts overlapping either ancestors or descendants of the durable roots
are rejected, using physical and lexical paths. Other writers are never stopped
by this command. Operators must also quiesce host processes and jobs outside the
controller; Docker admission cannot fence unrelated host administrators.

The backup boundary is exactly `data`, `uploads`, and `.ssh-host-keys`. Relative
symlinks contained within these roots are preserved; absolute/escaping links and
parent traversal after named components are unsupported and fail closed. This
prevents chained symlinks from referring to data excluded from the backup.

The source upload still passes normal bounded-archive and application validation,
requires a single root Dockerfile web service, and builds before stopping the old
writer. Admission captures the expected container and desired graph digest and
rechecks controller identity, placement and runtime settings before maintenance.
Normal uploads/graph apply cannot bypass compatibility admission. Existing
credential, trust and security validation remain in place.

## Transaction and recovery

A persistent exclusive lock and fsynced private journal serialize update/recovery
and protect normal lifecycle operations. After building, stop and verify the old
writer; reject any other writable container immediately before backup or restore.
Create a full cold tar archive with numeric ownership/modes and content hashes,
then extract it into isolated storage and verify its inventory before activation.
Root-capable helpers use the retained trusted image, network none, readonly rootfs,
limited capabilities, and no-new-privileges. Their durable records allow recovery
to fence orphan helpers before restoring.

Start the candidate with the same bind paths, environment (including persisted
EXTERNAL_URL), network membership, Docker settings and HTTP/SSH port mappings.
Require HTTP health and unchanged backend/public SSH host fingerprints before
recording success through ordinary controller store methods. Retain the stopped
old container, immutable image and complete snapshot. Boot resumes the exact
committed container instead of recreating it from YAML.

Failed activation restores the full pre-update data and metadata and restarts the
old runtime. Restore keeps bind directory inodes and fsyncs restored files and
directories before startup. Ambiguous stop or incomplete recovery retains the
lock; it does not risk concurrent writers. Recovery also works after process death
and for stopped/unhealthy candidates. Explicit post-success rollback retains a
safety snapshot of newer data, then restores the pre-update snapshot; later writes
are lost from the active application, hence the separate data-loss acknowledgement.
Repeated completed update/recovery requests are idempotent.

## Verification evidence

Targeted unit/API tests cover real SQLite schema/data integrity, WAL and uploads,
SSH identity, ownership/modes, missing/empty data, corruption, unsupported symlinks,
permissions, concurrent admission, state drift, ambiguous stop, failed recovery,
fsync ordering, authorization, acknowledgements, stale preflight, ordinary-upload
protection and old-controller fail-closed CLI behavior.

Opt-in Docker integration uses unique disposable resources, synthetic users/keys,
random loopback ports and a real TCP proxy. It covers authenticated Git reads with
strict known-host trust, exact mounts/network/ownership, complete rollback,
stopped candidates, failed health, crashes after readiness and during root restore,
orphan-helper fencing, and CLI → authenticated API → real Docker build/update/
resume/retry/rollback with the actual Groffee release manifest. Shared-writer cases
exercise writable ancestors, symlink ancestors, descendants, readonly admission
and a writer appearing during the build, plus refusal/lock retention during
rollback followed by recovery after the writer is removed. No production writes occur.

Combined-candidate full suite: 428 tests, 420 passed, seven opt-in Docker tests
skipped and one accepted baseline failure. Typecheck and full lint pass. New
synthetic tests verify CLI trusted-CA success, rejection of unknown CA and wrong
hostname, and real RouteTable invalidation with identical backend/port. All seven real Docker cases, application/server-extra builds and five-platform
CLI builds passed on the combined candidate. The source CLI TLS fixture passes;
the native SEA binary does not execute the fixture DNS --import preload (verified
with a harmless marker), so that experimental native fixture is unsupported.
A read-only native CLI request to real deploy.local succeeds through normal OS
TLS trust and receives expected 404 from the old compatibility-incapable server. The runner uses the same test files/concurrency with
`--test-force-exit` for pre-existing retained handles.

Compatibility-only logs for the earlier run: `/tmp/task3-core-api-finish.log`,
`/tmp/task3-docker-finish.log`, `/tmp/task3-full-finish.log`,
`/tmp/task3-types-finish.log`, `/tmp/task3-lint-finish.log`,
`/tmp/task3-writer-finish.log`, `/tmp/task3-build-finish.log`,
`/tmp/task3-extras-finish.log`, `/tmp/task3-cli-finish.log`.
The full-suite unique-value-swap replay failure in
`server/data-reconciliation.test.ts:207` was independently reproduced on untouched
base `b561c209` with the same private dependencies; see
`/tmp/task3-baseline-reconciliation.log`. It is not repaired by this scoped patch.
Independent review covered writer admission, crash recovery, restore durability,
unhealthy rollback and bypass prevention; findings were fixed and regression-tested.

## Approval prerequisites: controller installation

These are proposed steps for parent review, not authorization to execute them.

1. Preserve the serving checkout at
   `/home/gabrielcsapo/Documents/deploy.local`, including its eight modified files
   and nine stashes. This branch is based on the clean improvements checkout;
   it is not a drop-in replacement for the dirty running controller. Reconcile
   the compatibility diff with those serving changes in a separate reviewed
   install candidate and rerun its checks. Do not overwrite the serving tree.
2. Resolve or explicitly accept the independently reproduced baseline test
   failure before publication/install approval. Review the final diff, independent
   review and disposable results. Build final controller/CLI artifacts with a
   clean commit stamp; include `dist/legacy-snapshot.mjs` beside the bundle.
3. Read the actual service unit/drop-ins and confirm its runtime, architecture,
   data directory and startup environment without reading credential contents.
   Pin the existing controller data directory explicitly in the candidate unit:
   `DEPLOY_DATA_DIR=/home/gabrielcsapo/Documents/deploy.local/.deploy-data`, after
   verifying that this is the actual active directory. The service generator
   does not emit this environment variable on Linux: merely changing
   WorkingDirectory can silently select empty controller state. Preserve all
   existing unit settings and save the previous unit/drop-ins/artifacts.
4. Obtain separate approval to publish/install the changed controller and CLI.
   A controller/edge restart can briefly interrupt HTTP/SSH sessions; confirm
   the approved maintenance window. It must retain the same controller state,
   public routing and deployed app. Keep the old artifacts for rollback.
5. Verify controller health and the new authenticated compatibility capability,
   then verify current Groffee health/Git routing. Use existing authenticated
   CLI state and checksum verification; do not mint credentials or change trust.

## Separately approved Groffee maintenance

From the clean Groffee release checkout
`/home/gabrielcsapo/Documents/Codex/2026-10-11/task-2/groffee-release`, verify commit
`60c55f6b49a18c560002eaee51a456b485962f3d` and the reviewed manifest.
The merged feature remains undeployed until this separate approval.

```sh
deploy legacy status -a groffee --url https://deploy.local
# Only after production-maintenance approval and writer quiescence:
deploy legacy update -a groffee --confirm-downtime --url https://deploy.local
```

Use the newly checksum-verified CLI that matches the approved controller; the
existing `/tmp/groffee-deploy-cli` has refreshed authentication but lacks this
new capability until replaced through an approved artifact update. Do not use
ordinary deploy or graph apply as a migration workaround. Quiesce application
jobs, pipeline containers and host writers first. Review status for the immutable
image, journal phase and snapshot archive/content digests. The command builds
while old Groffee remains available, then performs a cold maintenance handoff.

After success verify deployment image/source metadata, HTTP health, existing
workspace/database/upload reads, SSH fingerprint and authenticated Git SSH/HTTPS/
LFS reads. Application writes need their own approved disposable workspace.
The preserved public SSH route is port 2223. Retain all recovery artifacts.

## Approved rollback and controller reversal

If automatic rollback cannot complete, keep the service locked and quiesce the
reported external writer. Do not delete locks, start containers manually, patch
controller rows or replace live directories. Use the reviewed recovery command:

```sh
deploy legacy recover -a groffee --confirm-downtime --url https://deploy.local
# Post-success rollback restores pre-release data and loses later active writes:
deploy legacy rollback -a groffee --confirm-downtime --confirm-data-loss --url https://deploy.local
```

Verify old immutable image/config, snapshot evidence, SQLite integrity, uploads,
SSH fingerprint and Git routing after rollback. Retain the newer-data safety
snapshot; extracting it into live data is not part of this path.

Before reverting the controller, complete application recovery/rollback and verify
an unlocked old runtime. The old controller lacks these guards and must not run
against an active candidate or recovery lock. Only with separate approval restore
the previous service unit/drop-ins and artifacts, retaining the exact same
DEPLOY_DATA_DIR, then daemon-reload/restart the control plane and verify routes.
Never reset the dirty checkout, erase stashes, rsync/delete durable directories,
or alter credentials/trust as part of rollback.


## Combined candidate installation checkpoint

Combined logs: `/tmp/task3-ser-full.log`, `/tmp/task3-ser-types.log`,
`/tmp/task3-ser-lint.log`, `/tmp/task3-ser-regressions.log`,
`/tmp/task3-ser-docker.log`, `/tmp/task3-ser-build.log`,
`/tmp/task3-ser-extras.log`, `/tmp/task3-ser-cli.log`.

Private rollback checkpoint:
`/home/gabrielcsapo/Documents/Codex/2026-10-11/task-3/ser-controller-rollback-checkpoint`
(mode 0700). It preserves the actual service unit and old `dist`, all eight source
hashes, and an online consistent preinstall SQLite backup (mode 0600) verified by
`integrity_check=ok` and SHA-256
`4ab3fbb2e1a4546261cdab516348c9de057c3ef0fd658170378562d5b1e50ac3`.
No credential rows or live application contents were inspected.

The staged `90-ser-legacy-release.conf` overrides only WorkingDirectory and
ExecStart to this candidate and pins
`DEPLOY_DATA_DIR=/home/gabrielcsapo/Documents/deploy.local/.deploy-data`.
It retains root execution, existing Node v26.5.0, production environment, PATH,
restart policy and existing log destinations. No drop-in is installed yet.
All 68 migration files match the serving checkout. Controller reversal therefore
retains the same database; it does not restore stale preinstall state by default.

An administrator must perform installation only after completed checks/artifact
verification. Stop the controller, create and verify the additional cold SQLite
backup using `controller-cold-backup.mjs`, install the staged drop-in,
daemon-reload/start, and verify the unchanged Groffee container and HTTPS health.
If installation fails before the app update, remove only this new drop-in and
restart the old controller; preserve database and recovery files.

Do not invoke the Groffee update until the controller capability is verified.
The clean source release is `60c55f6b49a18c560002eaee51a456b485962f3d`.
Its production container remains `75a8a279b8f0880a8cc9a852ce770bfae8465373f24b06c55b7fedc417a00f99`
and image `sha256:a8c97b6eb4e4725ae6ae88f80dbea1f8e92422d1fc8e9ab3b51e0e9456aea61d`.
The existing public SSH listener is 2223 (backend 43055); HTTP backend is 40813.
Post-release data rollback requires separate approval: do not restore over later
writes merely because the installation/deployment was authorized.
