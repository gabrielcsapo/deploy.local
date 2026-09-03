import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  GraphExecutorContext,
  GraphMaterializationResult,
  GraphRecoveryArtifact,
  GraphRecoveryPointOptions,
} from './application-graph-executor.ts';
import type { OpaqueVolumeExecutor } from './volume-sync.ts';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let volumes: typeof import('./volume-sync.ts');
let specs: typeof import('./application-spec.ts');
let homeSiteId: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-volume-sync-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?volume-sync=${Date.now()}`);
  multisite = await import(`./multisite.ts?volume-sync=${Date.now()}`);
  volumes = await import(`./volume-sync.ts?volume-sync=${Date.now()}`);
  specs = await import(`./application-spec.ts?volume-sync=${Date.now()}`);
  const fleet = multisite.ensureFleetIdentity();
  homeSiteId = fleet.homeSiteId;
  const now = new Date().toISOString();
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO sites
        (id, fleet_id, name, kind, public_key, credential_status, capabilities,
         mode, default_data_policy, access_mode, security_profile,
         readiness_summary, created_at, updated_at)
       VALUES ('site-trip', ?, 'Trip', 'suitcase', 'test-key', 'active', '{}',
               'docked', 'manual', 'existing-lan', 'isolated', '{}', ?, ?)`,
    )
    .run(fleet.id, now, now);
  for (const [name, appId] of [
    ['opaque-success', 'app-opaque-success'],
    ['opaque-failure', 'app-opaque-failure'],
    ['opaque-distributed', 'app-opaque-distributed'],
    ['opaque-restart', 'app-opaque-restart'],
    ['opaque-stale', 'app-opaque-stale'],
    ['opaque-restore-failure', 'app-opaque-restore-failure'],
    ['opaque-abort', 'app-opaque-abort'],
    ['opaque-contract', 'app-opaque-contract'],
  ]) {
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO deployments
          (name, username, app_id, data_mode, release_generation, created_at, updated_at)
         VALUES (?, 'admin', ?, 'single-site', 1, ?, ?)`,
      )
      .run(name, appId, now, now);
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, runtime_status, data_mode, sync_policy,
           shared_lineage, readiness, created_at, updated_at)
         VALUES (?, ?, ?, 'running', 'follows-one-site-writer', 'manual',
                 0, '{}', ?, ?),
                (?, ?, 'site-trip', 'pending', 'follows-one-site-target', 'manual',
                 0, '{}', ?, ?)`,
      )
      .run(
        `replica-home-${appId}`,
        appId,
        homeSiteId,
        now,
        now,
        `replica-trip-${appId}`,
        appId,
        now,
        now,
      );
  }
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('opaque Follows one site snapshots', () => {
  it('moves one writer only after verified restore/health and reuses immutable archive bytes', async () => {
    const source = new FakeOpaqueExecutor('home bytes');
    const target = new FakeOpaqueExecutor('unused');
    const moved = await volumes.transferOpaqueVolumeAuthority({
      applicationId: 'app-opaque-success',
      sourceContext: context('app-opaque-success', homeSiteId),
      targetContext: context('app-opaque-success', 'site-trip'),
      sourceExecutor: source,
      targetExecutor: target,
      actor: 'admin',
    });
    assert.equal(moved.authoritySiteId, 'site-trip');
    assert.equal(moved.authorityEpoch, 2);
    assert.equal(moved.dataSequence, 2);
    assert.equal(moved.uniqueBytes, 0, 'authority adoption reuses the captured content artifacts');
    assert.equal(source.running, false, 'old writer remains quiesced after commit');
    assert.equal(target.running, true, 'new writer passed graph convergence');
    assert.equal(target.restored, 'home bytes');
    const snapshots = store
      .getSqlite()!
      .prepare(
        `SELECT authority_site_id, authority_epoch, data_sequence, latest_home_recovery
           FROM volume_snapshots WHERE app_id = ? ORDER BY data_sequence`,
      )
      .all('app-opaque-success');
    assert.deepEqual(snapshots, [
      {
        authority_site_id: homeSiteId,
        authority_epoch: 1,
        data_sequence: 1,
        latest_home_recovery: 0,
      },
      {
        authority_site_id: 'site-trip',
        authority_epoch: 2,
        data_sequence: 2,
        latest_home_recovery: 1,
      },
    ]);
    const deployment = store
      .getSqlite()!
      .prepare('SELECT data_mode FROM deployments WHERE app_id = ?')
      .get('app-opaque-success') as { data_mode: string };
    assert.equal(deployment.data_mode, 'follows-one-site');
    const replica = store
      .getSqlite()!
      .prepare('SELECT data_mode FROM app_replicas WHERE app_id = ? AND site_id = ?')
      .get('app-opaque-success', 'site-trip') as { data_mode: string };
    assert.equal(replica.data_mode, 'follows-one-site-writer');
    const manifest = volumes.loadPortableVolumeSnapshot(moved.id);
    assert.equal(manifest.parentSnapshotId !== null, true);
    assert.equal(manifest.resources.length, 1);
  });

  it('resumes the original writer and does not advance authority when target health fails', async () => {
    const source = new FakeOpaqueExecutor('last good bytes');
    const target = new FakeOpaqueExecutor('unused');
    target.failConverge = true;
    await assert.rejects(
      () =>
        volumes.transferOpaqueVolumeAuthority({
          applicationId: 'app-opaque-failure',
          sourceContext: context('app-opaque-failure', homeSiteId),
          targetContext: context('app-opaque-failure', 'site-trip'),
          sourceExecutor: source,
          targetExecutor: target,
          actor: 'admin',
        }),
      /original writer resumed/,
    );
    assert.equal(source.running, true);
    assert.equal(target.running, false);
    const latest = store
      .getSqlite()!
      .prepare(
        `SELECT authority_site_id, authority_epoch, data_sequence
           FROM volume_snapshots WHERE app_id = ? ORDER BY data_sequence DESC LIMIT 1`,
      )
      .get('app-opaque-failure');
    assert.deepEqual(latest, {
      authority_site_id: homeSiteId,
      authority_epoch: 1,
      data_sequence: 1,
    });
  });

  it('moves Home to Suitcase and back through durable authenticated stages', async () => {
    const home = new FakeOpaqueExecutor('home final bytes');
    const suitcase = new FakeOpaqueExecutor('suitcase return bytes');
    const first = startTransfer('app-opaque-distributed', 'site-trip');

    await processAt(first.id, homeSiteId, home);
    assert.equal(volumes.getOpaqueVolumeAuthorityTransfer(first.id).state, 'snapshot-ready');
    assert.equal(home.running, false, 'source stays cold after its final snapshot');

    await processAt(first.id, 'site-trip', suitcase);
    assert.equal(volumes.getOpaqueVolumeAuthorityTransfer(first.id).state, 'target-ready');
    assert.equal(suitcase.running, false, 'health-proven target stays cold before commit');

    await processAt(first.id, homeSiteId, home);
    assert.equal(volumes.getOpaqueVolumeAuthorityTransfer(first.id).state, 'committed');
    await processAt(first.id, 'site-trip', suitcase);
    assert.equal(suitcase.running, true);
    assert.equal(suitcase.restored, 'home final bytes');

    const returnPlan = volumes.planOpaqueVolumeAuthorityTransfer({
      applicationId: 'app-opaque-distributed',
      targetSiteId: homeSiteId,
    });
    assert.equal(returnPlan.sourceSiteId, 'site-trip');
    const returning = volumes.startOpaqueVolumeAuthorityTransfer({
      ...returnPlan,
      actor: 'admin',
    });
    await processAt(returning.id, 'site-trip', suitcase);
    assert.equal(suitcase.running, false);
    await processAt(returning.id, homeSiteId, home);
    assert.equal(volumes.getOpaqueVolumeAuthorityTransfer(returning.id).state, 'committed');
    assert.equal(home.running, true);
    assert.equal(home.restored, 'suitcase return bytes');

    const operations = store
      .getSqlite()!
      .prepare(
        `SELECT operation, authenticated_digest FROM fleet_events
          WHERE json_extract(payload, '$.transferId') IN (?, ?)
          ORDER BY created_at, id`,
      )
      .all(first.id, returning.id) as Array<{
      operation: string;
      authenticated_digest: string;
    }>;
    assert.equal(
      operations.every((event) => event.authenticated_digest.length > 40),
      true,
    );
    assert.equal(
      operations.some(
        (event) => event.operation === 'data.volume.authority.transfer.snapshot-ready',
      ),
      true,
    );
    assert.equal(
      operations.some((event) => event.operation === 'data.volume.authority.transfer.target-ready'),
      true,
    );
    assert.equal(
      operations.some((event) => event.operation === 'data.volume.authority.transfer.committed'),
      true,
    );
  });

  it('recovers a target-restoring stage after a process restart', async () => {
    const source = new FakeOpaqueExecutor('restart-safe bytes');
    const target = new FakeOpaqueExecutor('unused');
    const transfer = startTransfer('app-opaque-restart', 'site-trip');
    await processAt(transfer.id, homeSiteId, source);
    store
      .getSqlite()!
      .prepare(
        `UPDATE volume_authority_transfers
            SET state = 'target-restoring', version = version + 1 WHERE id = ?`,
      )
      .run(transfer.id);

    await processAt(transfer.id, 'site-trip', target);
    assert.equal(volumes.getOpaqueVolumeAuthorityTransfer(transfer.id).state, 'target-ready');
    assert.equal(target.restored, 'restart-safe bytes');
    await processAt(transfer.id, homeSiteId, source);
    await processAt(transfer.id, 'site-trip', target);
    assert.equal(volumes.getOpaqueVolumeAuthorityTransfer(transfer.id).state, 'committed');
  });

  it('rejects a stale authority epoch/data-sequence CAS', async () => {
    const plan = volumes.planOpaqueVolumeAuthorityTransfer({
      applicationId: 'app-opaque-stale',
      targetSiteId: 'site-trip',
    });
    await volumes.captureOpaqueVolumeSnapshot({
      applicationId: 'app-opaque-stale',
      context: context('app-opaque-stale', homeSiteId),
      executor: new FakeOpaqueExecutor('newer bytes'),
      actor: 'scheduler',
    });
    assert.throws(
      () => volumes.startOpaqueVolumeAuthorityTransfer({ ...plan, actor: 'admin' }),
      /stale/i,
    );
  });

  it('fails a target restore closed and resumes the original source', async () => {
    const source = new FakeOpaqueExecutor('last authoritative bytes');
    const target = new FakeOpaqueExecutor('unused');
    target.failRestore = true;
    const transfer = startTransfer('app-opaque-restore-failure', 'site-trip');
    await processAt(transfer.id, homeSiteId, source);
    await processAt(transfer.id, 'site-trip', target);
    let failed = volumes.getOpaqueVolumeAuthorityTransfer(transfer.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.sourceResumed, false);
    assert.equal(target.running, false);
    await processAt(transfer.id, homeSiteId, source);
    failed = volumes.getOpaqueVolumeAuthorityTransfer(transfer.id);
    assert.equal(failed.sourceResumed, true);
    assert.equal(source.running, true);
  });

  it('aborts a captured handoff and durably resumes its source', async () => {
    const source = new FakeOpaqueExecutor('abort-safe bytes');
    const transfer = startTransfer('app-opaque-abort', 'site-trip');
    await processAt(transfer.id, homeSiteId, source);
    assert.equal(source.running, false);
    const aborted = volumes.abortOpaqueVolumeAuthorityTransfer({
      transferId: transfer.id,
      actor: 'admin',
      reason: 'Trip cancelled',
    });
    assert.equal(aborted.state, 'aborted');
    assert.equal(aborted.sourceResumed, false);
    await processAt(transfer.id, homeSiteId, source);
    assert.equal(volumes.getOpaqueVolumeAuthorityTransfer(transfer.id).sourceResumed, true);
    assert.equal(source.running, true);
  });

  it('revalidates the volume contract before planning and every in-flight authority stage', async () => {
    const followsAllowed = specs.compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
components:
  database:
    image: example/database:1
resources:
  data:
    type: volume
    suitcase:
      allowedDataModes: [follows-one-site]
`);
    store.saveDesiredApplicationSpec({
      digest: followsAllowed.digest,
      deploymentName: 'opaque-contract',
      apiVersion: followsAllowed.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: followsAllowed.canonicalJson,
      createdBy: 'admin',
    });
    const transfer = startTransfer('app-opaque-contract', 'site-trip');

    const localOnly = specs.compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
components:
  database:
    image: example/database:2
resources:
  data:
    type: volume
    suitcase:
      allowedDataModes: [site-local]
`);
    store.saveDesiredApplicationSpec({
      digest: localOnly.digest,
      deploymentName: 'opaque-contract',
      parentDigest: followsAllowed.digest,
      apiVersion: localOnly.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: localOnly.canonicalJson,
      createdBy: 'admin',
    });

    const source = new FakeOpaqueExecutor('contract bytes');
    await processAt(transfer.id, homeSiteId, source);
    const failed = volumes.getOpaqueVolumeAuthorityTransfer(transfer.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error || '', /follows-one-site.*data/);
    assert.throws(
      () =>
        volumes.planOpaqueVolumeAuthorityTransfer({
          applicationId: 'app-opaque-contract',
          targetSiteId: 'site-trip',
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'suitcase_data_mode_not_allowed',
    );
  });
});

function startTransfer(applicationId: string, targetSiteId: string) {
  const plan = volumes.planOpaqueVolumeAuthorityTransfer({ applicationId, targetSiteId });
  return volumes.startOpaqueVolumeAuthorityTransfer({ ...plan, actor: 'admin' });
}

async function processAt(
  _transferId: string,
  siteId: string,
  executor: FakeOpaqueExecutor,
): Promise<void> {
  await volumes.processLocalOpaqueVolumeAuthorityTransfers({
    localSiteId: siteId,
    transferId: _transferId,
    executor,
    contextResolver: context,
  });
}

function context(applicationId: string, siteId: string): GraphExecutorContext {
  return {
    deploymentName: applicationId,
    applicationId,
    siteId,
    projectDirectory: root,
    writerSiteId: siteId,
    runtime: {
      configurationDigest: 'sha256:configuration',
      execution: { specDigest: 'sha256:specification' },
    } as GraphExecutorContext['runtime'],
  };
}

class FakeOpaqueExecutor implements OpaqueVolumeExecutor {
  running = true;
  restored: string | null = null;
  failConverge = false;
  failRestore = false;
  readonly #contents: string;

  constructor(contents: string) {
    this.#contents = contents;
  }

  async createRecoveryPoint(
    graphContext: GraphExecutorContext,
    destinationDirectory: string,
    options: GraphRecoveryPointOptions = {},
  ): Promise<GraphRecoveryArtifact> {
    mkdirSync(destinationDirectory, { recursive: true });
    const archive = resolve(destinationDirectory, 'data.tar.gz');
    writeFileSync(archive, this.#contents);
    const bytes = readFileSync(archive);
    const manifest = Buffer.from(
      `${JSON.stringify({
        version: 1,
        applicationId: graphContext.applicationId,
        siteId: graphContext.siteId,
        specDigest: graphContext.runtime.execution.specDigest,
        configurationDigest: graphContext.runtime.configurationDigest,
        resources: [
          {
            resource: 'data',
            archive: 'data.tar.gz',
            digest: digest(bytes),
            bytes: bytes.length,
          },
        ],
      })}\n`,
    );
    const manifestPath = resolve(destinationDirectory, 'recovery-manifest.json');
    writeFileSync(manifestPath, manifest);
    this.running = options.resume !== false;
    return {
      artifactReference: manifestPath,
      artifactDigest: digest(manifest),
      verification: 'fake-cold-verified',
    };
  }

  async restoreRecoveryPoint(
    _context: GraphExecutorContext,
    artifact: Pick<GraphRecoveryArtifact, 'artifactReference'>,
  ): Promise<void> {
    if (this.failRestore) throw new Error('restore failed');
    const manifest = JSON.parse(readFileSync(artifact.artifactReference, 'utf8')) as {
      resources: Array<{ archive: string }>;
    };
    this.restored = readFileSync(
      resolve(artifact.artifactReference, '..', manifest.resources[0]!.archive),
      'utf8',
    );
    this.running = false;
  }

  async converge(_context: GraphExecutorContext): Promise<GraphMaterializationResult> {
    if (this.failConverge) throw new Error('health gate failed');
    this.running = true;
    return {} as GraphMaterializationResult;
  }

  async stop(): Promise<void> {
    this.running = false;
  }
}

function digest(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
