import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'deploy-writer-authority-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('./store.ts');
const multisite = await import('./multisite.ts');
const { applicationWriterSiteId } = await import('./application-authority.ts');

before(() => store.getDb());
after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('application writer-site authority', () => {
  it('uses Home by default, the recorded opaque writer after commit, and the source during handoff', () => {
    const sqlite = store.getSqlite()!;
    const fleet = multisite.ensureFleetIdentity('Authority test fleet');
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO deployments (name, username, app_id, created_at, updated_at)
         VALUES ('authority-app', 'admin', 'app-authority', ?, ?)`,
      )
      .run(now, now);
    assert.equal(applicationWriterSiteId('app-authority'), fleet.homeSiteId);

    sqlite
      .prepare(
        `INSERT INTO sites
          (id, fleet_id, name, kind, public_key, credential_status, capabilities, mode,
           default_data_policy, access_mode, security_profile, readiness_summary,
           created_at, updated_at)
         VALUES ('site-away', ?, 'Away', 'suitcase', 'test-key', 'active', '{}', 'docked',
                 'manual', 'existing-lan', 'isolated', '{}', ?, ?)`,
      )
      .run(fleet.id, now, now);
    sqlite
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
           readiness, created_at, updated_at)
         VALUES ('replica-away', 'app-authority', 'site-away', 'running',
                 'follows-one-site-writer', 'manual', 0, '{}', ?, ?)`,
      )
      .run(now, now);
    assert.equal(applicationWriterSiteId('app-authority'), 'site-away');

    sqlite
      .prepare(
        `INSERT INTO volume_authority_transfers
          (id, app_id, source_site_id, target_site_id, state, expected_authority_epoch,
           expected_data_sequence, requested_by, requested_at, updated_at)
         VALUES ('transfer-home', 'app-authority', 'site-away', ?, 'target-ready', 1, 0,
                 'admin', ?, ?)`,
      )
      .run(fleet.homeSiteId, now, now);
    assert.equal(
      applicationWriterSiteId('app-authority'),
      'site-away',
      'the source remains authoritative until the handoff commits',
    );
  });
});
