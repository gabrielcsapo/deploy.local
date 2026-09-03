import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { compileApplicationManifest } from './application-spec.ts';

let root: string;
let store: typeof import('./store.ts');
let handler: typeof import('./fleet-handler.ts');
let multisite: typeof import('./multisite.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-fleet-handler-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?fleet-handler=${Date.now()}`);
  handler = await import(`./fleet-handler.ts?fleet-handler=${Date.now()}`);
  multisite = await import(`./multisite.ts?fleet-handler=${Date.now()}`);
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO deployments (name, username, status, app_id, created_at, updated_at)
       VALUES ('notes', 'admin', 'running', 'app-notes', ?, ?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString());
  const spec = compileApplicationManifest({
    apiVersion: 'deploy.local/v1',
    kind: 'Application',
    components: {
      web: {
        image:
          'example/notes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
  });
  store.saveDesiredApplicationSpec({
    digest: spec.digest,
    deploymentName: 'notes',
    apiVersion: spec.spec.apiVersion,
    source: 'repository',
    manifestFormat: 'deploy.yaml',
    normalizedSpec: spec.canonicalJson,
    createdBy: 'admin',
  });
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

const admin = { username: 'admin', role: 'admin' as const };

describe('fleet admin handler', () => {
  it('isolates every route to administrators', async () => {
    const response = await handler.handleFleetRequest({
      method: 'GET',
      pathname: '/fleet/topology',
      actor: { username: 'member', role: 'user' },
    });
    assert.equal(response.status, 403);
  });

  it('creates safe-default suitcase pairings and returns the topology graph', async () => {
    const pairing = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/pairings',
      actor: admin,
      body: { name: 'Blue suitcase' },
    });
    assert.equal(pairing.status, 201);
    assert.equal((pairing.body as { defaultDataPolicy: string }).defaultDataPolicy, 'none');
    const keys = generateKeyPairSync('ed25519');
    const suitcase = multisite.redeemSuitcasePairing({
      code: (pairing.body as { code: string }).code,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      platform: 'linux',
      architecture: 'arm64',
      version: '1.0.0',
      capabilities: { dockerTarget: true },
    });
    const topology = await handler.handleFleetRequest({
      method: 'GET',
      pathname: '/fleet/topology',
      actor: admin,
    });
    assert.equal(topology.status, 200);
    assert.deepEqual(
      (topology.body as { applications: Array<{ app_id: string }> }).applications[0]?.app_id,
      'app-notes',
    );
    const diagnostics = await handler.handleFleetRequest({
      method: 'GET',
      pathname: `/fleet/sites/${suitcase.siteId}/diagnostics`,
      actor: admin,
    });
    assert.equal(diagnostics.status, 200);
    assert.equal((diagnostics.body as { access: { platform: string } }).access.platform, 'linux');
  });

  it('returns a structured conflict when initial selection violates the resource contract', async () => {
    store.saveDeployment({ name: 'private-notes', username: 'admin' });
    store
      .getSqlite()!
      .prepare("UPDATE deployments SET app_id = 'app-private-notes' WHERE name = 'private-notes'")
      .run();
    const compiled = compileApplicationManifest({
      apiVersion: 'deploy.local/v1',
      kind: 'Application',
      components: { web: { image: 'example/private-notes:1' } },
      resources: {
        'private-data': {
          type: 'volume',
          suitcase: { allowedDataModes: ['follows-one-site'] },
        },
      },
    });
    store.saveDesiredApplicationSpec({
      digest: compiled.digest,
      deploymentName: 'private-notes',
      apiVersion: compiled.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: compiled.canonicalJson,
      createdBy: 'admin',
    });
    const suitcase = store
      .getSqlite()!
      .prepare("SELECT id FROM sites WHERE kind = 'suitcase' ORDER BY created_at LIMIT 1")
      .get() as { id: string };

    const response = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/apps/app-private-notes/replicas',
      actor: admin,
      body: { siteId: suitcase.id, policy: 'none', dataTopology: 'site-local' },
    });
    assert.deepEqual(response, {
      status: 409,
      body: {
        error:
          'Suitcase data mode "site-local" is not allowed by application "private-notes" resources: private-data',
        code: 'suitcase_data_mode_not_allowed',
        mode: 'site-local',
        resources: ['private-data'],
      },
    });
  });

  it('plans, starts, inspects, and aborts a distributed writer handoff', async () => {
    const fleet = multisite.ensureFleetIdentity();
    const sites = store
      .getSqlite()!
      .prepare("SELECT id FROM sites WHERE kind = 'suitcase' ORDER BY created_at")
      .all() as Array<{ id: string }>;
    const sourceSiteId = sites[0]!.id;
    const pairing = multisite.createSuitcasePairing({ name: 'Writer target', createdBy: 'admin' });
    const keys = generateKeyPairSync('ed25519');
    const target = multisite.redeemSuitcasePairing({
      code: pairing.code,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      platform: 'linux',
      architecture: 'arm64',
      version: '1.0.0',
    });
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, runtime_status, data_mode, sync_policy,
           shared_lineage, readiness, created_at, updated_at)
         VALUES ('replica-writer-source', 'app-notes', ?, 'running',
                 'follows-one-site-writer', 'manual', 0, '{}', ?, ?),
                ('replica-writer-target', 'app-notes', ?, 'recovery-only',
                 'follows-one-site-recovery', 'manual', 0, '{}', ?, ?)`,
      )
      .run(sourceSiteId, now, now, target.siteId, now, now);
    const planned = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/apps/app-notes/writer-transfer/plan',
      actor: admin,
      body: { targetSiteId: target.siteId },
    });
    assert.equal(planned.status, 200);
    assert.equal((planned.body as { sourceSiteId: string }).sourceSiteId, sourceSiteId);
    const started = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/apps/app-notes/writer-transfer/start',
      actor: admin,
      body: planned.body,
    });
    assert.equal(started.status, 202);
    const transfer = started.body as { id: string; state: string };
    assert.equal(transfer.state, 'requested');
    const status = await handler.handleFleetRequest({
      method: 'GET',
      pathname: `/fleet/writer-transfers/${transfer.id}`,
      actor: admin,
    });
    assert.equal(status.status, 200);
    const aborted = await handler.handleFleetRequest({
      method: 'POST',
      pathname: `/fleet/writer-transfers/${transfer.id}/abort`,
      actor: admin,
      body: { reason: 'test cancellation' },
    });
    assert.equal(aborted.status, 200);
    assert.equal((aborted.body as { state: string }).state, 'aborted');
    assert.equal((aborted.body as { sourceResumed: boolean }).sourceResumed, false);
    assert.equal(fleet.homeSiteId === sourceSiteId, false);
  });

  it('sets explicit app/site policy and persists a workload-derived capacity plan', async () => {
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
           profile_version, base_checkpoint_id, readiness, created_at, updated_at)
         VALUES ('replica-handler-away', 'app-notes', 'site-away', 'running', 'replicated',
                 'automatic', 1, 'profile-handler', 'checkpoint-handler', '{}', ?, ?)`,
      )
      .run(now, now);
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO data_reconciliation_profiles
          (id, app_id, version, analyzer_version, sqlite_files, eligible_tables,
           excluded_tables, upload_paths, opaque_paths, compatibility_digest, findings, created_at)
         VALUES ('profile-handler', 'app-notes', 'profile-handler', '1.0.0', '[]', '[]',
                 '[]', '[]', '[]', 'sha256:handler-compatibility', '[]', ?)`,
      )
      .run(now);
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO portability_reports
          (id, app_id, spec_digest, site_id, analyzer_version, classification,
           capability_vector, findings, evidence, profile_digest, created_at)
         VALUES ('report-handler', 'app-notes', 'sha256:handler-spec', 'site-away', '1.0.0',
                 'stateless-replica', '{}', '[]', '[]', 'profile-handler', ?)`,
      )
      .run(now);
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO data_checkpoints
          (id, app_id, origin_site_id, sequence, manifest_artifact_digest,
           verification_status, acknowledgements, created_at)
         VALUES ('checkpoint-handler', 'app-notes', 'site-away', 1,
                 'sha256:handler-manifest', 'verified', '{}', ?)`,
      )
      .run(now);
    const policy = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/apps/app-notes/policy',
      actor: admin,
      body: { siteId: 'site-away', policy: 'manual', conflictPolicy: 'collect' },
    });
    assert.equal(policy.status, 200);
    assert.equal((policy.body as { status: string }).status, 'completed');
    const savedPolicy = store
      .getSqlite()!
      .prepare('SELECT policy FROM data_sync_policies WHERE app_id = ? AND site_id = ?')
      .get('app-notes', 'site-away') as { policy: string };
    assert.equal(savedPolicy.policy, 'manual');

    const noSync = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/apps/app-notes/policy',
      actor: admin,
      body: { siteId: 'site-away', policy: 'none' },
    });
    assert.equal(noSync.status, 200);
    const unsafeRejoin = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/apps/app-notes/policy',
      actor: admin,
      body: { siteId: 'site-away', policy: 'automatic' },
    });
    assert.equal(unsafeRejoin.status, 409);
    assert.equal((unsafeRejoin.body as { code: string }).code, 'rejoin_choice_required');
    const requestedRejoin = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/apps/app-notes/policy',
      actor: admin,
      body: {
        siteId: 'site-away',
        policy: 'automatic',
        rejoinChoice: 'replace-shared-from-site',
        protectedConfirmation: 'REPLACE SHARED DATA FROM site-away',
      },
    });
    assert.equal(requestedRejoin.status, 202);
    assert.equal((requestedRejoin.body as { status: string }).status, 'pending-target-processing');

    const gib = 1024 ** 3;
    const capacity = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/capacity-plans',
      actor: admin,
      body: {
        fleetId: 'fleet-home',
        tripHorizonDays: 7,
        offlineBuilds: false,
        components: [
          {
            appId: 'app-notes',
            component: 'web',
            instances: 1,
            runtimeWorkingSet: { bytes: gib, confidence: 'measured', source: 'high water' },
            storage: { bytes: 2 * gib, confidence: 'measured', source: 'snapshot' },
          },
        ],
      },
    });
    assert.equal(capacity.status, 201);
    const selectedCapacity = await handler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/capacity-plans',
      actor: admin,
      body: {
        selectedAppIds: ['app-notes'],
        tripHorizonDays: 14,
        offlineBuilds: true,
        projectedDailyGrowthBytes: 128 * 1024 ** 2,
        retainedBackupCopies: 2,
      },
    });
    assert.equal(selectedCapacity.status, 201);
    assert.deepEqual((selectedCapacity.body as { selectedAppIds: string[] }).selectedAppIds, [
      'app-notes',
    ]);
    assert.deepEqual(
      store.getSqlite()!.prepare('SELECT COUNT(*) AS count FROM suitcase_capacity_plans').get(),
      { count: 2 },
    );
  });
});
