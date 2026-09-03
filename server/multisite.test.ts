import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let dataDirectory: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let catalogTargets: typeof import('./catalog/targets.ts');

before(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-multisite-'));
  process.env.DEPLOY_DATA_DIR = dataDirectory;
  store = await import(`./store.ts?multisite=${Date.now()}`);
  multisite = await import(`./multisite.ts?multisite=${Date.now()}`);
  catalogTargets = await import(`./catalog/targets.ts?multisite=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe('fleet and suitcase identity', () => {
  it('backfills stable app identities without changing aliases', () => {
    store.saveDeployment({ name: 'family-notes', username: 'alice', port: 43123 });
    const fleet = multisite.ensureFleetIdentity('Family Fleet');
    const deployment = store
      .getSqlite()!
      .prepare('SELECT name, app_id FROM deployments WHERE name = ?')
      .get('family-notes') as { name: string; app_id: string };

    assert.match(fleet.id, /^fleet_/);
    assert.match(fleet.homeSiteId, /^site_/);
    assert.match(deployment.app_id, /^app_/);
    assert.equal(deployment.name, 'family-notes');
    const topology = multisite.listTopology();
    assert.equal(topology.sites.length, 1);
    assert.equal(topology.sites[0].kind, 'home');
    assert.equal(topology.applications[0].name, 'family-notes');
    assert.equal(topology.applications[0].replica_count, 1);
  });

  it('pairs distinct suitcase identities with an explicit safe default policy', () => {
    const pairing = multisite.createSuitcasePairing({
      name: 'Vacation Suitcase',
      createdBy: 'alice',
      accessMode: 'host-hotspot',
    });
    assert.equal(pairing.defaultDataPolicy, 'none');

    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const redeemed = multisite.redeemSuitcasePairing({
      code: pairing.code,
      publicKey,
      platform: 'linux',
      architecture: 'arm64',
      version: '1.0.0',
      capabilities: { docker: true, memoryBytes: 8 * 1024 ** 3 },
    });

    assert.equal(redeemed.defaultDataPolicy, 'none');
    assert.equal(multisite.authenticateSite(redeemed.siteId, redeemed.credential), true);
    multisite.updateSitePresence({
      siteId: redeemed.siteId,
      mode: 'docked',
      capabilities: {
        dockerTarget: true,
        memoryBytes: 8 * 1024 ** 3,
        catalog: {
          deployLocalVersion: '1.0.0',
          engineVersion: '28.0.0',
          storageMiB: 32_768,
          cpuCores: 4,
          catalogExecution: true,
        },
      },
    });
    const target = new catalogTargets.DurableCatalogTargetResolver().resolve(redeemed.siteId);
    assert.equal(target.siteId, redeemed.siteId);
    assert.equal(target.siteKind, 'suitcase');
    assert.equal(target.architecture, 'arm64');
    assert.equal(target.memoryMiB, 8192);
    assert.equal(target.storageMiB, 32_768);
    assert.equal(target.capabilities.catalogExecution, true);
    assert.equal(target.online, true);
    assert.throws(
      () =>
        multisite.redeemSuitcasePairing({
          code: pairing.code,
          publicKey,
          platform: 'linux',
          architecture: 'arm64',
          version: '1.0.0',
        }),
      /already been used|invalid or expired/,
    );

    multisite.updateSitePresence({
      siteId: redeemed.siteId,
      mode: 'away',
      readiness: { runtime: true, build: true, access: true },
    });
    const site = multisite
      .listTopology()
      .sites.find((candidate) => candidate.id === redeemed.siteId)!;
    assert.equal(site.mode, 'away');
    assert.deepEqual(site.readiness_summary, { runtime: true, build: true, access: true });

    multisite.revokeSite(redeemed.siteId, 'Lost suitcase');
    assert.equal(multisite.authenticateSite(redeemed.siteId, redeemed.credential), false);
  });

  it('signs replayable local semantic events', () => {
    const fleet = multisite.ensureFleetIdentity();
    const event = multisite.appendLocalFleetEvent({
      originSiteId: fleet.homeSiteId,
      actor: 'alice',
      operation: 'application.replica.requested',
      payload: { app: 'family-notes' },
    });
    assert.equal(event.originSequence, 1);
    assert.equal(
      multisite.verifyRemoteFleetEvent({
        originSiteId: fleet.homeSiteId,
        fleetId: fleet.id,
        body: event.body,
        authenticatedDigest: event.authenticatedDigest,
      }),
      true,
    );
  });
});
