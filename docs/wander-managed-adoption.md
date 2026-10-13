# One-time Wander managed storage adoption

This owner/admin operation moves the existing coordinator Wander application from its two legacy binds to app-owned Docker volumes. It is deliberately limited to Wander and one reviewed graph. The scoped CI policy continues to reject host binds; this operation does not issue CI credentials or activate a pipeline.

The graph is pinned to `sha256:3f6bd9ee8b563e6d95429a6d66a9fd0bd2f5d86325f5ef5b119c23b6eed98fa1`. Its exact fixture is `server/fixtures/wander-adoption/deploy.yaml`, matching Wander companion commit `e1a2baa88146e4817cbecf45d19777a95e4b20bc`. The web component retains the root build, capacity, interfaces and public route, adds `/api/health`, and maps `/app/data` and `/app/uploads` to managed resources `data` and `uploads`. Both resources remain durable, application-owned, single-writer, backup-required volumes with the same application consistency group. No host source is permitted in this graph.

## Owner workflow

Use an owner account on the coordinator; an administrator must also own Wander. Scoped CI tokens cannot invoke this operation. HTTPS authentication and normal manifest/archive/path limits remain enabled.

```sh
deploy adopt preflight --application wander --json
deploy adopt status --application wander --json
# After a separately approved downtime window and exact source tests:
deploy adopt update --application wander --source-commit <full-clean-HEAD> \
  --source-archive-sha256 sha256:<tested-uncompressed-git-archive> \
  --idempotency-key <unique-reviewed-intent> --confirm-downtime --json
# Explicit recovery of the same operation; do not upload a different intent:
deploy adopt recover --application wander --operation <operation-id> --confirm-downtime --json
# Cancellation is permitted only before candidate startup could occur:
deploy adopt cancel --application wander --operation <operation-id> --confirm-downtime --json
```

The update preflight binds the existing application ID, immutable container/image, runtime settings, source digest and desired parent. The clean source checkout, tested Git archive digest and compressed bytes are verified before reservation. The compressed archive is retained in the normal content store so later graph recovery can resolve its source reference. Identical upload retries return the durable operation receipt; they never run adoption again. A different intent is rejected. After commit, status is historical adoption evidence; subsequent releases use the normal graph/CI surfaces.

## Preservation and interruption behavior

A private, fsynced journal reserves the same application admission boundary used by normal mutations. Pending operations suppress automatic startup, reconciliation and legacy dashboard/API/backup/restore/delete helpers. Only the claimed owner transaction may stop the old writer or run recovery helpers. Cross-worker/process recovery is serialized through SQLite; an observed worker exit releases execution ownership without releasing the reservation.

The candidate image builds before downtime. The original container then stops and its exact two data binds are fenced against overlapping writable mounts, including an ancestor `/` bind. A cold numeric-owner archive includes the complete database, SQLite WAL/SHM, media, mappings, native backups and uploads. An independent scratch restore must reproduce file inventory, ownership/modes and logical SQLite integrity/content. The original files are never opened by SQLite or rewritten by the restore rehearsal.

Fresh app-owned volumes are seeded only after journal labels and destination ownership are verified. Unrelated preexisting volumes are rejected. A complete seed interrupted before its receipt is reused after comparison. A partial seed may be replaced only in the transaction's own volumes, before candidate startup, after helpers are stopped and competing writers excluded. All copied files/directories are fsynced before seed completion. A disappeared seeded provider is rejected; graph activation cannot manufacture an empty replacement.

The candidate name is durable before Docker creation. Recovery reuses that exact container after a create-before-graph-row interruption. Only that labeled immutable candidate may write the managed providers. Original container/image/source/binds and the verified cold archives remain retained. Controller metadata promotes the normal graph on the same app ID in one SQLite transaction after health/runtime verification. Legacy helper calls remain retired after commit; graph and scoped CI updates remain available.

Failures remain fenced and require owner recovery. Before the candidate could start, cancellation restarts the unchanged original container and verifies its HTTP health. After `starting`, automatic cancellation/restore is forbidden because the candidate may have written new data. Recovery proceeds forward with the same image/providers and never rewinds data. A missing pinned candidate or changed original/provider identity requires owner investigation; there is no force/unlock endpoint. Returning to original storage after managed writes needs a separately reviewed cold capture and explicit data-loss/merge decision. No general migration or automatic reverse-copy platform is provided.

## Production prerequisites

Review and merge this controller change separately from installing it. Confirm the actual installed controller includes the scoped CI base and all serving compatibility/CA protections. Obtain an explicit controller installation approval and verify its artifact hashes, controller-state backup and restore plan; retain the previous controller build. Adoption itself needs a separate approved downtime window, exact clean Wander source/manifest digest, healthy original runtime, sufficient space for independent archives and both complete new volumes, an off-host copy of the verified cold backup, and the owner recovery commands available in a checksum-matched CLI. Verify real host filesystem/volume durability semantics and the original image remains locally available. No production adoption, controller installation, credentials, trust setup or pipeline activation is authorized by this PR.

Tests use synthetic `/tmp` controller state and uniquely labeled Docker resources. Run the physical test explicitly with `DEPLOY_WANDER_DOCKER_TESTS=1 node --test server/wander-adoption-docker.test.ts`. It verifies cold-copy continuity, startup suppression, missing-provider refusal, creation interruption recovery and retained legacy protection. Unit/API/process tests cover failures, cancellation, exact intent retries, authorization, malformed journal, SQLite/WAL, uploads and durable shared admission.
