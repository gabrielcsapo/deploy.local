import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'local-site-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('./store.ts');
const { ensureLocalIdentity, registerApplicationIdentity } = await import('./local-site.ts');
const { resolvePlacementTarget } = await import('./application-placement-target.ts');
const { DurableCatalogTargetResolver } = await import('./catalog/targets.ts');
after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

test('Home identity and application aliases survive retries without creating replication state', () => {
  store.saveDeployment({ name: 'home-app', username: 'owner' });
  const home = ensureLocalIdentity();
  const appId = registerApplicationIdentity('home-app');
  assert.deepEqual(ensureLocalIdentity(), home);
  assert.equal(registerApplicationIdentity('home-app'), appId);
  const sqlite = store.getSqlite()!;
  assert.deepEqual(
    sqlite.prepare('SELECT alias, app_id, origin_site_id FROM application_aliases').all(),
    [{ alias: 'home-app', app_id: appId, origin_site_id: home.homeSiteId }],
  );
  for (const table of ['app_replicas', 'fleet_events', 'data_sync_policies']) {
    assert.equal(
      (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
      0,
      table,
    );
  }
});

test('placement accepts enrolled computers but never a retired portable site row', async () => {
  store.ensureCoordinatorNode();
  const sqlite = store.getSqlite()!;
  const home = ensureLocalIdentity();
  const now = new Date().toISOString();
  sqlite
    .prepare(`INSERT INTO nodes (id, name, kind, platform, architecture, capabilities, enrolled_at)
    VALUES ('mac-worker', 'Mac', 'agent', 'darwin', 'arm64', '{}', ?)`)
    .run(now);
  sqlite
    .prepare(`INSERT INTO sites
    (id, fleet_id, name, kind, public_key, credential_status, capabilities, mode,
     default_data_policy, access_mode, security_profile, readiness_summary, created_at, updated_at)
    VALUES ('retired-site', ?, 'Retired', 'suitcase', 'old-key', 'active', '{}', 'docked',
    'automatic', 'existing-lan', 'isolated', '{}', ?, ?)`)
    .run(home.id, now, now);
  assert.equal(resolvePlacementTarget('coordinator')?.kind, 'coordinator');
  assert.equal(resolvePlacementTarget('mac-worker')?.kind, 'agent');
  assert.equal(resolvePlacementTarget('retired-site'), null);
  const targets = new DurableCatalogTargetResolver();
  assert.equal((await targets.resolve('mac-worker')).siteId, 'mac-worker');
  await assert.rejects(targets.resolve('retired-site'), /not found/);
});
