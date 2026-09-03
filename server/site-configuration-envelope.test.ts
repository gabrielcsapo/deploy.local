import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { compileApplicationManifest } from './application-spec.ts';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let configuration: typeof import('./application-configuration.ts');
let envelopes: typeof import('./site-configuration-envelope.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-site-envelope-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?site-envelope=${Date.now()}`);
  multisite = await import(`./multisite.ts?site-envelope=${Date.now()}`);
  configuration = await import(`./application-configuration.ts?site-envelope=${Date.now()}`);
  envelopes = await import(`./site-configuration-envelope.ts?site-envelope=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('site-specific configuration envelopes', () => {
  it('transports application secrets without exposing plaintext and rejects tampering', () => {
    store.registerDeploymentStart('notes', 'owner', 'application-graph');
    const appId = multisite.registerApplicationIdentity('notes');
    const compiled = compileApplicationManifest({
      apiVersion: 'deploy.local/v1',
      kind: 'Application',
      configuration: {
        SESSION_SECRET: { type: 'secret', required: true, scope: 'application' },
        DEVICE_NAME: { type: 'string', required: true, scope: 'site' },
      },
      components: {
        web: {
          image:
            'example/notes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          environment: { SESSION_SECRET: { from: 'configuration.SESSION_SECRET' } },
        },
      },
    });
    store.saveDesiredApplicationSpec({
      digest: compiled.digest,
      deploymentName: 'notes',
      apiVersion: 'deploy.local/v1',
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: compiled.canonicalJson,
      createdBy: 'owner',
    });
    configuration.setDeclaredConfigurationValue({
      deploymentName: 'notes',
      specDigest: compiled.digest,
      declarations: compiled.spec.configuration,
      key: 'SESSION_SECRET',
      value: 'vacation-secret-value',
      updatedBy: 'owner',
    });
    const pairing = multisite.createSuitcasePairing({ name: 'Travel', createdBy: 'owner' });
    const site = multisite.redeemSuitcasePairing({
      code: pairing.code,
      publicKey: 'test-public-key',
      platform: 'linux',
      architecture: 'arm64',
      version: 'test',
    });
    const projection = envelopes.projectApplicationConfigurationToSite({
      appId,
      siteId: site.siteId,
      actor: 'owner',
    });
    assert.equal(JSON.stringify(projection).includes('vacation-secret-value'), false);
    assert.deepEqual(projection.missingApplicationValues, []);
    assert.deepEqual(
      envelopes.applySiteConfigurationProjection({
        projection,
        localSiteId: 'site_not_the_target',
        siteCredential: site.credential,
        actor: 'fleet-sync',
      }),
      { applied: 0, missingSiteValues: [] },
    );

    store
      .getSqlite()!
      .prepare('DELETE FROM application_configuration_values WHERE deployment_name = ?')
      .run('notes');
    const applied = envelopes.applySiteConfigurationProjection({
      projection,
      localSiteId: site.siteId,
      siteCredential: site.credential,
      actor: 'fleet-sync',
    });
    assert.equal(applied.applied, 1);
    assert.deepEqual(applied.missingSiteValues, ['DEVICE_NAME']);
    const resolved = configuration.resolveApplicationConfiguration({
      deploymentName: 'notes',
      specDigest: compiled.digest,
      declarations: compiled.spec.configuration,
      siteId: site.siteId,
    });
    assert.equal(resolved.values.SESSION_SECRET, 'vacation-secret-value');

    const tampered = structuredClone(projection);
    tampered.envelopes[0]!.ciphertext = `${tampered.envelopes[0]!.ciphertext}A`;
    assert.throws(
      () =>
        envelopes.applySiteConfigurationProjection({
          projection: tampered,
          localSiteId: site.siteId,
          siteCredential: site.credential,
          actor: 'fleet-sync',
        }),
      /authenticate|Unsupported state|invalid/i,
    );
  });
});
