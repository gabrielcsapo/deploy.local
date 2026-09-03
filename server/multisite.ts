import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { getSqlite } from './store.ts';
import { loadOrCreateSiteIdentity, signSitePayload, verifySitePayload } from './site-identity.ts';

export const MULTISITE_PROTOCOL_VERSION = 1;
export type SiteKind = 'home' | 'suitcase';
export type SiteMode = 'docked' | 'away' | 'rejoining' | 'recovery' | 'revoked';
export type DataSyncPolicy = 'automatic' | 'manual' | 'none';

const SITE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,62}$/;

export function sortableId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).padStart(10, '0')}_${randomBytes(12).toString('hex')}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalFleetPayload(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFleetPayload).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalFleetPayload(child)}`)
    .join(',')}}`;
}

export function buildFleetEventBody(event: {
  id: string;
  fleetId: string;
  originSiteId: string;
  originSequence: number;
  appId?: string | null;
  authorityEpoch?: number | null;
  generation?: number | null;
  actor: string;
  operation: string;
  schemaVersion?: number;
  payload: Record<string, unknown>;
  artifactDigests?: string[];
  parentEventId?: string | null;
}): string {
  return canonicalFleetPayload({
    id: event.id,
    fleetId: event.fleetId,
    originSiteId: event.originSiteId,
    originSequence: event.originSequence,
    appId: event.appId || null,
    authorityEpoch: event.authorityEpoch || null,
    generation: event.generation || null,
    actor: event.actor,
    operation: event.operation,
    schemaVersion: event.schemaVersion ?? 1,
    payload: event.payload,
    artifactDigests: event.artifactDigests || [],
    parentEventId: event.parentEventId || null,
  });
}

export interface FleetIdentity {
  id: string;
  name: string;
  homeSiteId: string;
  protocolVersion: number;
  rootPublicIdentity: string;
  createdAt: string;
}

export function ensureFleetIdentity(name = 'Home Fleet'): FleetIdentity {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('Database is unavailable');
  const existing = sqlite.prepare('SELECT * FROM fleets ORDER BY created_at LIMIT 1').get() as
    | Record<string, unknown>
    | undefined;
  if (existing) {
    backfillApplicationIdentities(String(existing.id), String(existing.home_site_id));
    return mapFleet(existing);
  }

  const fleetId = sortableId('fleet');
  const homeSiteId = sortableId('site');
  const identity = loadOrCreateSiteIdentity(homeSiteId);
  const now = new Date().toISOString();
  const create = sqlite.transaction(() => {
    const raced = sqlite.prepare('SELECT * FROM fleets ORDER BY created_at LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    if (raced) return mapFleet(raced);
    sqlite
      .prepare(
        `INSERT INTO fleets
          (id, name, protocol_version, root_public_identity, home_site_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(fleetId, name, MULTISITE_PROTOCOL_VERSION, identity.publicKey, homeSiteId, now);
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
    return {
      id: fleetId,
      name,
      homeSiteId,
      protocolVersion: MULTISITE_PROTOCOL_VERSION,
      rootPublicIdentity: identity.publicKey,
      createdAt: now,
    };
  });
  const fleet = create.immediate();
  backfillApplicationIdentities(fleet.id, fleet.homeSiteId);
  return fleet;
}

/** The coordinator signs as Home; a detached core signs as its paired suitcase identity. */
export function resolveLocalSiteId(): string {
  const fleet = ensureFleetIdentity();
  if (process.env.DEPLOY_SUITCASE !== '1') return fleet.homeSiteId;
  const site = getSqlite()!
    .prepare(
      `SELECT id FROM sites
        WHERE fleet_id = ? AND kind = 'suitcase' AND credential_status = 'active'
          AND revoked_at IS NULL ORDER BY created_at LIMIT 1`,
    )
    .get(fleet.id) as { id: string } | undefined;
  if (!site) throw new Error('Suitcase fleet projection is not initialized');
  return site.id;
}

function mapFleet(row: Record<string, unknown>): FleetIdentity {
  return {
    id: String(row.id),
    name: String(row.name),
    homeSiteId: String(row.home_site_id),
    protocolVersion: Number(row.protocol_version),
    rootPublicIdentity: String(row.root_public_identity),
    createdAt: String(row.created_at),
  };
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
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO app_replicas
            (id, app_id, site_id, active_release_digest, desired_release_digest,
             runtime_status, data_mode, sync_policy, shared_lineage, readiness,
             created_at, updated_at)
           SELECT ?, app_id, ?, active_spec_digest, desired_spec_digest,
                  COALESCE(status, 'stopped'), COALESCE(data_mode, 'single-site'),
                  'automatic', 1, '{}', ?, ?
             FROM deployments WHERE name = ?`,
        )
        .run(sortableId('replica'), homeSiteId, now, now, row.name);
    }
  });
  update.immediate();
}

export function registerApplicationIdentity(name: string): string {
  const fleet = ensureFleetIdentity();
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

export function createSuitcasePairing(input: {
  name: string;
  defaultDataPolicy?: DataSyncPolicy;
  accessMode?: 'existing-lan' | 'host-hotspot' | 'linux-access-point';
  securityProfile?: 'isolated' | 'trusted-lan';
  createdBy: string;
}) {
  if (!SITE_NAME_PATTERN.test(input.name.trim())) throw new Error('Invalid suitcase name');
  const fleet = ensureFleetIdentity();
  const policy = input.defaultDataPolicy || 'none';
  if (!['automatic', 'manual', 'none'].includes(policy))
    throw new Error('Invalid data sync policy');
  const code = `CASE-${randomBytes(18).toString('base64url').toUpperCase()}`;
  const id = sortableId('pair');
  const now = new Date();
  const expiresAt = now.getTime() + 10 * 60_000;
  getSqlite()!
    .prepare(
      `INSERT INTO site_pairing_codes
        (id, fleet_id, name, code_hash, default_data_policy, access_mode,
         security_profile, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      fleet.id,
      input.name.trim(),
      sha256(code),
      policy,
      input.accessMode || 'existing-lan',
      input.securityProfile || 'isolated',
      input.createdBy,
      now.toISOString(),
      expiresAt,
    );
  return { id, code, expiresAt, defaultDataPolicy: policy };
}

export function redeemSuitcasePairing(input: {
  code: string;
  publicKey: string;
  platform: string;
  architecture: string;
  version: string;
  capabilities?: Record<string, unknown>;
  nodeId?: string;
}) {
  const sqlite = getSqlite()!;
  const pairing = sqlite
    .prepare('SELECT * FROM site_pairing_codes WHERE code_hash = ?')
    .get(sha256(input.code.trim().toUpperCase())) as Record<string, unknown> | undefined;
  if (!pairing || pairing.used_at || Number(pairing.expires_at) < Date.now()) {
    throw new Error('Pairing code is invalid or expired');
  }
  const siteId = sortableId('site');
  const credential = `site_secret_${randomBytes(32).toString('base64url')}`;
  const now = new Date().toISOString();
  const redeem = sqlite.transaction(() => {
    const current = sqlite
      .prepare('SELECT used_at FROM site_pairing_codes WHERE id = ?')
      .get(pairing.id) as { used_at: string | null } | undefined;
    if (!current || current.used_at) throw new Error('Pairing code has already been used');
    sqlite
      .prepare(
        `INSERT INTO sites
          (id, fleet_id, node_id, name, kind, public_key, credential_hash,
           credential_status, platform, architecture, version, capabilities, mode,
           default_data_policy, access_mode, security_profile, readiness_summary,
           last_contact_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'suitcase', ?, ?, 'active', ?, ?, ?, ?, 'docked',
                 ?, ?, ?, '{}', ?, ?, ?)`,
      )
      .run(
        siteId,
        pairing.fleet_id,
        input.nodeId || null,
        pairing.name,
        input.publicKey,
        sha256(credential),
        input.platform,
        input.architecture,
        input.version,
        JSON.stringify(input.capabilities || {}),
        pairing.default_data_policy,
        pairing.access_mode,
        pairing.security_profile,
        Date.now(),
        now,
        now,
      );
    sqlite.prepare('UPDATE site_pairing_codes SET used_at = ? WHERE id = ?').run(now, pairing.id);
  });
  redeem.immediate();
  return {
    siteId,
    fleetId: String(pairing.fleet_id),
    credential,
    name: String(pairing.name),
    defaultDataPolicy: String(pairing.default_data_policy) as DataSyncPolicy,
    accessMode: String(pairing.access_mode),
    securityProfile: String(pairing.security_profile),
    protocolVersion: MULTISITE_PROTOCOL_VERSION,
  };
}

export function authenticateSite(siteId: string, credential: string): boolean {
  const row = getSqlite()!
    .prepare(
      `SELECT credential_hash, credential_status, revoked_at
         FROM sites WHERE id = ? AND kind = 'suitcase'`,
    )
    .get(siteId) as
    | { credential_hash: string | null; credential_status: string; revoked_at: string | null }
    | undefined;
  return Boolean(
    row &&
    row.credential_status === 'active' &&
    !row.revoked_at &&
    row.credential_hash === sha256(credential),
  );
}

export function updateSitePresence(input: {
  siteId: string;
  mode: SiteMode;
  capabilities?: Record<string, unknown>;
  readiness?: Record<string, unknown>;
  networkFingerprint?: string;
}): void {
  if (!['docked', 'away', 'rejoining', 'recovery', 'revoked'].includes(input.mode)) {
    throw new Error('Invalid site mode');
  }
  const now = new Date().toISOString();
  const result = getSqlite()!
    .prepare(
      `UPDATE sites
          SET mode = ?, capabilities = COALESCE(?, capabilities),
              readiness_summary = COALESCE(?, readiness_summary),
              network_fingerprint = COALESCE(?, network_fingerprint),
              last_contact_at = ?, updated_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(
      input.mode,
      input.capabilities ? JSON.stringify(input.capabilities) : null,
      input.readiness ? JSON.stringify(input.readiness) : null,
      input.networkFingerprint || null,
      Date.now(),
      now,
      input.siteId,
    );
  if (result.changes === 0) throw new Error('Site not found or revoked');
}

export function revokeSite(siteId: string, reason = 'Revoked by administrator'): void {
  const now = new Date().toISOString();
  const result = getSqlite()!
    .prepare(
      `UPDATE sites SET mode = 'revoked', credential_status = 'revoked',
                        revoked_at = ?, quarantine_reason = ?, updated_at = ?
        WHERE id = ? AND kind = 'suitcase' AND revoked_at IS NULL`,
    )
    .run(now, reason, now, siteId);
  if (result.changes === 0) throw new Error('Active suitcase site not found');
}

export interface TopologySite {
  id: string;
  fleet_id: string;
  node_id: string | null;
  name: string;
  kind: SiteKind;
  mode: SiteMode;
  capabilities: Record<string, unknown>;
  readiness_summary: Record<string, unknown>;
  revoked_at: string | null;
  [key: string]: unknown;
}

export interface TopologyApplication {
  app_id: string;
  name: string;
  status: string | null;
  active_spec_digest: string | null;
  desired_spec_digest: string | null;
  release_authority_epoch: number;
  release_generation: number;
  replica_count: number;
  ready_replicas: number;
}

export function listTopology(): {
  fleet: FleetIdentity;
  sites: TopologySite[];
  applications: TopologyApplication[];
} {
  const fleet = ensureFleetIdentity();
  const sqlite = getSqlite()!;
  const sites = sqlite
    .prepare('SELECT * FROM sites WHERE fleet_id = ? ORDER BY kind, name')
    .all(fleet.id) as Array<Record<string, unknown>>;
  const applications = sqlite
    .prepare(
      `SELECT d.app_id, d.name, d.status, d.active_spec_digest, d.desired_spec_digest,
              d.release_authority_epoch, d.release_generation,
              COUNT(r.id) AS replica_count,
              SUM(CASE WHEN r.runtime_status = 'running' THEN 1 ELSE 0 END) AS ready_replicas
         FROM deployments d
         LEFT JOIN app_replicas r ON r.app_id = d.app_id AND r.removed_at IS NULL
        GROUP BY d.app_id, d.name
        ORDER BY d.name`,
    )
    .all() as TopologyApplication[];
  return {
    fleet,
    sites: sites.map((site) => {
      const { credential_hash: _, ...safe } = site;
      return {
        ...safe,
        id: String(site.id),
        fleet_id: String(site.fleet_id),
        node_id: site.node_id ? String(site.node_id) : null,
        name: String(site.name),
        kind: String(site.kind) as SiteKind,
        mode: String(site.mode) as SiteMode,
        capabilities: JSON.parse(String(site.capabilities || '{}')) as Record<string, unknown>,
        readiness_summary: JSON.parse(String(site.readiness_summary || '{}')) as Record<
          string,
          unknown
        >,
        revoked_at: site.revoked_at ? String(site.revoked_at) : null,
      };
    }),
    applications,
  };
}

export interface FleetEventInput {
  originSiteId: string;
  appId?: string;
  actor: string;
  operation: string;
  authorityEpoch?: number;
  generation?: number;
  payload: Record<string, unknown>;
  artifactDigests?: string[];
  parentEventId?: string;
}

export function appendLocalFleetEvent(input: FleetEventInput, project?: () => void) {
  const fleet = ensureFleetIdentity();
  const sqlite = getSqlite()!;
  let originSiteId = input.originSiteId;
  const membershipFile = process.env.DEPLOY_SUITCASE_MEMBERSHIP_FILE;
  if (process.env.DEPLOY_SUITCASE === '1' && membershipFile && existsSync(membershipFile)) {
    const membership = JSON.parse(readFileSync(membershipFile, 'utf8')) as {
      fleetId?: string;
      siteId?: string;
    };
    if (membership.fleetId !== fleet.id || !membership.siteId) {
      throw new Error('Suitcase membership does not match the local fleet database');
    }
    originSiteId = membership.siteId;
  }
  const eventId = sortableId('event');
  const createdAt = new Date().toISOString();
  const append = sqlite.transaction(() => {
    const originSequence = Number(
      (
        sqlite
          .prepare(
            'SELECT COALESCE(MAX(origin_sequence), 0) + 1 AS next FROM fleet_events WHERE origin_site_id = ?',
          )
          .get(originSiteId) as { next: number }
      ).next,
    );
    const body = buildFleetEventBody({
      id: eventId,
      fleetId: fleet.id,
      originSiteId,
      originSequence,
      appId: input.appId || null,
      authorityEpoch: input.authorityEpoch || null,
      generation: input.generation || null,
      actor: input.actor,
      operation: input.operation,
      payload: input.payload,
      artifactDigests: input.artifactDigests || [],
      parentEventId: input.parentEventId || null,
    });
    const identity = loadOrCreateSiteIdentity(originSiteId);
    const authenticatedDigest = signSitePayload(identity, body);
    sqlite
      .prepare(
        `INSERT INTO fleet_events
          (id, fleet_id, origin_site_id, origin_sequence, app_id, authority_epoch,
           generation, actor, operation, schema_version, payload, artifact_digests,
           parent_event_id, authenticated_digest, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        fleet.id,
        originSiteId,
        originSequence,
        input.appId || null,
        input.authorityEpoch || null,
        input.generation || null,
        input.actor,
        input.operation,
        canonicalFleetPayload(input.payload),
        canonicalFleetPayload(input.artifactDigests || []),
        input.parentEventId || null,
        authenticatedDigest,
        createdAt,
        createdAt,
      );
    project?.();
    return { eventId, originSequence, authenticatedDigest, body, createdAt };
  });
  return append.immediate();
}

export function verifyRemoteFleetEvent(event: Record<string, unknown>): boolean {
  const site = getSqlite()!
    .prepare('SELECT public_key, fleet_id, revoked_at FROM sites WHERE id = ?')
    .get(event.originSiteId) as
    | { public_key: string; fleet_id: string; revoked_at: string | null }
    | undefined;
  if (!site || site.revoked_at || site.fleet_id !== event.fleetId) return false;
  return verifySitePayload(
    String(site.public_key),
    String(event.body),
    String(event.authenticatedDigest),
  );
}
