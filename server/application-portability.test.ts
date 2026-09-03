import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { GraphExecutorContext } from './application-graph-executor.ts';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let specs: typeof import('./application-spec.ts');
let portability: typeof import('./application-portability.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-application-portability-'));
  process.env.DEPLOY_DATA_DIR = join(root, 'control');
  store = await import(`./store.ts?application-portability=${Date.now()}`);
  multisite = await import(`./multisite.ts?application-portability=${Date.now()}`);
  specs = await import(`./application-spec.ts?application-portability=${Date.now()}`);
  portability = await import(`./application-portability.ts?application-portability=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

test('analyzes a cold Home volume snapshot and publishes the exact target profile', async () => {
  const fleet = multisite.ensureFleetIdentity();
  const now = new Date().toISOString();
  const sqlite = store.getSqlite()!;
  sqlite
    .prepare(
      `INSERT INTO sites
        (id, fleet_id, name, kind, public_key, credential_status, platform, architecture,
         capabilities, mode, default_data_policy, access_mode, security_profile,
         readiness_summary, created_at, updated_at)
       VALUES ('site-trip', ?, 'Trip', 'suitcase', 'test-key', 'active', ?, ?, ?, 'docked',
               'none', 'existing-lan', 'isolated', '{}', ?, ?)`,
    )
    .run(
      fleet.id,
      process.platform,
      process.arch,
      JSON.stringify({ dockerTarget: true, catalog: { devices: [] } }),
      now,
      now,
    );
  const compiled = specs.compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: portable-notes
components:
  web:
    image: example/portable-notes:1
    mounts:
      /data:
        resource: data
resources:
  data:
    type: volume
    durability: durable
    dataRole: files
    access: singleWriter
`);
  sqlite
    .prepare(
      `INSERT INTO deployments
        (name, username, app_id, desired_spec_digest, active_spec_digest, directory,
         created_at, updated_at)
       VALUES ('portable-notes', 'admin', 'app-portable-notes', ?, ?, ?, ?, ?)`,
    )
    .run(compiled.digest, compiled.digest, root, now, now);
  sqlite
    .prepare(
      `INSERT INTO application_spec_revisions
        (digest, deployment_name, api_version, source, manifest_format, normalized_spec,
         created_by, created_at)
       VALUES (?, 'portable-notes', 'deploy.local/v1', 'repository', 'deploy.yaml', ?, 'admin', ?)`,
    )
    .run(compiled.digest, compiled.canonicalJson, now);

  const volume = join(root, 'volume');
  mkdirSync(volume, { recursive: true });
  writeFileSync(join(volume, 'upload.txt'), 'created at Home');
  const digest = (value: Buffer) =>
    `sha256:${createHash('sha256').update(value).digest('hex')}` as `sha256:${string}`;
  const executor = {
    async createRecoveryPoint(context: GraphExecutorContext, destination: string) {
      mkdirSync(destination, { recursive: true });
      const archive = join(destination, 'data.tar.gz');
      execFileSync('tar', ['-czf', archive, '-C', volume, '.']);
      const archiveBytes = readFileSync(archive);
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

  const report = await portability.analyzeApplicationForSuitcase({
    appId: 'app-portable-notes',
    siteId: 'site-trip',
    actor: 'admin',
    executor,
    validationAdapter: {
      async inspectTarget() {
        return {
          platform: process.platform,
          architecture: process.arch,
          compatibleArchitectures: [process.arch],
          runtimeAvailable: true,
          requiredDevicesAvailable: true,
          detail: ['test target'],
        };
      },
      async verifyArtifacts() {
        return { passed: true, detail: ['verified'] };
      },
      async verifyIdentityAndSecrets() {
        return { passed: true, detail: ['resolved'] };
      },
      async startTemporaryReplica() {
        return {
          containmentEnforced: true,
          healthPassed: true,
          edgeRequestPassed: true,
          externalDependencies: [],
          validatedWorkflows: ['startup'],
          unverifiedWorkflows: [],
          observedMutablePaths: ['data/upload.txt'],
          detail: ['isolated graph passed'],
        };
      },
      async exerciseReconciliation() {
        return { passed: true, detail: ['replay passed'] };
      },
      async buildWithoutNetwork() {
        return { passed: true, detail: ['no build required'] };
      },
      async cleanup() {},
    },
  });
  assert.equal(report.classification, 'file-replica');
  assert.equal(report.capabilityVector.compute.status, 'pass');
  assert.equal(report.capabilityVector.verification.status, 'pass');
  assert.deepEqual(report.reconciliationProfile.uploadPaths, ['data/upload.txt']);
  assert.equal(
    (
      sqlite
        .prepare('SELECT reconciliation_profile_version FROM deployments WHERE app_id = ?')
        .get('app-portable-notes') as { reconciliation_profile_version: string }
    ).reconciliation_profile_version,
    report.profileDigest,
  );
  const published = sqlite
    .prepare(
      `SELECT payload FROM fleet_events
        WHERE app_id = ? AND operation = 'application.portability.reported'`,
    )
    .get('app-portable-notes') as { payload: string };
  const payload = JSON.parse(published.payload) as Record<string, unknown>;
  assert.equal(payload.targetSiteId, 'site-trip');
  assert.equal(payload.profileDigest, report.profileDigest);
  assert.deepEqual(
    payload.reconciliationProfile,
    JSON.parse(JSON.stringify(report.reconciliationProfile)),
  );

  sqlite
    .prepare(
      `INSERT INTO app_replicas
        (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
         readiness, created_at, updated_at)
       VALUES ('replica-portable-trip', 'app-portable-notes', 'site-trip', 'running',
               'follows-one-site-writer', 'manual', 0, '{}', ?, ?)`,
    )
    .run(now, now);
  await assert.rejects(
    () =>
      portability.analyzeApplicationForSuitcase({
        appId: 'app-portable-notes',
        siteId: 'site-trip',
        actor: 'admin',
        executor,
      }),
    /move authority to Home/,
  );
});
