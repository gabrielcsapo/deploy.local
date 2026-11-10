import { randomBytes } from 'node:crypto';
import { arch, platform } from 'node:os';
import { getSqlite } from './store.ts';
import { loadOrCreateSiteIdentity } from './site-identity.ts';

// Required by the historical identity rows retained for application and recovery records.
const LEGACY_IDENTITY_VERSION = 1;

export function sortableId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).padStart(10, '0')}_${randomBytes(12).toString('hex')}`;
}

interface LocalIdentity {
  id: string;
  homeSiteId: string;
}

export function ensureLocalIdentity(name = 'Home Fleet'): LocalIdentity {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('Database is unavailable');
  const existing = sqlite.prepare('SELECT * FROM fleets ORDER BY created_at LIMIT 1').get() as
    | Record<string, unknown>
    | undefined;
  if (existing) {
    backfillApplicationIdentities(String(existing.id), String(existing.home_site_id));
    return mapIdentity(existing);
  }

  const fleetId = sortableId('fleet');
  const homeSiteId = sortableId('site');
  const identity = loadOrCreateSiteIdentity(homeSiteId);
  const now = new Date().toISOString();
  const create = sqlite.transaction(() => {
    const raced = sqlite.prepare('SELECT * FROM fleets ORDER BY created_at LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    if (raced) return mapIdentity(raced);
    sqlite
      .prepare(
        `INSERT INTO fleets
          (id, name, protocol_version, root_public_identity, home_site_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(fleetId, name, LEGACY_IDENTITY_VERSION, identity.publicKey, homeSiteId, now);
    sqlite
      .prepare(
        `INSERT INTO sites
          (id, fleet_id, node_id, name, kind, public_key, credential_status,
           platform, architecture, version, capabilities, mode, default_data_policy,
           access_mode, security_profile, readiness_summary, last_contact_at, created_at, updated_at)
         VALUES (?, ?, 'coordinator', 'Home', 'home', ?, 'active', ?, ?, ?, '{}',
                 'docked', 'automatic', 'existing-lan', 'isolated', '{}', ?, ?, ?)`,
      )
      .run(
        homeSiteId,
        fleetId,
        identity.publicKey,
        platform(),
        arch(),
        process.env.npm_package_version || 'source',
        Date.now(),
        now,
        now,
      );
    return { id: fleetId, homeSiteId };
  });
  const fleet = create.immediate();
  backfillApplicationIdentities(fleet.id, fleet.homeSiteId);
  return fleet;
}

function mapIdentity(row: Record<string, unknown>): LocalIdentity {
  return { id: String(row.id), homeSiteId: String(row.home_site_id) };
}

function backfillApplicationIdentities(fleetId: string, homeSiteId: string): void {
  const sqlite = getSqlite()!;
  const rows = sqlite.prepare('SELECT name, app_id FROM deployments ORDER BY name').all() as Array<{
    name: string;
    app_id: string | null;
  }>;
  const now = new Date().toISOString();
  const update = sqlite.transaction(() => {
    for (const row of rows) {
      const appId = row.app_id || sortableId('app');
      if (!row.app_id) {
        sqlite
          .prepare('UPDATE deployments SET app_id = ? WHERE name = ? AND app_id IS NULL')
          .run(appId, row.name);
      }
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO application_aliases
            (fleet_id, alias, app_id, origin_site_id, state, created_at)
           VALUES (?, ?, ?, ?, 'active', ?)`,
        )
        .run(fleetId, row.name, appId, homeSiteId, now);
    }
  });
  update.immediate();
}

export function registerApplicationIdentity(name: string): string {
  const fleet = ensureLocalIdentity();
  const sqlite = getSqlite()!;
  const deployment = sqlite.prepare('SELECT app_id FROM deployments WHERE name = ?').get(name) as
    | { app_id: string | null }
    | undefined;
  if (!deployment) throw new Error('Deployment not found');
  if (deployment.app_id) return deployment.app_id;
  backfillApplicationIdentities(fleet.id, fleet.homeSiteId);
  return String(
    (
      sqlite.prepare('SELECT app_id FROM deployments WHERE name = ?').get(name) as {
        app_id: string;
      }
    ).app_id,
  );
}
