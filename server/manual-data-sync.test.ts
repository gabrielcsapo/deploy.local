import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let manual: typeof import('./manual-data-sync.ts');
let transport: typeof import('./suitcase-transport.ts');
let fleetHandler: typeof import('./fleet-handler.ts');
let siteId: string;
let siteCredential: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-manual-data-sync-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?manual-data-sync=${Date.now()}`);
  multisite = await import(`./multisite.ts?manual-data-sync=${Date.now()}`);
  manual = await import(`./manual-data-sync.ts?manual-data-sync=${Date.now()}`);
  transport = await import(`./suitcase-transport.ts?manual-data-sync=${Date.now()}`);
  fleetHandler = await import(`./fleet-handler.ts?manual-data-sync=${Date.now()}`);
  multisite.ensureFleetIdentity('Manual sync test fleet');
  const pairing = multisite.createSuitcasePairing({ name: 'Trip', createdBy: 'admin' });
  const keys = generateKeyPairSync('ed25519');
  const suitcase = multisite.redeemSuitcasePairing({
    code: pairing.code,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    platform: 'linux',
    architecture: 'arm64',
    version: '1.0.0',
  });
  siteId = suitcase.siteId;
  siteCredential = suitcase.credential;
  const now = new Date().toISOString();
  for (const appId of ['app-notes', 'app-files', 'app-api']) {
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO deployments (name, username, status, app_id, created_at, updated_at)
         VALUES (?, 'admin', 'running', ?, ?, ?)`,
      )
      .run(appId.slice(4), appId, now, now);
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
           readiness, created_at, updated_at)
         VALUES (?, ?, ?, 'running', 'replicated', 'manual', 1, '{}', ?, ?)`,
      )
      .run(`replica-${appId}`, appId, siteId, now, now);
  }
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('durable targeted manual data sync control', () => {
  it('transfers nothing before a request and consumes one request exactly once across replay', async () => {
    let captures = 0;
    let exchanges = 0;
    const consume = () =>
      manual.consumePendingManualDataSyncRequests({
        siteId,
        homeSiteId: multisite.ensureFleetIdentity().homeSiteId,
        async capture() {
          captures += 1;
          return { status: 'captured' };
        },
        async exchange() {
          exchanges += 1;
          return { reconciliation: 'merged' };
        },
      });

    assert.deepEqual(await consume(), []);
    assert.equal(captures, 0);
    assert.equal(exchanges, 0);

    const request = manual.createManualDataSyncRequest({
      appId: 'app-notes',
      siteId,
      actor: 'admin',
    });
    const duplicate = manual.createManualDataSyncRequest({
      appId: 'app-notes',
      siteId,
      actor: 'admin',
    });
    assert.equal(duplicate.id, request.id);
    assert.equal(duplicate.reused, true);

    const consumed = await consume();
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0]?.status, 'completed');
    assert.equal(captures, 1);
    assert.equal(exchanges, 1);
    assert.equal(
      manual.listManualDataSyncRequests({ appId: 'app-notes', siteId })[0]?.status,
      'completed',
    );

    assert.deepEqual(await consume(), []);
    assert.equal(captures, 1);
    assert.equal(exchanges, 1);
  });

  it('records failure durably and a new retry request succeeds without replaying the failure', async () => {
    let captures = 0;
    const first = manual.createManualDataSyncRequest({
      appId: 'app-files',
      siteId,
      actor: 'admin',
    });
    const failed = await manual.consumePendingManualDataSyncRequests({
      siteId,
      homeSiteId: multisite.ensureFleetIdentity().homeSiteId,
      async capture() {
        captures += 1;
        throw new Error('volume is busy');
      },
      async exchange() {
        assert.fail('failed capture must not exchange data');
      },
    });
    assert.equal(failed[0]?.status, 'failed');
    assert.match(failed[0]?.error ?? '', /volume is busy/);
    assert.equal(captures, 1);

    const retry = manual.createManualDataSyncRequest({
      appId: 'app-files',
      siteId,
      actor: 'admin',
    });
    assert.notEqual(retry.id, first.id);
    assert.equal(retry.retryOf, first.id);
    let exchanges = 0;
    const completed = await manual.consumePendingManualDataSyncRequests({
      siteId,
      homeSiteId: multisite.ensureFleetIdentity().homeSiteId,
      async capture() {
        captures += 1;
      },
      async exchange() {
        exchanges += 1;
      },
    });
    assert.equal(completed[0]?.status, 'completed');
    assert.equal(captures, 2);
    assert.equal(exchanges, 1);

    assert.deepEqual(
      await manual.consumePendingManualDataSyncRequests({
        siteId,
        homeSiteId: multisite.ensureFleetIdentity().homeSiteId,
        async capture() {
          assert.fail('completed retry must not be captured again after restart');
        },
        async exchange() {
          assert.fail('completed retry must not be exchanged again after restart');
        },
      }),
      [],
    );
  });

  it('delivers a targeted control request while no-data policy still gates ordinary transfer', () => {
    const request = manual.createManualDataSyncRequest({
      appId: 'app-notes',
      siteId,
      actor: 'admin',
    });
    store
      .getSqlite()!
      .prepare("UPDATE app_replicas SET sync_policy = 'none' WHERE app_id = ? AND site_id = ?")
      .run('app-notes', siteId);
    const auth = transport.authorizeSuitcaseSite({
      siteId,
      credential: siteCredential,
      protocolVersion: 1,
    });
    const exchange = transport.exchangeSuitcaseEvents(auth, {
      protocolVersion: 1,
      cursors: {},
      events: [],
      manualSync: false,
    });
    assert.equal(
      exchange.controlRequests.some(
        (event) => event.id === request.id && event.operation === manual.MANUAL_DATA_SYNC_REQUESTED,
      ),
      true,
    );
  });

  it('exposes request and durable status through the admin Fleet API', async () => {
    const created = await fleetHandler.handleFleetRequest({
      method: 'POST',
      pathname: '/fleet/apps/app-api/sync',
      actor: { username: 'admin', role: 'admin' },
      body: { siteId },
    });
    assert.equal(created.status, 202);
    assert.equal((created.body as { status: string }).status, 'requested');

    const status = await fleetHandler.handleFleetRequest({
      method: 'GET',
      pathname: `/fleet/apps/app-api/sync?siteId=${encodeURIComponent(siteId)}`,
      actor: { username: 'admin', role: 'admin' },
    });
    assert.equal(status.status, 200);
    assert.equal(
      (status.body as { requests: Array<{ id: string }> }).requests[0]?.id,
      (created.body as { id: string }).id,
    );

    const overview = await fleetHandler.handleFleetRequest({
      method: 'GET',
      pathname: '/fleet/topology',
      actor: { username: 'admin', role: 'admin' },
    });
    const requests = (overview.body as { manualSyncRequests: Array<{ id: string }> })
      .manualSyncRequests;
    assert.equal(
      requests.some((request) => request.id === (created.body as { id: string }).id),
      true,
    );
  });
});
