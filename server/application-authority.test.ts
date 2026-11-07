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
    sqlite
      .prepare(
        `INSERT INTO nodes (id, name, kind, capabilities, enrolled_at)
         VALUES ('computer', 'computer', 'agent', '{}', ?),
                ('computer-revoked', 'computer-revoked', 'agent', '{}', ?)`,
      )
      .run(now, now);
    sqlite.prepare("UPDATE nodes SET revoked_at = ? WHERE id = 'computer-revoked'").run(now);
    // Home holds authority, so the place Home converges is the writer, in that graph's own ids.
    assert.equal(applicationWriterSiteId('app-authority', 'coordinator'), 'coordinator');
    assert.equal(applicationWriterSiteId('app-authority', 'computer'), 'computer');
    assert.equal(applicationWriterSiteId('app-authority', fleet.homeSiteId), fleet.homeSiteId);
    assert.equal(
      applicationWriterSiteId('app-authority', 'computer-revoked'),
      fleet.homeSiteId,
      'a computer Home no longer trusts is not a writer',
    );
    assert.equal(
      applicationWriterSiteId('app-authority', 'site-away'),
      fleet.homeSiteId,
      'a suitcase is never the writer while Home holds authority',
    );

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
    assert.equal(applicationWriterSiteId('app-authority', 'site-away'), 'site-away');
    assert.equal(
      applicationWriterSiteId('app-authority', 'coordinator'),
      'site-away',
      'this machine is not the writer while another site holds the volume',
    );

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
      applicationWriterSiteId('app-authority', 'coordinator'),
      'site-away',
      'the source remains authoritative until the handoff commits',
    );
  });

  it('answers null until Home is known, which blocks writer-only work', () => {
    assert.equal(applicationWriterSiteId('', 'coordinator'), null);
  });
});
