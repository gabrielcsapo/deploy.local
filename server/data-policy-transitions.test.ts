import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let transitions: typeof import('./data-policy-transitions.ts');
let reconciliation: typeof import('./data-reconciliation.ts');
let specs: typeof import('./application-spec.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-policy-transitions-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?policy-transitions=${Date.now()}`);
  multisite = await import(`./multisite.ts?policy-transitions=${Date.now()}`);
  transitions = await import(`./data-policy-transitions.ts?policy-transitions=${Date.now()}`);
  reconciliation = await import(`./data-reconciliation.ts?policy-transitions=${Date.now()}`);
  specs = await import(`./application-spec.ts?policy-transitions=${Date.now()}`);
  const sqlite = store.getSqlite()!;
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO deployments (name, username, status, app_id, created_at, updated_at)
       VALUES ('notes', 'admin', 'running', 'app-policy-notes', ?, ?)`,
    )
    .run(now, now);
  const fleet = multisite.ensureFleetIdentity();
  sqlite
    .prepare(
      `INSERT INTO sites
        (id, fleet_id, name, kind, public_key, credential_status, capabilities,
         mode, default_data_policy, access_mode, security_profile, readiness_summary,
         created_at, updated_at)
       VALUES ('site-policy-away', ?, 'Policy suitcase', 'suitcase', 'test-public-key',
               'active', '{}', 'docked', 'automatic', 'existing-lan', 'isolated', '{}', ?, ?)`,
    )
    .run(fleet.id, now, now);
  sqlite
    .prepare(
      `INSERT INTO data_checkpoints
        (id, app_id, origin_site_id, sequence, manifest_artifact_digest,
         verification_status, acknowledgements, created_at)
       VALUES ('checkpoint-policy-base', 'app-policy-notes', ?, 1,
               'sha256:policy-manifest', 'verified', '{}', ?)`,
    )
    .run(fleet.homeSiteId, now);
  sqlite
    .prepare(
      `INSERT INTO data_reconciliation_profiles
        (id, app_id, version, analyzer_version, sqlite_files, eligible_tables,
         excluded_tables, upload_paths, opaque_paths, compatibility_digest, findings, created_at)
       VALUES ('profile-policy', 'app-policy-notes', 'profile-policy', '1.0.0', '[]', '[]',
               '[]', '[]', '[]', 'sha256:policy-compatibility', '[]', ?)`,
    )
    .run(now);
  sqlite
    .prepare(
      `INSERT INTO portability_reports
        (id, app_id, spec_digest, site_id, analyzer_version, classification,
         capability_vector, findings, evidence, profile_digest, created_at)
       VALUES ('report-policy', 'app-policy-notes', 'sha256:policy-spec', 'site-policy-away',
               '1.0.0', 'stateless-replica', '{}', '[]', '[]', 'profile-policy', ?)`,
    )
    .run(now);
  sqlite
    .prepare(
      `UPDATE app_replicas SET base_checkpoint_id = 'checkpoint-policy-base'
        WHERE app_id = 'app-policy-notes' AND site_id = ?`,
    )
    .run(fleet.homeSiteId);
  sqlite
    .prepare(
      `INSERT INTO app_replicas
        (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
         base_checkpoint_id, readiness, created_at, updated_at)
       VALUES ('replica-policy-away', 'app-policy-notes', 'site-policy-away', 'running',
               'replicated', 'automatic', 1, 'checkpoint-policy-base', '{}', ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      "UPDATE app_replicas SET profile_version = 'profile-policy' WHERE id = 'replica-policy-away'",
    )
    .run();
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('guarded per-replica data policy transitions', () => {
  it('retains a clean base across cadence changes and blocks manual to automatic with pending work', () => {
    const manual = transitions.transitionReplicaDataPolicy({
      appId: 'app-policy-notes',
      siteId: 'site-policy-away',
      policy: 'manual',
      updatedBy: 'admin',
    });
    assert.equal(manual.status, 'completed');
    assert.equal(manual.baseCheckpointId, 'checkpoint-policy-base');
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT sync_policy, shared_lineage, base_checkpoint_id, last_policy_event_id
             FROM app_replicas WHERE app_id = ? AND site_id = ?`,
        )
        .get('app-policy-notes', 'site-policy-away'),
      {
        sync_policy: 'manual',
        shared_lineage: 1,
        base_checkpoint_id: 'checkpoint-policy-base',
        last_policy_event_id: manual.eventId,
      },
    );

    store
      .getSqlite()!
      .prepare(
        `UPDATE app_replicas SET pending_changesets = 1,
                branch_checkpoint_id = 'checkpoint-policy-base'
          WHERE app_id = ? AND site_id = ?`,
      )
      .run('app-policy-notes', 'site-policy-away');
    assert.throws(
      () =>
        transitions.transitionReplicaDataPolicy({
          appId: 'app-policy-notes',
          siteId: 'site-policy-away',
          policy: 'automatic',
          updatedBy: 'admin',
        }),
      (error: unknown) =>
        error instanceof transitions.DataPolicyTransitionError &&
        error.code === 'pending_reconciliation_work',
    );
    assert.equal(
      (
        store
          .getSqlite()!
          .prepare('SELECT sync_policy FROM app_replicas WHERE id = ?')
          .get('replica-policy-away') as { sync_policy: string }
      ).sync_policy,
      'manual',
    );

    store
      .getSqlite()!
      .prepare(
        `UPDATE app_replicas SET pending_changesets = 0, branch_checkpoint_id = NULL
          WHERE id = 'replica-policy-away'`,
      )
      .run();
    const automatic = transitions.transitionReplicaDataPolicy({
      appId: 'app-policy-notes',
      siteId: 'site-policy-away',
      policy: 'automatic',
      updatedBy: 'admin',
    });
    assert.equal(automatic.status, 'completed');
    assert.equal(automatic.baseCheckpointId, 'checkpoint-policy-base');
  });

  it('changes recovery snapshot cadence without collapsing Follows one site topology', () => {
    store
      .getSqlite()!
      .prepare("UPDATE app_replicas SET data_mode = 'follows-one-site-recovery' WHERE id = ?")
      .run('replica-policy-away');
    const manual = transitions.transitionReplicaDataPolicy({
      appId: 'app-policy-notes',
      siteId: 'site-policy-away',
      policy: 'manual',
      updatedBy: 'admin',
    });
    assert.equal(manual.status, 'completed');
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare('SELECT data_mode, sync_policy FROM app_replicas WHERE id = ?')
        .get('replica-policy-away'),
      { data_mode: 'follows-one-site-recovery', sync_policy: 'manual' },
    );
    assert.throws(
      () =>
        transitions.transitionReplicaDataPolicy({
          appId: 'app-policy-notes',
          siteId: 'site-policy-away',
          policy: 'none',
          updatedBy: 'admin',
        }),
      (error: unknown) =>
        error instanceof transitions.DataPolicyTransitionError &&
        error.code === 'follows_one_site_topology_change_required',
    );
    transitions.transitionReplicaDataPolicy({
      appId: 'app-policy-notes',
      siteId: 'site-policy-away',
      policy: 'automatic',
      updatedBy: 'admin',
    });
    store
      .getSqlite()!
      .prepare("UPDATE app_replicas SET data_mode = 'replicated' WHERE id = ?")
      .run('replica-policy-away');
  });

  it('records a fork, stops pinning shared retention, and never invents a rejoin base', () => {
    const fork = transitions.transitionReplicaDataPolicy({
      appId: 'app-policy-notes',
      siteId: 'site-policy-away',
      policy: 'none',
      updatedBy: 'admin',
      acknowledgedRisks: ['Administrator chose an intentionally local namespace'],
    });
    assert.equal(fork.status, 'completed');
    assert.equal(fork.forkCheckpointId, 'checkpoint-policy-base');
    assert.match(fork.siteLocalNamespaceId || '', /^namespace_/);
    const replica = store
      .getSqlite()!
      .prepare(
        `SELECT sync_policy, shared_lineage, data_mode, base_checkpoint_id,
                branch_checkpoint_id, last_policy_event_id
           FROM app_replicas WHERE id = 'replica-policy-away'`,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(replica, {
      sync_policy: 'none',
      shared_lineage: 0,
      data_mode: 'site-local',
      base_checkpoint_id: null,
      branch_checkpoint_id: null,
      last_policy_event_id: fork.eventId,
    });
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT desired_digest, available_digest, state, blockers
             FROM app_materialization
            WHERE app_id = ? AND site_id = ? AND capability = 'data'`,
        )
        .get('app-policy-notes', 'site-policy-away'),
      {
        desired_digest: 'checkpoint-policy-base',
        available_digest: 'checkpoint-policy-base',
        state: 'ready',
        blockers: '[]',
      },
    );
    const event = store
      .getSqlite()!
      .prepare('SELECT payload FROM fleet_events WHERE id = ?')
      .get(fork.eventId) as { payload: string };
    assert.deepEqual(
      {
        forkCheckpointId: JSON.parse(event.payload).forkCheckpointId,
        siteLocalNamespaceId: JSON.parse(event.payload).siteLocalNamespaceId,
        transitionStatus: JSON.parse(event.payload).transitionStatus,
      },
      {
        forkCheckpointId: 'checkpoint-policy-base',
        siteLocalNamespaceId: fork.siteLocalNamespaceId,
        transitionStatus: 'completed',
      },
    );
    const retention = reconciliation.listCheckpointRetentionBlockers('app-policy-notes');
    assert.equal(
      retention.some((checkpoint) => checkpoint.waitingForSiteIds.includes('site-policy-away')),
      false,
    );

    assert.throws(
      () =>
        transitions.transitionReplicaDataPolicy({
          appId: 'app-policy-notes',
          siteId: 'site-policy-away',
          policy: 'automatic',
          updatedBy: 'admin',
        }),
      (error: unknown) =>
        error instanceof transitions.DataPolicyTransitionError &&
        error.code === 'rejoin_choice_required',
    );
    const pending = transitions.transitionReplicaDataPolicy({
      appId: 'app-policy-notes',
      siteId: 'site-policy-away',
      policy: 'automatic',
      rejoinChoice: 'replace-site-from-shared',
      updatedBy: 'admin',
    });
    assert.equal(pending.status, 'pending-target-processing');
    assert.match(pending.requiredActions.join(' '), /retained backup/i);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT sync_policy, shared_lineage, base_checkpoint_id, last_policy_event_id
             FROM app_replicas WHERE id = 'replica-policy-away'`,
        )
        .get(),
      {
        sync_policy: 'none',
        shared_lineage: 0,
        base_checkpoint_id: null,
        last_policy_event_id: pending.eventId,
      },
    );
    assert.equal(
      (
        store
          .getSqlite()!
          .prepare('SELECT policy FROM data_sync_policies WHERE app_id = ? AND site_id = ?')
          .get('app-policy-notes', 'site-policy-away') as { policy: string }
      ).policy,
      'none',
    );
  });

  it('protects the choice that would replace shared Home data', () => {
    assert.throws(
      () =>
        transitions.transitionReplicaDataPolicy({
          appId: 'app-policy-notes',
          siteId: 'site-policy-away',
          policy: 'manual',
          rejoinChoice: 'replace-shared-from-site',
          updatedBy: 'admin',
        }),
      (error: unknown) =>
        error instanceof transitions.DataPolicyTransitionError &&
        error.code === 'protected_confirmation_required',
    );
  });

  it('enforces volume data modes when leaving and rejoining shared lineage', () => {
    const sqlite = store.getSqlite()!;
    sqlite
      .prepare(
        `UPDATE app_replicas
            SET data_mode = 'replicated', sync_policy = 'automatic', shared_lineage = 1,
                pending_changesets = 0, pending_blobs = 0, conflict_count = 0,
                branch_checkpoint_id = NULL
          WHERE id = 'replica-policy-away'`,
      )
      .run();
    const sharedOnly = specs.compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/policy:1
resources:
  database:
    type: volume
    suitcase:
      allowedDataModes: [syncs-across-sites]
`);
    store.saveDesiredApplicationSpec({
      digest: sharedOnly.digest,
      deploymentName: 'notes',
      apiVersion: sharedOnly.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: sharedOnly.canonicalJson,
      createdBy: 'admin',
    });
    assert.throws(
      () =>
        transitions.transitionReplicaDataPolicy({
          appId: 'app-policy-notes',
          siteId: 'site-policy-away',
          policy: 'none',
          updatedBy: 'admin',
        }),
      (error: unknown) =>
        error instanceof transitions.DataPolicyTransitionError &&
        error.code === 'suitcase_data_mode_not_allowed' &&
        /database/.test(error.message),
    );
    assert.equal(
      (
        sqlite
          .prepare('SELECT data_mode FROM app_replicas WHERE id = ?')
          .get('replica-policy-away') as { data_mode: string }
      ).data_mode,
      'replicated',
    );

    const localOnly = specs.compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/policy:2
resources:
  database:
    type: volume
    suitcase:
      allowedDataModes: [site-local]
`);
    store.saveDesiredApplicationSpec({
      digest: localOnly.digest,
      deploymentName: 'notes',
      parentDigest: sharedOnly.digest,
      apiVersion: localOnly.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: localOnly.canonicalJson,
      createdBy: 'admin',
    });
    sqlite
      .prepare(
        `UPDATE app_replicas
            SET data_mode = 'site-local', sync_policy = 'none', shared_lineage = 0
          WHERE id = 'replica-policy-away'`,
      )
      .run();
    assert.throws(
      () =>
        transitions.transitionReplicaDataPolicy({
          appId: 'app-policy-notes',
          siteId: 'site-policy-away',
          policy: 'manual',
          rejoinChoice: 'replace-site-from-shared',
          updatedBy: 'admin',
        }),
      (error: unknown) =>
        error instanceof transitions.DataPolicyTransitionError &&
        error.code === 'suitcase_data_mode_not_allowed' &&
        /syncs-across-sites/.test(error.message),
    );
  });
});
