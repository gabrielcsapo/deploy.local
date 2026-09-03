import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let replicas: typeof import('./fleet-replicas.ts');
let specs: typeof import('./application-spec.ts');

function validatedCapabilityVector(reconciliation = true): string {
  const passed = (summary: string) => ({
    status: 'pass',
    summary,
    evidence: [],
    findingIds: [],
  });
  return JSON.stringify({
    compute: passed('compute'),
    runtimeContainment: passed('containment'),
    offlineDependencies: passed('offline'),
    identityAndSecrets: passed('identity'),
    materialization: passed('artifacts'),
    verification: reconciliation ? passed('reconciliation') : { status: 'unknown' },
  });
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-fleet-replicas-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?replicas=${Date.now()}`);
  multisite = await import(`./multisite.ts?replicas=${Date.now()}`);
  replicas = await import(`./fleet-replicas.ts?replicas=${Date.now()}`);
  specs = await import(`./application-spec.ts?replicas=${Date.now()}`);
  const fleet = multisite.ensureFleetIdentity();
  const now = new Date().toISOString();
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO sites
        (id, fleet_id, name, kind, public_key, credential_status, capabilities,
         mode, default_data_policy, access_mode, security_profile,
         readiness_summary, created_at, updated_at)
       VALUES ('site-away', ?, 'Away', 'suitcase', 'test-public-key', 'active', '{}',
               'docked', 'none', 'existing-lan', 'isolated', '{}', ?, ?)`,
    )
    .run(fleet.id, now, now);
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO deployments
        (name, username, app_id, desired_spec_digest, active_spec_digest,
         desired_release_digest, release_generation, created_at, updated_at)
       VALUES ('notes', 'admin', 'app-notes', 'sha256:spec', 'sha256:spec',
               'sha256:release', 3, ?, ?)`,
    )
    .run(now, now);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('Keep on suitcase', () => {
  it('uses the pairing safe default and creates a distinct site-local namespace', async () => {
    const selected = await replicas.keepApplicationOnSuitcase({
      appId: 'app-notes',
      siteId: 'site-away',
      actor: 'admin',
    });
    assert.equal(selected.policy, 'none');
    assert.equal(selected.sharedLineage, false);
    assert.match(selected.siteLocalNamespaceId || '', /^namespace_/);
    const replica = store
      .getSqlite()!
      .prepare('SELECT sync_policy, data_mode FROM app_replicas WHERE app_id = ? AND site_id = ?')
      .get('app-notes', 'site-away') as { sync_policy: string; data_mode: string };
    assert.deepEqual(replica, { sync_policy: 'none', data_mode: 'site-local' });
    const event = store
      .getSqlite()!
      .prepare("SELECT payload FROM fleet_events WHERE operation = 'application.replica.selected'")
      .get() as { payload: string };
    assert.equal(JSON.parse(event.payload).policy, 'none');
    assert.equal(JSON.parse(event.payload).siteLocalNamespaceId, selected.siteLocalNamespaceId);
  });

  it('will not enable multi-site writes without an eligible portability report', async () => {
    await assert.rejects(
      () =>
        replicas.keepApplicationOnSuitcase({
          appId: 'app-notes',
          siteId: 'site-away',
          policy: 'automatic',
          actor: 'admin',
        }),
      /portability report/,
    );
  });

  it('rejects initial selection when any volume disallows the chosen topology', async () => {
    const compiled = specs.compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/contracted:1
resources:
  private-data:
    type: volume
    suitcase:
      allowedDataModes: [follows-one-site]
`);
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO deployments
          (name, username, app_id, desired_release_digest, release_generation, created_at, updated_at)
         VALUES ('contracted', 'admin', 'app-contracted-selection', 'sha256:release', 1, ?, ?)`,
      )
      .run(now, now);
    store.saveDesiredApplicationSpec({
      digest: compiled.digest,
      deploymentName: 'contracted',
      apiVersion: compiled.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: compiled.canonicalJson,
      createdBy: 'admin',
    });

    await assert.rejects(
      () =>
        replicas.keepApplicationOnSuitcase({
          appId: 'app-contracted-selection',
          siteId: 'site-away',
          dataTopology: 'site-local',
          policy: 'none',
          actor: 'admin',
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'suitcase_data_mode_not_allowed' &&
        /private-data/.test(error.message),
    );
    assert.equal(
      store
        .getSqlite()!
        .prepare(
          `SELECT 1 FROM app_replicas
            WHERE app_id = 'app-contracted-selection' AND site_id = 'site-away'`,
        )
        .get(),
      undefined,
    );
  });

  it('captures a verified initial Home checkpoint before selecting shared data', async () => {
    const source = `
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: photos
components:
  web:
    image: example/photos:1
    role: web
    mounts:
      /photos:
        resource: data
resources:
  data:
    type: volume
    durability: durable
    dataRole: files
    access: singleWriter
`;
    const compiled = specs.compileDeployYaml(source);
    const sqlite = store.getSqlite()!;
    const now = new Date().toISOString();
    const volume = join(root, 'photos-volume');
    mkdirSync(volume, { recursive: true });
    writeFileSync(join(volume, 'upload.txt'), 'home photo');
    sqlite
      .prepare(
        `INSERT INTO deployments
          (name, username, app_id, desired_spec_digest, active_spec_digest,
           reconciliation_profile_version, directory, created_at, updated_at)
         VALUES ('photos', 'admin', 'app-photos', ?, ?, 'profile-photos', ?, ?, ?)`,
      )
      .run(compiled.digest, compiled.digest, root, now, now);
    sqlite
      .prepare(
        `INSERT INTO application_spec_revisions
          (digest, deployment_name, api_version, source, manifest_format,
           normalized_spec, created_by, created_at)
         VALUES (?, 'photos', 'deploy.local/v1', 'repository', 'deploy.yaml', ?, 'admin', ?)`,
      )
      .run(compiled.digest, compiled.canonicalJson, now);
    sqlite
      .prepare(
        `INSERT INTO data_reconciliation_profiles
          (id, app_id, version, analyzer_version, sqlite_files, eligible_tables,
           excluded_tables, upload_paths, opaque_paths, compatibility_digest, findings, created_at)
         VALUES ('profile-photos', 'app-photos', 'profile-photos', '1.0.0', '[]', '[]', '[]',
                 '["data/upload.txt"]', '[]', 'sha256:compatibility', '[]', ?)`,
      )
      .run(now);
    sqlite
      .prepare(
        `INSERT INTO portability_reports
          (id, app_id, spec_digest, site_id, analyzer_version, classification,
           capability_vector, findings, evidence, profile_digest, created_at)
         VALUES ('report-photos', 'app-photos', ?, 'site-away', '1.0.0', 'file-replica',
                 ?, '[]', '[]', 'profile-photos', ?)`,
      )
      .run(compiled.digest, validatedCapabilityVector(), now);
    const executor = {
      async createRecoveryPoint(
        context: {
          applicationId: string;
          siteId: string;
          runtime: { execution: { specDigest: string }; configurationDigest: string };
        },
        destination: string,
      ) {
        mkdirSync(destination, { recursive: true });
        const archive = join(destination, 'data.tar.gz');
        execFileSync('tar', ['-czf', archive, '-C', volume, '.']);
        const archiveBytes = readFileSync(archive);
        const digest = (value: Buffer) =>
          `sha256:${createHash('sha256').update(value).digest('hex')}` as `sha256:${string}`;
        const recovery = {
          version: 1,
          applicationId: context.applicationId,
          siteId: context.siteId,
          specDigest: context.runtime.execution.specDigest,
          configurationDigest: context.runtime.configurationDigest,
          resources: [
            {
              resource: 'data',
              archive: 'data.tar.gz',
              digest: digest(archiveBytes),
              bytes: statSync(archive).size,
            },
          ],
        };
        const artifactReference = join(destination, 'recovery-manifest.json');
        const bytes = Buffer.from(`${JSON.stringify(recovery, null, 2)}\n`);
        writeFileSync(artifactReference, bytes);
        return { artifactReference, artifactDigest: digest(bytes), verification: 'test' };
      },
      async restoreRecoveryPoint() {},
    };
    const selected = await replicas.keepApplicationOnSuitcase({
      appId: 'app-photos',
      siteId: 'site-away',
      policy: 'automatic',
      actor: 'admin',
      executor,
    });
    assert.equal(selected.sharedLineage, true);
    const replica = sqlite
      .prepare(
        `SELECT base_checkpoint_id, profile_version FROM app_replicas
          WHERE app_id = 'app-photos' AND site_id = 'site-away'`,
      )
      .get() as { base_checkpoint_id: string; profile_version: string };
    assert.ok(replica.base_checkpoint_id);
    assert.equal(replica.profile_version, 'profile-photos');
    const checkpoint = sqlite
      .prepare('SELECT verification_status FROM data_checkpoints WHERE id = ?')
      .get(replica.base_checkpoint_id) as { verification_status: string };
    assert.equal(checkpoint.verification_status, 'verified');
  });

  it('offers an explicit Follows one site topology for opaque but runnable volumes', async () => {
    const now = new Date().toISOString();
    const sqlite = store.getSqlite()!;
    sqlite
      .prepare(
        `INSERT INTO deployments
          (name, username, app_id, desired_release_digest, release_generation, created_at, updated_at)
         VALUES ('opaque', 'admin', 'app-opaque', 'sha256:release', 1, ?, ?)`,
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO portability_reports
          (id, app_id, spec_digest, site_id, analyzer_version, classification,
           capability_vector, findings, evidence, created_at)
         VALUES ('report-opaque', 'app-opaque', 'sha256:spec', 'site-away', '1.0.0',
                 'follows-one-site', ?, '[]', '[]', ?)`,
      )
      .run(validatedCapabilityVector(false), now);
    await assert.rejects(
      () =>
        replicas.keepApplicationOnSuitcase({
          appId: 'app-opaque',
          siteId: 'site-away',
          policy: 'manual',
          dataTopology: 'follows-one-site',
          actor: 'admin',
        }),
      /explicit initial writer site/,
    );
    const homeSiteId = multisite.ensureFleetIdentity().homeSiteId;
    const selected = await replicas.keepApplicationOnSuitcase({
      appId: 'app-opaque',
      siteId: 'site-away',
      policy: 'manual',
      dataTopology: 'follows-one-site',
      initialWriterSiteId: homeSiteId,
      actor: 'admin',
    });
    assert.deepEqual(
      {
        topology: selected.dataTopology,
        policy: selected.policy,
        sharedLineage: selected.sharedLineage,
      },
      { topology: 'follows-one-site', policy: 'manual', sharedLineage: false },
    );
    const replica = sqlite
      .prepare(
        `SELECT data_mode, sync_policy, shared_lineage
           FROM app_replicas WHERE app_id = 'app-opaque' AND site_id = 'site-away'`,
      )
      .get();
    assert.deepEqual(replica, {
      data_mode: 'follows-one-site-target',
      sync_policy: 'manual',
      shared_lineage: 0,
    });
    const event = sqlite
      .prepare(
        `SELECT payload FROM fleet_events
          WHERE app_id = 'app-opaque' AND operation = 'application.replica.selected'`,
      )
      .get() as { payload: string };
    assert.equal(JSON.parse(event.payload).initialWriterSiteId, homeSiteId);
  });

  it('records the exact lost-replica checkpoint boundary and requires acknowledgement', () => {
    assert.throws(
      () =>
        replicas.removeLostApplicationReplica({
          appId: 'app-notes',
          siteId: 'site-away',
          actor: 'admin',
          acknowledgeUnreceivedDataLoss: false,
        }),
      /acknowledgement/,
    );
    const removed = replicas.removeLostApplicationReplica({
      appId: 'app-notes',
      siteId: 'site-away',
      actor: 'admin',
      acknowledgeUnreceivedDataLoss: true,
    });
    assert.equal(removed.lastAdoptedCheckpointId, null);
  });
});
