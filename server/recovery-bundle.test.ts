import { materializeCheckpoint } from './workspace/checkpoint-storage.ts';
import { getRequestsSqlite } from './requests-db.ts';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  truncateSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

let root: string;
let store: typeof import('./store.ts');
let recovery: typeof import('./recovery-bundle.ts');
let operations: typeof import('./operations-handler.ts');
let localSite: typeof import('./local-site.ts');
let secrets: typeof import('./secrets.ts');
let certs: typeof import('./certs.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-recovery-bundle-'));
  process.env.DEPLOY_DATA_DIR = join(root, 'home');
  store = await import(`./store.ts?recovery=${Date.now()}`);
  recovery = await import(`./recovery-bundle.ts?recovery=${Date.now()}`);
  operations = await import(`./operations-handler.ts?recovery=${Date.now()}`);
  localSite = await import(`./local-site.ts?recovery=${Date.now()}`);
  secrets = await import(`./secrets.ts?recovery=${Date.now()}`);
  certs = await import(`./certs.ts?recovery=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('encrypted Home recovery bundle', () => {
  it('verifies offline and restores fleet identity/control state onto a clean Home', async () => {
    const fleet = localSite.ensureLocalIdentity('Family Fleet');
    secrets.loadOrCreateSecretKey();
    certs.ensureCerts();
    const fleetCaKey = readFileSync(join(root, 'home', 'certs', 'ca.key'));
    const fleetCaCertificate = readFileSync(join(root, 'home', 'certs', 'ca.crt'));
    const firstNormalizedSpec =
      '{"apiVersion":"deploy.local/v1","kind":"Application","metadata":{"name":"calendar"}}';
    const secondNormalizedSpec =
      '{"apiVersion":"deploy.local/v1","kind":"Application","metadata":{"description":"shared","name":"calendar"}}';
    const firstSpecDigest = `sha256:${createHash('sha256').update(firstNormalizedSpec).digest('hex')}`;
    const secondSpecDigest = `sha256:${createHash('sha256').update(secondNormalizedSpec).digest('hex')}`;
    const firstOriginalSource =
      'apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: calendar\n';
    const secondOriginalSource = `${firstOriginalSource}  description: shared\n`;
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO deployments
          (name, username, app_id, release_authority_epoch, release_generation,
           created_at, updated_at)
         VALUES ('calendar', 'admin', 'app-calendar', 3, 6, ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    store.saveDesiredApplicationSpec({
      digest: firstSpecDigest,
      deploymentName: 'calendar',
      apiVersion: 'deploy.local/v1',
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: firstNormalizedSpec,
      originalSource: firstOriginalSource,
      createdBy: 'admin',
    });
    store.saveDesiredApplicationSpec({
      digest: secondSpecDigest,
      deploymentName: 'calendar',
      parentDigest: firstSpecDigest,
      apiVersion: 'deploy.local/v1',
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: secondNormalizedSpec,
      originalSource: secondOriginalSource,
      createdBy: 'admin',
    });
    store.activateDesiredApplicationSpec('calendar', secondSpecDigest, 'sha256:configuration');
    const databaseBeforeRecovery = store.getSqlite()!;
    const secretKey = secrets.loadOrCreateSecretKey();
    const secretAddress = secrets.secretAddress('calendar', 'SESSION_SECRET', '', secondSpecDigest);
    databaseBeforeRecovery
      .prepare(
        `INSERT INTO application_configuration_values
          (deployment_name, spec_digest, key, site_id, value_type, value,
           value_digest, revision, updated_by, updated_at)
         VALUES ('calendar', ?, 'SESSION_SECRET', '', 'secret', ?, ?, 1, 'admin', ?)`,
      )
      .run(
        secondSpecDigest,
        secrets.encryptSecret('restored-secret', secretKey, secretAddress),
        `sha256:${'9'.repeat(64)}`,
        new Date().toISOString(),
      );
    const suitcases = ['historical-site-a', 'historical-site-b'].map((siteId) => {
      const keys = generateKeyPairSync('ed25519');
      const credential = 'historical-credential-' + siteId;
      const now = new Date().toISOString();
      databaseBeforeRecovery
        .prepare(`INSERT INTO sites
        (id, fleet_id, name, kind, public_key, credential_hash, credential_status,
         capabilities, mode, default_data_policy, access_mode, security_profile,
         readiness_summary, created_at, updated_at)
        VALUES (?, ?, ?, 'suitcase', ?, ?, 'active', '{}', 'docked', 'automatic',
                'existing-lan', 'isolated', '{}', ?, ?)`)
        .run(
          siteId,
          fleet.id,
          siteId,
          keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          createHash('sha256').update(credential).digest('hex'),
          now,
          now,
        );
      return { siteId, credential };
    });
    databaseBeforeRecovery
      .prepare(
        `INSERT INTO data_sync_policies
          (app_id, site_id, policy, conflict_policy, acknowledged_risks,
           revision, updated_by, updated_at)
         VALUES ('app-calendar', ?, 'automatic', 'collect', '[]', 1, 'admin', ?),
                ('app-calendar', ?, 'manual', 'prefer-home', '["offline writes"]', 1, 'admin', ?)`,
      )
      .run(
        suitcases[0]!.siteId,
        new Date().toISOString(),
        suitcases[1]!.siteId,
        new Date().toISOString(),
      );
    databaseBeforeRecovery
      .prepare(
        `INSERT INTO data_checkpoints
          (id, app_id, parent_id, origin_site_id, sequence, manifest_artifact_digest,
           verification_status, acknowledgements, created_at)
         VALUES ('checkpoint-calendar-1', 'app-calendar', NULL, ?, 1, ?, 'verified', '{}', ?),
                ('checkpoint-calendar-2', 'app-calendar', 'checkpoint-calendar-1', ?, 2, ?,
                 'verified', '{}', ?)`,
      )
      .run(
        fleet.homeSiteId,
        `sha256:${'a'.repeat(64)}`,
        new Date().toISOString(),
        suitcases[0]!.siteId,
        `sha256:${'b'.repeat(64)}`,
        new Date().toISOString(),
      );
    databaseBeforeRecovery
      .prepare(
        `UPDATE app_replicas SET base_checkpoint_id = 'checkpoint-calendar-2'
          WHERE app_id = 'app-calendar'`,
      )
      .run();
    for (const [index, suitcase] of suitcases.entries()) {
      databaseBeforeRecovery
        .prepare(
          `INSERT INTO site_sync_cursors
            (local_site_id, remote_site_id, stream, last_accepted_sequence,
             protocol_version, last_success_at)
           VALUES (?, ?, 'control', ?, 1, ?)`,
        )
        .run(fleet.homeSiteId, suitcase.siteId, 11 + index, new Date().toISOString());
    }
    databaseBeforeRecovery
      .prepare(
        `INSERT INTO release_candidates
          (id, app_id, origin_site_id, actor, base_authority_epoch, base_generation,
           state, created_at)
         VALUES ('candidate-stale-review', 'app-calendar', ?, 'admin', 3, 6,
                 'stale-authority', ?)`,
      )
      .run(suitcases[0]!.siteId, new Date().toISOString());
    mkdirSync(join(root, 'home', 'packages', 'hosted', 'sha256', 'ab'), { recursive: true });
    mkdirSync(join(root, 'home', 'packages', 'cache'), { recursive: true });
    writeFileSync(
      join(root, 'home', 'packages', 'hosted', 'sha256', 'ab', 'fixture'),
      'hosted package bytes',
    );
    writeFileSync(join(root, 'home', 'packages', 'cache', 'fixture'), 'refetchable bytes');
    getRequestsSqlite()
      .prepare(`INSERT INTO request_logs
      (deployment_name,method,path,status,duration,timestamp)
      VALUES ('calendar','GET','/recovery-history',200,7,?)`)
      .run(Date.now());
    const workspace = await import('./workspace/store.ts');
    const checkpointSnapshot = {
      files: [{ path: 'binary.dat', content: 'AP8BAg==', executable: true }],
      excluded: [],
      digest: 'fixture',
    };
    workspace.save('checkpoint', 'admin', {
      id: 'external-checkpoint',
      snapshot: checkpointSnapshot,
    });
    workspace.db
      .prepare("INSERT INTO records VALUES('checkpoint','inline-checkpoint','admin',?)")
      .run(JSON.stringify({ id: 'inline-checkpoint', snapshot: checkpointSnapshot }));
    const bundlePath = join(root, 'recovery.bundle');
    const passphrase = 'correct horse suitcase battery';
    const created = await recovery.createRecoveryBundle({ outputPath: bundlePath, passphrase });
    assert.rejects(
      async () => recovery.verifyRecoveryBundle({ bundlePath, passphrase: 'wrong passphrase!' }),
      /authenticate|Unsupported|invalid/i,
    );
    const verified = recovery.verifyRecoveryBundle({
      bundlePath,
      passphrase,
      bundleId: created.id,
    });
    assert.equal(created.receipt.hostedPackages.included, true);
    assert.equal(
      created.receipt.hostedPackages.byteSize,
      Buffer.byteLength('hosted package bytes'),
    );
    assert.deepEqual(verified.receipt, created.receipt);
    assert.equal(verified.fleetId, fleet.id);
    assert.ok(verified.files >= 3);

    const replacement = join(root, 'replacement-home');
    const restored = recovery.restoreRecoveryBundle({
      bundlePath,
      passphrase,
      destinationDataDirectory: replacement,
    });
    const restoredWorkspace = new Database(join(replacement, 'workspace', 'workspace.db'));
    try {
      const rows = restoredWorkspace
        .prepare("SELECT data FROM records WHERE kind='checkpoint'")
        .all() as { data: string }[];
      assert.equal(rows.length, 2);
      for (const row of rows)
        assert.deepEqual(
          materializeCheckpoint(join(replacement, 'workspace'), JSON.parse(row.data)).snapshot,
          checkpointSnapshot,
        );
    } finally {
      restoredWorkspace.close();
    }
    assert.deepEqual(restored.receipt, created.receipt);
    assert.equal(restored.fleetId, fleet.id);
    assert.equal(restored.homeSiteId, fleet.homeSiteId);
    assert.equal(
      readFileSync(join(replacement, 'packages', 'hosted', 'sha256', 'ab', 'fixture'), 'utf8'),
      'hosted package bytes',
    );
    assert.equal(existsSync(join(replacement, 'packages', 'cache')), false);
    assert.deepEqual(readFileSync(join(replacement, 'certs', 'ca.key')), fleetCaKey);
    assert.deepEqual(readFileSync(join(replacement, 'certs', 'ca.crt')), fleetCaCertificate);
    const requests = new Database(join(replacement, 'requests.db'), { readonly: true });
    assert.equal(
      (requests.prepare('SELECT path FROM request_logs').get() as { path: string }).path,
      '/recovery-history',
    );
    requests.close();
    const database = new Database(join(replacement, 'deploy.db'), { readonly: true });
    try {
      const app = database
        .prepare(
          'SELECT app_id, release_authority_epoch, release_generation FROM deployments WHERE name = ?',
        )
        .get('calendar') as {
        app_id: string;
        release_authority_epoch: number;
        release_generation: number;
      };
      assert.deepEqual(app, {
        app_id: 'app-calendar',
        release_authority_epoch: 3,
        release_generation: 7,
      });
      const restoredRevisionArtifacts = database
        .prepare(
          `SELECT digest, original_artifact_digest, normalized_artifact_digest
             FROM application_spec_revisions
            WHERE deployment_name = 'calendar'
            ORDER BY created_at`,
        )
        .all() as Array<{
        digest: string;
        original_artifact_digest: string;
        normalized_artifact_digest: string;
      }>;
      assert.equal(restoredRevisionArtifacts.length, 2);
      for (const revision of restoredRevisionArtifacts) {
        assert.equal(revision.normalized_artifact_digest, revision.digest);
        for (const digest of [
          revision.original_artifact_digest,
          revision.normalized_artifact_digest,
        ]) {
          const artifact = database
            .prepare(`SELECT local_path, verification_status FROM artifacts WHERE digest = ?`)
            .get(digest) as { local_path: string; verification_status: string };
          assert.equal(artifact.verification_status, 'verified');
          assert.equal(existsSync(artifact.local_path), true);
          assert.equal(
            `sha256:${createHash('sha256').update(readFileSync(artifact.local_path)).digest('hex')}`,
            digest,
          );
          assert.equal(artifact.local_path.startsWith(replacement), true);
        }
      }
      const restoredFleet = database.prepare('SELECT id, home_site_id FROM fleets').get() as {
        id: string;
        home_site_id: string;
      };
      assert.deepEqual(restoredFleet, { id: fleet.id, home_site_id: fleet.homeSiteId });
      const restoredSites = database
        .prepare(
          `SELECT id, credential_hash, credential_status
             FROM sites WHERE kind = 'suitcase' ORDER BY name`,
        )
        .all() as Array<{
        id: string;
        credential_hash: string;
        credential_status: string;
      }>;
      assert.equal(restoredSites.length, 2);
      for (const suitcase of suitcases) {
        const restoredSite = restoredSites.find((site) => site.id === suitcase.siteId);
        assert.equal(restoredSite?.credential_status, 'active');
        assert.equal(
          restoredSite?.credential_hash,
          createHash('sha256').update(suitcase.credential).digest('hex'),
        );
      }
      const restoredCursors = database
        .prepare(
          `SELECT remote_site_id, last_accepted_sequence
             FROM site_sync_cursors WHERE local_site_id = ? ORDER BY remote_site_id`,
        )
        .all(fleet.homeSiteId) as Array<{
        remote_site_id: string;
        last_accepted_sequence: number;
      }>;
      assert.deepEqual(
        restoredCursors.map((cursor) => cursor.last_accepted_sequence).sort((a, b) => a - b),
        [11, 12],
      );
      assert.deepEqual(
        database
          .prepare('SELECT state, base_generation FROM release_candidates WHERE id = ?')
          .get('candidate-stale-review'),
        { state: 'stale-authority', base_generation: 6 },
      );
    } finally {
      database.close();
    }
    const rehearsalResponse = await operations.handleOperationsRequest({
      method: 'POST',
      pathname: `/operations/recovery-bundles/${created.id}/rehearsal`,
      actor: { username: 'admin', role: 'admin' },
      body: { bundlePath, passphrase },
    });
    assert.equal(rehearsalResponse.status, 200);
    const rehearsal =
      rehearsalResponse.body as import('./recovery-bundle.ts').RecoveryRehearsalReport;
    assert.equal(rehearsal.passed, true);
    assert.equal('activeSuitcaseCredentials' in rehearsal.checks, false);
    assert.equal(rehearsal.checks.applicationRevisions, 2);
    assert.equal(rehearsal.checks.applicationAliases, 1);
    assert.equal(rehearsal.checks.dataPolicies, 2);
    assert.equal(rehearsal.checks.checkpoints, 2);
    assert.equal(rehearsal.checks.encryptedConfigurationValues, 1);
    assert.equal(rehearsal.checks.caKeyPair, true);
    assert.equal(rehearsal.checks.homeSigningIdentity, true);

    const record = store
      .getSqlite()!
      .prepare(
        'SELECT verification_status, rehearsal_status FROM fleet_recovery_bundles WHERE id = ?',
      )
      .get(created.id) as { verification_status: string; rehearsal_status: string };
    assert.deepEqual(record, { verification_status: 'verified', rehearsal_status: 'passed' });
  });

  it('refuses to export a database whose external checkpoint body is missing', async () => {
    const workspace = await import('./workspace/store.ts');
    workspace.db.prepare("INSERT INTO records VALUES('checkpoint','missing-body','admin',?)").run(
      JSON.stringify({
        id: 'missing-body',
        snapshotBlob: { digest: 'sha256:' + 'f'.repeat(64), byteSize: 123 },
      }),
    );
    try {
      await assert.rejects(
        recovery.createRecoveryBundle({
          outputPath: join(root, 'missing-body.bundle'),
          passphrase: 'correct horse suitcase battery',
        }),
        /ENOENT/,
      );
      assert.equal(existsSync(join(root, 'missing-body.bundle')), false);
    } finally {
      workspace.remove('checkpoint', 'admin', 'missing-body');
    }
  });

  it('omits all hosted files over the cap while preserving verified, restorable core recovery', async () => {
    const folder = join(root, 'home', 'packages', 'hosted');
    mkdirSync(folder, { recursive: true });
    const large = join(folder, 'large-sparse');
    writeFileSync(large, '');
    truncateSync(large, 256 * 1024 * 1024 + 1);
    const bundlePath = join(root, 'without-hosted.bundle');
    const passphrase = 'correct horse suitcase battery';
    try {
      const created = await recovery.createRecoveryBundle({ outputPath: bundlePath, passphrase });
      assert.equal(created.receipt.hostedPackages.included, false);
      assert.ok(created.receipt.hostedPackages.byteSize > 256 * 1024 * 1024);
      assert.equal(created.receipt.hostedPackages.limitBytes, 128 * 1024 * 1024);
      const row = store
        .getSqlite()!
        .prepare('SELECT encryption_metadata FROM fleet_recovery_bundles WHERE id=?')
        .get(created.id) as { encryption_metadata: string };
      assert.deepEqual(JSON.parse(row.encryption_metadata).receipt, created.receipt);
      const verified = recovery.verifyRecoveryBundle({
        bundlePath,
        passphrase,
        bundleId: created.id,
      });
      assert.deepEqual(verified.receipt, created.receipt);
      const destination = join(root, 'without-hosted-restored');
      const restored = recovery.restoreRecoveryBundle({
        bundlePath,
        passphrase,
        destinationDataDirectory: destination,
      });
      assert.deepEqual(restored.receipt, created.receipt);
      assert.equal(existsSync(join(destination, 'packages', 'hosted')), false);
      assert.deepEqual(
        readFileSync(join(destination, 'certs', 'ca.key')),
        readFileSync(join(root, 'home', 'certs', 'ca.key')),
      );
      assert.ok(existsSync(join(destination, 'deploy.db')));
      assert.equal(
        recovery.rehearseRecoveryBundle({ bundleId: created.id, bundlePath, passphrase }).passed,
        true,
      );
    } finally {
      rmSync(large, { force: true });
    }
  });

  it('records a matching verified bundle as failed when restored lineage is broken', async () => {
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO deployments
          (name, username, app_id, active_spec_digest, created_at, updated_at)
         VALUES ('broken-lineage', 'admin', 'app-broken-lineage', ?, ?, ?)`,
      )
      .run(`sha256:${'f'.repeat(64)}`, now, now);
    const bundlePath = join(root, 'broken-lineage.bundle');
    const passphrase = 'broken lineage recovery rehearsal';
    const bundle = await recovery.createRecoveryBundle({ outputPath: bundlePath, passphrase });
    recovery.verifyRecoveryBundle({ bundlePath, passphrase, bundleId: bundle.id });
    assert.throws(
      () =>
        recovery.rehearseRecoveryBundle({
          bundleId: bundle.id,
          bundlePath,
          passphrase,
        }),
      /missing revision/,
    );
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          'SELECT verification_status, rehearsal_status FROM fleet_recovery_bundles WHERE id = ?',
        )
        .get(bundle.id),
      { verification_status: 'verified', rehearsal_status: 'failed' },
    );
  });
});
