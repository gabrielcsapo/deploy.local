import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  GraphExecutorContext,
  GraphMaterializationResult,
} from './application-graph-executor.ts';

let root: string;
let store: typeof import('./store.ts');
let specs: typeof import('./application-spec.ts');
let multisite: typeof import('./multisite.ts');
let reconciliation: typeof import('./data-reconciliation.ts');
let transitions: typeof import('./data-policy-transitions.ts');
let materializer: typeof import('./suitcase-application-materializer.ts');
let homeWorker: typeof import('./data-policy-transition-worker.ts');
let homeSiteId: string;

const targetSiteId = 'site-policy-target';
const membership = {
  siteId: targetSiteId,
  credential: 'policy-target-credential',
  publicKey: 'policy-target-public',
  accessMode: 'existing-lan',
  mode: 'docked' as const,
};

class FakePolicyExecutor {
  backups = 0;
  restores = 0;
  converges = 0;
  failNextRestore = false;

  async createRecoveryPoint(context: GraphExecutorContext, destination: string) {
    this.backups += 1;
    mkdirSync(destination, { recursive: true });
    const manifestPath = join(destination, 'recovery-manifest.json');
    const content = `${JSON.stringify(
      {
        version: 1,
        applicationId: context.applicationId,
        siteId: context.siteId,
        specDigest: context.runtime.execution.specDigest,
        configurationDigest: context.runtime.configurationDigest,
        resources: [],
      },
      null,
      2,
    )}\n`;
    writeFileSync(manifestPath, content);
    return {
      artifactReference: manifestPath,
      artifactDigest: `sha256:${createHash('sha256').update(content).digest('hex')}` as const,
      verification: 'fake-cold-backup:manifest-verified',
    };
  }

  async restoreRecoveryPoint() {
    this.restores += 1;
    if (this.failNextRestore) {
      this.failNextRestore = false;
      throw new Error('simulated target restore failure');
    }
  }

  async converge(context: GraphExecutorContext): Promise<GraphMaterializationResult> {
    this.converges += 1;
    return {
      applicationId: context.applicationId,
      releaseDigest: context.runtime.execution.specDigest,
      configurationDigest: context.runtime.configurationDigest,
      network: `network-${context.applicationId}`,
      primaryPort: null,
      primaryContainerId: null,
      primaryContainerName: null,
      instances: [],
    };
  }

  async remove() {}
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-policy-materialization-'));
  process.env.DEPLOY_DATA_DIR = root;
  delete process.env.DEPLOY_SUITCASE;
  store = await import(`./store.ts?policy-materialization=${Date.now()}`);
  specs = await import(`./application-spec.ts?policy-materialization=${Date.now()}`);
  multisite = await import(`./multisite.ts?policy-materialization=${Date.now()}`);
  reconciliation = await import(`./data-reconciliation.ts?policy-materialization=${Date.now()}`);
  transitions = await import(`./data-policy-transitions.ts?policy-materialization=${Date.now()}`);
  materializer = await import(
    `./suitcase-application-materializer.ts?policy-materialization=${Date.now()}`
  );
  homeWorker = await import(
    `./data-policy-transition-worker.ts?policy-materialization=${Date.now()}`
  );
  const fleet = multisite.ensureFleetIdentity('Policy materialization test');
  homeSiteId = fleet.homeSiteId;
  const now = new Date().toISOString();
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO sites
        (id, fleet_id, name, kind, public_key, credential_status, capabilities, mode,
         default_data_policy, access_mode, security_profile, readiness_summary, created_at, updated_at)
       VALUES (?, ?, 'Policy target', 'suitcase', ?, 'active', '{}', 'docked', 'none',
               'existing-lan', 'isolated', '{}', ?, ?)`,
    )
    .run(targetSiteId, fleet.id, membership.publicKey, now, now);
});

after(() => {
  homeWorker?.stopDataPolicyTransitionWorker();
  store?._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  delete process.env.DEPLOY_SUITCASE;
  rmSync(root, { recursive: true, force: true });
});

async function seedApplication(name: string): Promise<{
  appId: string;
  baseCheckpointId: string;
}> {
  const appId = `app-${name}`;
  const profileId = `profile-${name}`;
  const source = `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: ${name}
components:
  web:
    image: nginx:1.27
    role: web
`;
  const compiled = specs.compileDeployYaml(source);
  const sqlite = store.getSqlite()!;
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO deployments
        (name, type, username, status, desired_spec_digest, active_spec_digest,
         app_id, data_mode, reconciliation_profile_version, release_generation,
         created_at, updated_at)
       VALUES (?, 'application-graph', 'admin', 'running', ?, ?, ?, 'replicated', ?, 1, ?, ?)`,
    )
    .run(name, compiled.digest, compiled.digest, appId, profileId, now, now);
  sqlite
    .prepare(
      `INSERT INTO application_spec_revisions
        (digest, deployment_name, api_version, source, manifest_format,
         normalized_spec, created_by, created_at)
       VALUES (?, ?, 'deploy.local/v1', 'repository', 'deploy.yaml', ?, 'admin', ?)`,
    )
    .run(compiled.digest, name, compiled.canonicalJson, now);
  sqlite
    .prepare(
      `INSERT INTO data_reconciliation_profiles
        (id, app_id, version, analyzer_version, sqlite_files, eligible_tables,
         excluded_tables, upload_paths, opaque_paths, compatibility_digest, findings, created_at)
       VALUES (?, ?, ?, '1.0.0', '[]', '[]', '[]', '[]', '[]',
               'sha256:stateless-compatible', '[]', ?)`,
    )
    .run(profileId, appId, profileId, now);
  sqlite
    .prepare(
      `INSERT INTO portability_reports
        (id, app_id, spec_digest, site_id, analyzer_version, classification,
         capability_vector, findings, evidence, profile_digest, created_at)
       VALUES (?, ?, ?, ?, '1.0.0', 'stateless-replica', '{}', '[]', '[]', ?, ?)`,
    )
    .run(`report-${name}`, appId, compiled.digest, targetSiteId, profileId, now);
  const checkpoint = await reconciliation.createDataCheckpoint({
    appId,
    originSiteId: homeSiteId,
    profileVersion: profileId,
    actor: 'admin',
    allowEmpty: true,
  });
  sqlite
    .prepare(
      `INSERT INTO app_replicas
        (id, app_id, site_id, active_release_digest, desired_release_digest,
         runtime_status, data_mode, sync_policy, shared_lineage, profile_version,
         base_checkpoint_id, readiness, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'running', 'replicated', 'automatic', 1, ?, ?, '{}', ?, ?)
       ON CONFLICT(app_id, site_id) DO UPDATE SET
         active_release_digest = excluded.active_release_digest,
         desired_release_digest = excluded.desired_release_digest,
         runtime_status = excluded.runtime_status,
         data_mode = excluded.data_mode,
         sync_policy = excluded.sync_policy,
         shared_lineage = excluded.shared_lineage,
         profile_version = excluded.profile_version,
         base_checkpoint_id = excluded.base_checkpoint_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      `replica-home-${name}`,
      appId,
      homeSiteId,
      compiled.digest,
      compiled.digest,
      profileId,
      checkpoint.id,
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO app_replicas
        (id, app_id, site_id, active_release_digest, desired_release_digest,
         runtime_status, data_mode, sync_policy, shared_lineage, profile_version,
         readiness, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'running', 'site-local', 'none', 0, ?, '{}', ?, ?)`,
    )
    .run(
      `replica-target-${name}`,
      appId,
      targetSiteId,
      compiled.digest,
      compiled.digest,
      profileId,
      now,
      now,
    );
  return { appId, baseCheckpointId: checkpoint.id };
}

async function reconcileTarget(executor: FakePolicyExecutor) {
  return materializer.reconcileSuitcaseApplications(membership, {
    executor,
    accessProbe: async () => ({ ready: true, evidence: 'test control surface' }),
    drainTimeoutMs: 0,
  });
}

function eventCount(operation: string, requestEventId: string): number {
  return Number(
    (
      store
        .getSqlite()!
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_events
            WHERE operation = ? AND json_extract(payload, '$.requestEventId') = ?`,
        )
        .get(operation, requestEventId) as { count: number }
    ).count,
  );
}

describe('durable policy transition materialization', () => {
  it('backs up and replaces the target from shared exactly once across restarts', async () => {
    const seeded = await seedApplication('replace-target');
    const request = transitions.transitionReplicaDataPolicy({
      appId: seeded.appId,
      siteId: targetSiteId,
      policy: 'automatic',
      rejoinChoice: 'replace-site-from-shared',
      updatedBy: 'admin',
    });
    assert.equal(request.status, 'pending-target-processing');
    const executor = new FakePolicyExecutor();
    await reconcileTarget(executor);
    await reconcileTarget(executor);
    assert.equal(
      eventCount('application.data.policy.transition.backup.created', request.eventId),
      1,
    );
    assert.equal(eventCount('application.data.policy.transition.completed', request.eventId), 1);
    assert.equal(eventCount('application.data.policy.transition.failed', request.eventId), 0);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT sync_policy, shared_lineage, data_mode, base_checkpoint_id
             FROM app_replicas WHERE app_id = ? AND site_id = ?`,
        )
        .get(seeded.appId, targetSiteId),
      {
        sync_policy: 'automatic',
        shared_lineage: 1,
        data_mode: 'replicated',
        base_checkpoint_id: seeded.baseCheckpointId,
      },
    );
  });

  it('prepares suitcase state, backs up Home, and replaces shared data once across workers', async () => {
    const seeded = await seedApplication('replace-home');
    const request = transitions.transitionReplicaDataPolicy({
      appId: seeded.appId,
      siteId: targetSiteId,
      policy: 'manual',
      rejoinChoice: 'replace-shared-from-site',
      protectedConfirmation: `REPLACE SHARED DATA FROM ${targetSiteId}`,
      updatedBy: 'admin',
    });
    assert.equal(request.status, 'pending-target-processing');
    const targetExecutor = new FakePolicyExecutor();
    await reconcileTarget(targetExecutor);
    await reconcileTarget(targetExecutor);
    assert.equal(eventCount('application.data.policy.transition.prepared', request.eventId), 1);
    const homeExecutor = new FakePolicyExecutor();
    await homeWorker.materializeHomeDataPolicyTransitions({ executor: homeExecutor });
    await homeWorker.materializeHomeDataPolicyTransitions({ executor: homeExecutor });
    assert.equal(
      eventCount('application.data.policy.transition.backup.created', request.eventId),
      2,
    );
    assert.equal(eventCount('application.data.policy.transition.completed', request.eventId), 1);
    const completed = store
      .getSqlite()!
      .prepare(
        `SELECT payload FROM fleet_events
          WHERE operation = 'application.data.policy.transition.completed'
            AND json_extract(payload, '$.requestEventId') = ?`,
      )
      .get(request.eventId) as { payload: string };
    const replacementCheckpointId = String(JSON.parse(completed.payload).baseCheckpointId);
    assert.notEqual(replacementCheckpointId, seeded.baseCheckpointId);
    const replicas = (
      store
        .getSqlite()!
        .prepare(
          `SELECT site_id, sync_policy, shared_lineage, base_checkpoint_id
             FROM app_replicas WHERE app_id = ? ORDER BY site_id`,
        )
        .all(seeded.appId) as Array<{
        site_id: string;
        sync_policy: string;
        shared_lineage: number;
        base_checkpoint_id: string;
      }>
    ).sort((left, right) => left.site_id.localeCompare(right.site_id));
    assert.deepEqual(
      replicas,
      [
        {
          site_id: homeSiteId,
          sync_policy: 'automatic',
          shared_lineage: 1,
          base_checkpoint_id: replacementCheckpointId,
        },
        {
          site_id: targetSiteId,
          sync_policy: 'manual',
          shared_lineage: 1,
          base_checkpoint_id: replacementCheckpointId,
        },
      ].sort((left, right) => left.site_id.localeCompare(right.site_id)),
    );
  });

  it('imports the local namespace as a verified new app before resetting the original, once', async () => {
    const seeded = await seedApplication('import-target');
    const request = transitions.transitionReplicaDataPolicy({
      appId: seeded.appId,
      siteId: targetSiteId,
      policy: 'automatic',
      rejoinChoice: 'import-site-as-new-application',
      updatedBy: 'admin',
    });
    assert.equal(request.status, 'pending-target-processing');
    const executor = new FakePolicyExecutor();
    await reconcileTarget(executor);
    await reconcileTarget(executor);
    const requestEvent = store
      .getSqlite()!
      .prepare('SELECT payload FROM fleet_events WHERE id = ?')
      .get(request.eventId) as { payload: string };
    const requestPayload = JSON.parse(requestEvent.payload) as Record<string, unknown>;
    const importedAppId = String(requestPayload.importedApplicationId);
    const importedName = String(requestPayload.importedApplicationName);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare('SELECT name, status FROM deployments WHERE app_id = ?')
        .get(importedAppId),
      { name: importedName, status: 'running' },
    );
    assert.equal(
      Number(
        (
          store
            .getSqlite()!
            .prepare(
              `SELECT COUNT(*) AS count FROM fleet_events
                WHERE operation = 'application.offline.release.candidate'
                  AND app_id = ?`,
            )
            .get(importedAppId) as { count: number }
        ).count,
      ),
      1,
    );
    assert.equal(
      eventCount('application.data.policy.transition.backup.created', request.eventId),
      1,
    );
    assert.equal(eventCount('application.data.policy.transition.completed', request.eventId), 1);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT sync_policy, shared_lineage, base_checkpoint_id
             FROM app_replicas WHERE app_id = ? AND site_id = ?`,
        )
        .get(seeded.appId, targetSiteId),
      {
        sync_policy: 'automatic',
        shared_lineage: 1,
        base_checkpoint_id: seeded.baseCheckpointId,
      },
    );
  });

  it('records one authenticated failure after preserving the target and never flips policy', async () => {
    const seeded = await seedApplication('failed-target');
    const request = transitions.transitionReplicaDataPolicy({
      appId: seeded.appId,
      siteId: targetSiteId,
      policy: 'automatic',
      rejoinChoice: 'replace-site-from-shared',
      updatedBy: 'admin',
    });
    assert.equal(request.status, 'pending-target-processing');
    const executor = new FakePolicyExecutor();
    executor.failNextRestore = true;
    await reconcileTarget(executor);
    await reconcileTarget(executor);
    assert.equal(
      eventCount('application.data.policy.transition.backup.created', request.eventId),
      1,
    );
    assert.equal(eventCount('application.data.policy.transition.failed', request.eventId), 1);
    assert.equal(eventCount('application.data.policy.transition.completed', request.eventId), 0);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT sync_policy, shared_lineage, base_checkpoint_id
             FROM app_replicas WHERE app_id = ? AND site_id = ?`,
        )
        .get(seeded.appId, targetSiteId),
      { sync_policy: 'none', shared_lineage: 0, base_checkpoint_id: null },
    );
  });
});
