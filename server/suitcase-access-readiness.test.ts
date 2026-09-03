import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let access: typeof import('./suitcase-access-readiness.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-suitcase-access-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?suitcase-access=${Date.now()}`);
  multisite = await import(`./multisite.ts?suitcase-access=${Date.now()}`);
  access = await import(`./suitcase-access-readiness.ts?suitcase-access=${Date.now()}`);
  const fleet = multisite.ensureFleetIdentity();
  const now = new Date().toISOString();
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO sites
        (id, fleet_id, name, kind, public_key, credential_status, capabilities,
         mode, default_data_policy, access_mode, security_profile, readiness_summary,
         network_fingerprint, created_at, updated_at)
       VALUES ('site-client-proof', ?, 'Travel', 'suitcase', 'test-key', 'active', '{}',
               'away', 'none', 'ip', 'isolated', '{}', 'network-a', ?, ?)`,
    )
    .run(fleet.id, now, now);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

test('requires a non-loopback private client path and binds proof to time, boot, and network', () => {
  const observedAt = new Date('2026-08-08T12:00:00.000Z');
  assert.equal(
    access.recordSuitcaseClientAccess({
      siteId: 'site-client-proof',
      actor: 'admin',
      hostHeader: 'localhost:8443',
      remoteAddress: '127.0.0.1',
      now: observedAt,
    }).ready,
    false,
  );
  const recorded = access.recordSuitcaseClientAccess({
    siteId: 'site-client-proof',
    actor: 'admin',
    hostHeader: '192.168.50.2:8443',
    remoteAddress: '172.19.0.1',
    now: observedAt,
  });
  assert.equal(recorded.ready, true);
  assert.equal(recorded.proof?.host, '192.168.50.2');
  assert.equal(
    access.currentSuitcaseClientAccess('site-client-proof', new Date('2026-08-08T12:30:00.000Z'))
      .ready,
    true,
  );
  assert.equal(
    access.currentSuitcaseClientAccess('site-client-proof', new Date('2026-08-08T13:00:00.000Z'))
      .ready,
    false,
  );

  const refreshedAt = new Date('2026-08-08T13:01:00.000Z');
  access.recordSuitcaseClientAccess({
    siteId: 'site-client-proof',
    actor: 'admin',
    hostHeader: 'suitcase.local',
    remoteAddress: '192.168.50.10',
    now: refreshedAt,
  });
  store
    .getSqlite()!
    .prepare("UPDATE sites SET network_fingerprint = 'network-b' WHERE id = 'site-client-proof'")
    .run();
  assert.equal(
    access.currentSuitcaseClientAccess('site-client-proof', new Date('2026-08-08T13:02:00.000Z'))
      .ready,
    false,
  );
});
