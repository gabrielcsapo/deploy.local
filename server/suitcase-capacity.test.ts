import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let specs: typeof import('./application-spec.ts');
let evidence: typeof import('./suitcase-capacity.ts');
let portability: typeof import('./portability.ts');
let siteId: string;

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-suitcase-capacity-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?capacity-evidence=${Date.now()}`);
  multisite = await import(`./multisite.ts?capacity-evidence=${Date.now()}`);
  specs = await import(`./application-spec.ts?capacity-evidence=${Date.now()}`);
  evidence = await import(`./suitcase-capacity.ts?capacity-evidence=${Date.now()}`);
  portability = await import(`./portability.ts?capacity-evidence=${Date.now()}`);
  multisite.ensureFleetIdentity('Capacity evidence fleet');
  const pairing = multisite.createSuitcasePairing({ name: 'Measured target', createdBy: 'admin' });
  const keys = generateKeyPairSync('ed25519');
  const target = multisite.redeemSuitcasePairing({
    code: pairing.code,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    platform: 'linux',
    architecture: 'arm64',
    version: '1.0.0',
    capabilities: {
      dockerTarget: true,
      memoryBytes: 6 * GIB,
      freeStorageBytes: 100 * GIB,
      catalog: {
        catalogExecution: true,
        privilegedContainers: true,
        hostNetwork: false,
      },
    },
  });
  siteId = target.siteId;
  seedEvidence();
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function artifact(
  digest: string,
  bytes: number,
  type: string,
  architecture: string | null = 'arm64',
) {
  const now = new Date().toISOString();
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO artifacts
        (digest, type, byte_size, media_type, architecture, local_path,
         verification_status, retention_class, pin_count, created_at, last_access_at)
       VALUES (?, ?, ?, 'application/octet-stream', ?, ?, 'verified', 'release', 1, ?, ?)`,
    )
    .run(digest, type, bytes, architecture, join(root, digest.slice(-8)), now, now);
}

function seedEvidence() {
  const sqlite = store.getSqlite()!;
  const now = new Date().toISOString();
  const sourceDigest = `sha256:${'1'.repeat(64)}`;
  const imageDigest = `sha256:${'2'.repeat(64)}`;
  const checkpointManifest = `sha256:${'3'.repeat(64)}`;
  const checkpointDatabase = `sha256:${'4'.repeat(64)}`;
  const branchManifest = `sha256:${'5'.repeat(64)}`;
  const rollbackDigest = `sha256:${'6'.repeat(64)}`;
  artifact(sourceDigest, 100 * MIB, 'application-source');
  artifact(imageDigest, 400 * MIB, 'application-image');
  artifact(checkpointManifest, 10 * MIB, 'checkpoint-manifest', null);
  artifact(checkpointDatabase, 300 * MIB, 'checkpoint-database', null);
  artifact(branchManifest, 50 * MIB, 'changeset-manifest', null);
  artifact(rollbackDigest, 700 * MIB, 'application-recovery', null);

  const compiled = specs.compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: studio
components:
  web:
    build:
      context: .
    role: web
    capacity:
      ephemeralStorageBytes: ${2 * GIB}
    runtime:
      privilegedDocker: true
  worker:
    image: example/worker:1
    role: worker
    capacity:
      memoryBytes: ${256 * MIB}
      ephemeralStorageBytes: ${GIB}
resources:
  data:
    type: volume
    durability: durable
    dataRole: files
    backup:
      policy: include
      retentionCopies: 2
`);
  sqlite
    .prepare(
      `INSERT INTO deployments
        (name, username, status, app_id, desired_spec_digest, active_spec_digest,
         source_artifact_digest, image_artifact_digest, created_at, updated_at)
       VALUES ('studio', 'admin', 'running', 'app_studio_capacity', ?, ?, ?, ?, ?, ?)`,
    )
    .run(compiled.digest, compiled.digest, sourceDigest, imageDigest, now, now);
  sqlite
    .prepare(
      `INSERT INTO application_spec_revisions
        (digest, deployment_name, api_version, source, manifest_format,
         normalized_spec, created_by, created_at)
       VALUES (?, 'studio', 'deploy.local/v1', 'repository', 'deploy.yaml', ?, 'admin', ?)`,
    )
    .run(compiled.digest, compiled.canonicalJson, now);

  const sampleAt = Date.now() - 5 * 60_000;
  for (const [offset, bytes] of [
    [0, 512 * MIB],
    [30_000, 768 * MIB],
  ]) {
    sqlite
      .prepare(
        `INSERT INTO resource_metrics
          (deployment_name, cpu_percent, mem_usage_bytes, mem_limit_bytes, mem_percent,
           net_rx_bytes, net_tx_bytes, block_read_bytes, block_write_bytes, pids, timestamp)
         VALUES ('studio', 20, ?, ?, 20, 0, 0, 0, 0, 4, ?)`,
      )
      .run(bytes, 4 * GIB, sampleAt + offset);
  }
  sqlite
    .prepare(
      `INSERT INTO build_logs
        (deployment_name, output, success, duration, status, timestamp)
       VALUES ('studio', 'capacity: buildPeakMemoryBytes=1610612736', 1, 42000,
               'complete', ?)`,
    )
    .run(now);
  const cache = join(root, 'build-cache', 'studio');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'layer'), Buffer.alloc(2 * MIB));

  sqlite
    .prepare(
      `INSERT INTO volume_snapshots
        (id, app_id, authority_site_id, authority_epoch, data_sequence,
         manifest_artifact_digest, consistency_mode, logical_bytes, unique_bytes,
         verification_status, retention_class, latest_home_recovery, created_at)
       VALUES ('snapshot-capacity', 'app_studio_capacity', 'home', 1, 1, ?, 'quiesced',
               ?, ?, 'verified', 'checkpoint', 1, ?)`,
    )
    .run(checkpointManifest, 2 * GIB, 1500 * MIB, now);
  sqlite
    .prepare(
      `INSERT INTO data_checkpoints
        (id, app_id, origin_site_id, sequence, database_artifact_digest,
         manifest_artifact_digest, verification_status, acknowledgements, created_at)
       VALUES ('checkpoint-capacity', 'app_studio_capacity', 'home', 1, ?, ?,
               'verified', '{}', ?)`,
    )
    .run(checkpointDatabase, checkpointManifest, now);
  sqlite
    .prepare(
      `INSERT INTO data_changesets
        (id, app_id, origin_site_id, base_checkpoint_id, branch_manifest_digest,
         authenticated_digest, status, created_at)
       VALUES ('changeset-capacity', 'app_studio_capacity', ?, 'checkpoint-capacity', ?,
               'signature', 'pending', ?)`,
    )
    .run(siteId, branchManifest, now);
  sqlite
    .prepare(
      `INSERT INTO catalog_recovery_points
        (id, installation_id, application_name, site_id, release, spec_digest, status,
         artifact_digest, created_by, created_at, verified_at)
       VALUES ('recovery-capacity', 'install-capacity', 'studio', 'home', '1.0.0', ?,
               'verified', ?, 'admin', ?, ?)`,
    )
    .run(compiled.digest, rollbackDigest, now, now);
  sqlite
    .prepare(
      `INSERT INTO backups
        (deployment_name, filename, size_bytes, created_by, created_at, volume_paths, auto)
       VALUES ('studio', 'backup.tar.gz', ?, 'admin', ?, '[]', 1)`,
    )
    .run(GIB, now);
  sqlite
    .prepare(
      `INSERT INTO app_replicas
        (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
         pending_changesets, conflict_count, readiness, created_at, updated_at)
       VALUES ('replica-capacity', 'app_studio_capacity', ?, 'running', 'replicated',
               'automatic', 1, 2, 1, '{}', ?, ?)`,
    )
    .run(siteId, now, now);
}

describe('capacity evidence closure', () => {
  it('derives retained peaks and storage contributors, then compares the actual target probe', () => {
    const input = evidence.capacityInputFromSelection({
      selectedAppIds: ['app_studio_capacity'],
      tripHorizonDays: 14,
      offlineBuilds: true,
      projectedDailyGrowthBytes: 100 * MIB,
      retainedBackupCopies: 2,
      targetSiteId: siteId,
    });
    const plan = portability.planSuitcaseCapacity(input);
    const contributor = (name: string) =>
      plan.contributors.find((candidate) => candidate.name === name);

    assert.equal(contributor('app_studio_capacity/web runtime ×1')?.bytes, 768 * MIB);
    assert.equal(contributor('app_studio_capacity/web runtime ×1')?.confidence, 'measured');
    assert.equal(contributor('Largest serialized offline build')?.bytes, 1536 * MIB);
    assert.equal(contributor('Largest serialized offline build')?.confidence, 'measured');
    assert.equal(contributor('Build cache')?.bytes, 2 * MIB);
    assert.equal(contributor('Additional build-cache reserve')?.confidence, 'default');
    assert.equal(contributor('Checkpoints, staging, and retained conflicts')?.bytes, 360 * MIB);
    assert.equal(contributor('Verified rollback and recovery artifacts')?.bytes, 700 * MIB);
    assert.equal(contributor('Backups')?.bytes, 4 * GIB);
    assert.equal(contributor('Runtime and build scratch space')?.bytes, 3 * GIB);
    assert.ok(plan.evidenceSummary.measured >= 5);
    assert.equal(plan.evidenceSummary.observationWindow?.sampleCount, 2);
    assert.equal(plan.targetComparison?.memory.status, 'minimum-only');
    assert.equal(plan.targetComparison?.storage.status, 'recommended');
    assert.equal(plan.targetComparison?.status, 'minimum-only');
    assert.equal(plan.targetComparison?.ready, true);
    assert.equal(
      plan.targetComparison?.capabilities.find((check) => check.name === 'architecture')?.status,
      'pass',
    );
  });

  it('blocks a target probe below the calculated minimum without changing the prediction', () => {
    const sqlite = store.getSqlite()!;
    const row = sqlite.prepare('SELECT capabilities FROM sites WHERE id = ?').get(siteId) as {
      capabilities: string;
    };
    const capabilities = JSON.parse(row.capabilities);
    capabilities.memoryBytes = 3 * GIB;
    sqlite
      .prepare('UPDATE sites SET capabilities = ? WHERE id = ?')
      .run(JSON.stringify(capabilities), siteId);
    const plan = portability.planSuitcaseCapacity(
      evidence.capacityInputFromSelection({
        selectedAppIds: ['app_studio_capacity'],
        tripHorizonDays: 14,
        offlineBuilds: true,
        retainedBackupCopies: 2,
        targetSiteId: siteId,
      }),
    );
    assert.equal(plan.targetComparison?.status, 'insufficient');
    assert.equal(plan.targetComparison?.ready, false);
    assert.match(plan.targetComparison?.blockers.join('; ') || '', /memory.*below/i);
  });
});
