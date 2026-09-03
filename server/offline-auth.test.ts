import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let offlineAuth: typeof import('./offline-auth.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-offline-auth-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?offline-auth=${Date.now()}`);
  multisite = await import(`./multisite.ts?offline-auth=${Date.now()}`);
  offlineAuth = await import(`./offline-auth.ts?offline-auth=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('offline administrator projection', () => {
  it('projects only verifiers, restores local login, and replays by revision', () => {
    const registered = store.registerUser('owner', 'correct horse battery suitcase');
    assert.ok('token' in registered);
    store.registerUser('member', 'does not travel');
    const pairing = multisite.createSuitcasePairing({ name: 'Travel', createdBy: 'owner' });
    const site = multisite.redeemSuitcasePairing({
      code: pairing.code,
      publicKey: 'test-public-key',
      platform: 'linux',
      architecture: 'arm64',
      version: 'test',
    });

    const projection = offlineAuth.projectAdministratorsToSite(site.siteId, 'owner');
    assert.deepEqual(
      projection.users.map((user) => user.username),
      ['owner'],
    );
    assert.notEqual(projection.users[0]?.passwordVerifier, 'correct horse battery suitcase');
    assert.equal(
      store
        .getSqlite()!
        .prepare(
          "SELECT operation FROM fleet_events WHERE operation = 'fleet.administrators.projected'",
        )
        .get() !== undefined,
      true,
    );

    store.getSqlite()!.prepare('DELETE FROM sessions').run();
    store.getSqlite()!.prepare('DELETE FROM users').run();
    assert.deepEqual(offlineAuth.applyAdministratorProjection(projection, site.siteId), {
      applied: 1,
      ignored: 0,
    });
    assert.ok('token' in store.loginUser('owner', 'correct horse battery suitcase'));
    assert.deepEqual(store.loginUser('member', 'does not travel'), {
      error: 'Invalid credentials',
      status: 401,
    });
    assert.deepEqual(offlineAuth.applyAdministratorProjection(projection, 'another-site'), {
      applied: 0,
      ignored: 1,
    });
  });
});
