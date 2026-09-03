import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { WireFleetEvent } from './suitcase-transport.ts';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let specs: typeof import('./application-spec.ts');
let overrides: typeof import('./component-site-overrides.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-component-site-overrides-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?component-site-overrides=${Date.now()}`);
  multisite = await import(`./multisite.ts?component-site-overrides=${Date.now()}`);
  specs = await import(`./application-spec.ts?component-site-overrides=${Date.now()}`);
  overrides = await import(`./component-site-overrides.ts?component-site-overrides=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

test('Home publishes an admitted site count and the target repeats admission before projection', () => {
  const fleet = multisite.ensureFleetIdentity();
  const sqlite = store.getSqlite()!;
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO sites
        (id, fleet_id, node_id, name, kind, public_key, credential_status, capabilities,
         mode, default_data_policy, access_mode, security_profile, readiness_summary,
         created_at, updated_at)
       VALUES ('site-count-trip', ?, 'site-count-trip', 'Trip', 'suitcase', 'test-key',
               'active', '{}', 'docked', 'none', 'existing-lan', 'isolated', '{}', ?, ?)`,
    )
    .run(fleet.id, now, now);
  const compiled = specs.compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: scaled-notes
components:
  web:
    image: example/scaled-notes:1
    instances: 2
    minimumReady: 1
    siteOverrides:
      allowed: true
      minimum: 1
      maximum: 4
`);
  sqlite
    .prepare(
      `INSERT INTO deployments
        (name, username, app_id, release_generation, created_at, updated_at)
       VALUES ('scaled-notes', 'admin', 'app-scaled-notes', 3, ?, ?)`,
    )
    .run(now, now);
  store.saveDesiredApplicationSpec({
    digest: compiled.digest,
    deploymentName: 'scaled-notes',
    apiVersion: compiled.spec.apiVersion,
    source: 'repository',
    manifestFormat: 'deploy.yaml',
    normalizedSpec: compiled.canonicalJson,
    createdBy: 'admin',
  });
  sqlite
    .prepare(
      `INSERT INTO app_replicas
        (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
         readiness, created_at, updated_at)
       VALUES ('replica-scaled-trip', 'app-scaled-notes', 'site-count-trip', 'running',
               'site-local', 'none', 0, '{}', ?, ?)`,
    )
    .run(now, now);

  const published = overrides.publishComponentSiteCount({
    appId: 'app-scaled-notes',
    deploymentName: 'scaled-notes',
    targetSiteId: 'site-count-trip',
    componentKey: 'web',
    specDigest: compiled.digest,
    instances: 3,
    actor: 'admin',
  });
  assert.equal(published.effectiveInstances, 3);
  assert.deepEqual(store.getComponentSiteOverrides('app-scaled-notes', 'site-count-trip'), {
    web: 3,
  });

  const eventRow = sqlite
    .prepare('SELECT payload FROM fleet_events WHERE id = ?')
    .get(published.eventId) as { payload: string };
  const payload = JSON.parse(eventRow.payload) as Record<string, unknown>;
  assert.equal(payload.targetSiteId, 'site-count-trip');
  assert.equal(payload.specDigest, compiled.digest);

  sqlite
    .prepare(
      `DELETE FROM component_site_overrides
        WHERE app_id = 'app-scaled-notes' AND site_id = 'site-count-trip'`,
    )
    .run();
  const wire = {
    id: published.eventId,
    fleetId: fleet.id,
    originSiteId: fleet.homeSiteId,
    originSequence: 1,
    appId: 'app-scaled-notes',
    authorityEpoch: 1,
    generation: 3,
    actor: 'admin',
    operation: overrides.COMPONENT_SITE_COUNT_UPDATED,
    schemaVersion: 1,
    payload,
    artifactDigests: [],
    parentEventId: null,
    createdAt: now,
    body: '{}',
    authenticatedDigest: 'test-signature',
  } satisfies WireFleetEvent;
  overrides.projectComponentSiteCount(wire, {
    homeSiteId: fleet.homeSiteId,
    localSiteId: 'site-count-trip',
  });
  assert.deepEqual(store.getComponentSiteOverrides('app-scaled-notes', 'site-count-trip'), {
    web: 3,
  });

  sqlite
    .prepare(
      `DELETE FROM component_site_overrides
        WHERE app_id = 'app-scaled-notes' AND site_id = 'site-count-trip'`,
    )
    .run();
  assert.throws(
    () =>
      overrides.projectComponentSiteCount(
        { ...wire, id: 'event-tampered', payload: { ...payload, effectiveInstances: 4 } },
        { homeSiteId: fleet.homeSiteId, localSiteId: 'site-count-trip' },
      ),
    /facts do not match/,
  );
  assert.deepEqual(store.getComponentSiteOverrides('app-scaled-notes', 'site-count-trip'), {});

  const eventCountBeforeFailure = (
    sqlite.prepare('SELECT COUNT(*) AS count FROM fleet_events').get() as { count: number }
  ).count;
  sqlite.exec(`CREATE TRIGGER reject_component_override
    BEFORE INSERT ON component_site_overrides
    BEGIN
      SELECT RAISE(ABORT, 'projected override failed');
    END`);
  assert.throws(
    () =>
      overrides.publishComponentSiteCount({
        appId: 'app-scaled-notes',
        deploymentName: 'scaled-notes',
        targetSiteId: 'site-count-trip',
        componentKey: 'web',
        specDigest: compiled.digest,
        instances: 4,
        actor: 'admin',
      }),
    /projected override failed/,
  );
  sqlite.exec('DROP TRIGGER reject_component_override');
  assert.equal(
    (sqlite.prepare('SELECT COUNT(*) AS count FROM fleet_events').get() as { count: number }).count,
    eventCountBeforeFailure,
  );
  assert.deepEqual(store.getComponentSiteOverrides('app-scaled-notes', 'site-count-trip'), {});

  sqlite
    .prepare(
      `UPDATE deployments
          SET release_generation = 4,
              desired_spec_digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        WHERE app_id = 'app-scaled-notes'`,
    )
    .run();
  assert.throws(
    () =>
      overrides.projectComponentSiteCount(
        { ...wire, id: 'event-stale' },
        { homeSiteId: fleet.homeSiteId, localSiteId: 'site-count-trip' },
      ),
    /stale application revision/,
  );
  assert.deepEqual(store.getComponentSiteOverrides('app-scaled-notes', 'site-count-trip'), {});
});
