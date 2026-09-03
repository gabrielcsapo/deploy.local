import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

let root: string;
let store: typeof import('./store.ts');
let recovery: typeof import('./recovery-bundle.ts');
let operations: typeof import('./operations-handler.ts');
let multisite: typeof import('./multisite.ts');
let secrets: typeof import('./secrets.ts');
let certs: typeof import('./certs.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-recovery-bundle-'));
  process.env.DEPLOY_DATA_DIR = join(root, 'home');
  store = await import(`./store.ts?recovery=${Date.now()}`);
  recovery = await import(`./recovery-bundle.ts?recovery=${Date.now()}`);
  operations = await import(`./operations-handler.ts?recovery=${Date.now()}`);
  multisite = await import(`./multisite.ts?recovery=${Date.now()}`);
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
    const fleet = multisite.ensureFleetIdentity('Family Fleet');
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
    const suitcases = ['Vacation Suitcase', 'Work Suitcase'].map((name) => {
      const pairing = multisite.createSuitcasePairing({
        name,
        createdBy: 'admin',
        defaultDataPolicy: 'automatic',
        accessMode: 'existing-lan',
      });
      const keys = generateKeyPairSync('ed25519');
      const paired = multisite.redeemSuitcasePairing({
        code: pairing.code,
        publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        platform: 'linux',
        architecture: 'arm64',
        version: '1.0.0',
      });
      return {
        ...paired,
        privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      };
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
    assert.equal(verified.fleetId, fleet.id);
    assert.ok(verified.files >= 3);

    const replacement = join(root, 'replacement-home');
    const restored = recovery.restoreRecoveryBundle({
      bundlePath,
      passphrase,
      destinationDataDirectory: replacement,
    });
    assert.equal(restored.fleetId, fleet.id);
    assert.equal(restored.homeSiteId, fleet.homeSiteId);
    assert.deepEqual(readFileSync(join(replacement, 'certs', 'ca.key')), fleetCaKey);
    assert.deepEqual(readFileSync(join(replacement, 'certs', 'ca.crt')), fleetCaCertificate);
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
        assert.equal(restoredSite?.credential_status, 'recovery-pending');
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
    assert.equal(rehearsal.checks.activeSuitcaseCredentials, 2);
    assert.equal(rehearsal.checks.applicationRevisions, 2);
    assert.equal(rehearsal.checks.applicationAliases, 1);
    assert.equal(rehearsal.checks.dataPolicies, 2);
    assert.equal(rehearsal.checks.checkpoints, 2);
    assert.equal(rehearsal.checks.encryptedConfigurationValues, 1);
    assert.equal(rehearsal.checks.caKeyPair, true);
    assert.equal(rehearsal.checks.homeSigningIdentity, true);

    const storeUrl = pathToFileURL(resolve('server/store.ts')).href;
    const multisiteUrl = pathToFileURL(resolve('server/multisite.ts')).href;
    const transportUrl = pathToFileURL(resolve('server/suitcase-transport.ts')).href;
    const readoptionUrl = pathToFileURL(resolve('server/recovery-readoption.ts')).href;
    const childScript = `
      const crypto = await import('node:crypto');
      const store = await import(${JSON.stringify(storeUrl)});
      const multisite = await import(${JSON.stringify(multisiteUrl)});
      const transport = await import(${JSON.stringify(transportUrl)});
      const readoption = await import(${JSON.stringify(readoptionUrl)});
      const expected = JSON.parse(process.env.DEPLOY_RECOVERY_EXPECTED);
      const database = store.getSqlite();
      const before = {
        fleets: database.prepare('SELECT COUNT(*) AS count FROM fleets').get().count,
        sites: database.prepare('SELECT COUNT(*) AS count FROM sites').get().count,
      };
      const fleet = multisite.ensureFleetIdentity();
      const proofFor = (site, purpose, credential, acknowledgedLocalSequence) => {
        const proof = {
          schemaVersion: 1,
          purpose,
          siteId: site.siteId,
          fleetId: expected.fleetId,
          homeSiteId: expected.homeSiteId,
          protocolVersion: 1,
          acknowledgedLocalSequence,
          acknowledgedLocalTelemetrySequence: 0,
          cursors: {},
          applications: [{
            appId: 'app-calendar',
            authorityEpoch: 3,
            generation: 7,
            baseCheckpointId: 'checkpoint-calendar-2',
            branchCheckpointId: null,
          }],
          proposedCredentialHash: crypto.createHash('sha256').update(credential).digest('hex'),
          nonce: crypto.randomBytes(24).toString('base64url'),
          createdAt: new Date().toISOString(),
        };
        return {
          proof,
          signature: crypto.sign(
            null,
            Buffer.from(multisite.canonicalFleetPayload(proof)),
            crypto.createPrivateKey(site.privateKey),
          ).toString('base64url'),
        };
      };
      let fault;
      const faultSite = expected.suitcases[0];
      try {
        const invalid = proofFor(faultSite, 'home-recovery-readoption', 'new-fault', 13);
        readoption.completeSiteCredentialProof({
          siteId: faultSite.siteId,
          credential: faultSite.credential,
          ...invalid,
          expectedPurpose: 'home-recovery-readoption',
        });
      } catch (error) {
        fault = { code: error.code, blockers: error.details?.blockers || [] };
      }
      const faultStatus = database
        .prepare('SELECT credential_status, quarantine_reason FROM sites WHERE id = ?')
        .get(faultSite.siteId);
      const adopted = expected.suitcases.map((site, index) => {
        const credential = 'site_secret_recovered_' + index;
        const signed = proofFor(site, 'home-recovery-readoption', credential, 11 + index);
        const result = readoption.completeSiteCredentialProof({
          siteId: site.siteId,
          credential: site.credential,
          ...signed,
          expectedPurpose: 'home-recovery-readoption',
        });
        return { site, credential, result };
      });
      const exchanges = adopted.map(({ site, credential }) => {
        const auth = transport.authorizeSuitcaseSite({
          siteId: site.siteId,
          credential,
          protocolVersion: 1,
        });
        return transport.exchangeSuitcaseEvents(auth, {
          protocolVersion: 1,
          fleetId: expected.fleetId,
          cursors: {},
          events: [],
        });
      });
      let oldCredentialCode;
      try {
        transport.authorizeSuitcaseSite({
          siteId: faultSite.siteId,
          credential: faultSite.credential,
          protocolVersion: 1,
        });
      } catch (error) {
        oldCredentialCode = error.code;
      }
      readoption.requestSiteCredentialRotation({ siteId: faultSite.siteId, actor: 'admin' });
      let rotationRequiredCode;
      try {
        transport.authorizeSuitcaseSite({
          siteId: faultSite.siteId,
          credential: adopted[0].credential,
          protocolVersion: 1,
        });
      } catch (error) {
        rotationRequiredCode = error.code;
      }
      const rotatedCredential = 'site_secret_rotated_again';
      const rotation = proofFor(
        faultSite,
        'credential-rotation',
        rotatedCredential,
        11,
      );
      readoption.completeSiteCredentialProof({
        siteId: faultSite.siteId,
        credential: adopted[0].credential,
        ...rotation,
        expectedPurpose: 'credential-rotation',
      });
      const rotatedAuth = transport.authorizeSuitcaseSite({
        siteId: faultSite.siteId,
        credential: rotatedCredential,
        protocolVersion: 1,
      });
      const fleetRotation = readoption.requestSiteCredentialRotation({ actor: 'fleet-admin' });
      const after = {
        fleets: database.prepare('SELECT COUNT(*) AS count FROM fleets').get().count,
        sites: database.prepare('SELECT COUNT(*) AS count FROM sites').get().count,
      };
      const ids = database.prepare('SELECT id FROM sites ORDER BY id').all().map((row) => row.id);
      console.log(JSON.stringify({
        fleet,
        before,
        after,
        uniqueSiteIds: new Set(ids).size,
        fault,
        faultStatus,
        oldCredentialCode,
        rotationRequiredCode,
        rotatedSiteId: rotatedAuth.siteId,
        fleetRotationCount: fleetRotation.count,
        exchanges: exchanges.map((exchange) => ({
          fleetId: exchange.fleetId,
          homeSiteId: exchange.homeSiteId,
          siteId: exchange.siteId,
        })),
      }));
      store._resetDb();
    `;
    const childOutput = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childScript],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          DEPLOY_DATA_DIR: replacement,
          DEPLOY_SUITCASE: '',
          DEPLOY_SUITCASE_MEMBERSHIP_FILE: '',
          DEPLOY_RECOVERY_EXPECTED: JSON.stringify({
            fleetId: fleet.id,
            homeSiteId: fleet.homeSiteId,
            suitcases: suitcases.map((site) => ({
              siteId: site.siteId,
              credential: site.credential,
              privateKey: site.privateKey,
            })),
          }),
        },
      },
    ).trim();
    const restoredExchange = JSON.parse(childOutput.split('\n').at(-1)!) as {
      fleet: { id: string; homeSiteId: string };
      before: { fleets: number; sites: number };
      after: { fleets: number; sites: number };
      uniqueSiteIds: number;
      fault: { code: string; blockers: string[] };
      faultStatus: { credential_status: string; quarantine_reason: string };
      oldCredentialCode: string;
      rotationRequiredCode: string;
      rotatedSiteId: string;
      fleetRotationCount: number;
      exchanges: Array<{ fleetId: string; homeSiteId: string; siteId: string }>;
    };
    assert.equal(restoredExchange.fleet.id, fleet.id);
    assert.equal(restoredExchange.fleet.homeSiteId, fleet.homeSiteId);
    assert.deepEqual(restoredExchange.after, restoredExchange.before);
    assert.equal(restoredExchange.before.fleets, 1);
    assert.equal(restoredExchange.uniqueSiteIds, restoredExchange.before.sites);
    assert.equal(restoredExchange.fault.code, 'recovery_review_required');
    assert.ok(restoredExchange.fault.blockers.some((blocker) => blocker.includes('event 13')));
    assert.equal(restoredExchange.faultStatus.credential_status, 'recovery-pending');
    assert.match(restoredExchange.faultStatus.quarantine_reason, /review-required/);
    assert.equal(restoredExchange.oldCredentialCode, 'invalid_credential');
    assert.equal(restoredExchange.rotationRequiredCode, 'credential_rotation_required');
    assert.equal(restoredExchange.rotatedSiteId, suitcases[0]!.siteId);
    assert.equal(restoredExchange.fleetRotationCount, 2);
    assert.deepEqual(
      restoredExchange.exchanges.map((exchange) => exchange.siteId).sort(),
      suitcases.map((site) => site.siteId).sort(),
    );
    for (const exchange of restoredExchange.exchanges) {
      assert.equal(exchange.fleetId, fleet.id);
      assert.equal(exchange.homeSiteId, fleet.homeSiteId);
    }
    const record = store
      .getSqlite()!
      .prepare(
        'SELECT verification_status, rehearsal_status FROM fleet_recovery_bundles WHERE id = ?',
      )
      .get(created.id) as { verification_status: string; rehearsal_status: string };
    assert.deepEqual(record, { verification_status: 'verified', rehearsal_status: 'passed' });
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
