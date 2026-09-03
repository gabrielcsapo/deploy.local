import { appendLocalFleetEvent, ensureFleetIdentity } from './multisite.ts';
import { getSqlite } from './store.ts';

export interface ProjectedAdministrator {
  username: string;
  role: 'admin';
  passwordVerifier: string;
  revision: number;
  enabled: boolean;
  updatedAt: string;
}

export interface AdministratorProjection {
  targetSiteId: string;
  users: ProjectedAdministrator[];
}

/**
 * Copies only administrator password verifiers. Session tokens and ordinary users never travel.
 * The signed event is still transported over the authenticated TLS sync channel; the verifier is
 * treated as credential material by logs and support-bundle redaction.
 */
export function projectAdministratorsToSite(
  siteId: string,
  actor: string,
): AdministratorProjection {
  const sqlite = getSqlite()!;
  const fleet = ensureFleetIdentity();
  const site = sqlite
    .prepare(
      `SELECT id FROM sites
        WHERE id = ? AND fleet_id = ? AND kind = 'suitcase'
          AND credential_status = 'active' AND revoked_at IS NULL`,
    )
    .get(siteId, fleet.id);
  if (!site) throw new Error('Active suitcase site not found');
  const admins = sqlite
    .prepare("SELECT username, password FROM users WHERE role = 'admin' ORDER BY username")
    .all() as Array<{ username: string; password: string }>;
  if (admins.length === 0)
    throw new Error('At least one administrator is required for offline access');
  const now = new Date().toISOString();
  const write = sqlite.transaction(() => {
    for (const admin of admins) {
      sqlite
        .prepare(
          `INSERT INTO site_users
            (site_id, username, role, password_verifier, revision, enabled, updated_at)
           VALUES (?, ?, 'admin', ?, 1, 1, ?)
           ON CONFLICT(site_id, username) DO UPDATE SET
             role = 'admin',
             password_verifier = excluded.password_verifier,
             revision = CASE
               WHEN site_users.password_verifier <> excluded.password_verifier
                 OR site_users.enabled = 0 THEN site_users.revision + 1
               ELSE site_users.revision
             END,
             enabled = 1,
             updated_at = CASE
               WHEN site_users.password_verifier <> excluded.password_verifier
                 OR site_users.enabled = 0 THEN excluded.updated_at
               ELSE site_users.updated_at
             END`,
        )
        .run(siteId, admin.username, admin.password, now);
    }
    const names = admins.map((admin) => admin.username);
    const placeholders = names.map(() => '?').join(', ');
    sqlite
      .prepare(
        `UPDATE site_users SET enabled = 0, revision = revision + 1, updated_at = ?
          WHERE site_id = ? AND enabled = 1
            AND username NOT IN (${placeholders})`,
      )
      .run(now, siteId, ...names);
  });
  write.immediate();

  const projection: AdministratorProjection = {
    targetSiteId: siteId,
    users: (
      sqlite
        .prepare(
          `SELECT username, role, password_verifier, revision, enabled, updated_at
             FROM site_users WHERE site_id = ? ORDER BY username`,
        )
        .all(siteId) as Array<Record<string, unknown>>
    ).map((row) => ({
      username: String(row.username),
      role: 'admin',
      passwordVerifier: String(row.password_verifier),
      revision: Number(row.revision),
      enabled: Boolean(row.enabled),
      updatedAt: String(row.updated_at),
    })),
  };
  appendLocalFleetEvent({
    originSiteId: fleet.homeSiteId,
    actor,
    operation: 'fleet.administrators.projected',
    payload: projection as unknown as Record<string, unknown>,
  });
  return projection;
}

/** Apply one Home-authored projection on the suitcase and create only site-local sessions later. */
export function applyAdministratorProjection(
  projection: AdministratorProjection,
  localSiteId: string,
): { applied: number; ignored: number } {
  if (projection.targetSiteId !== localSiteId)
    return { applied: 0, ignored: projection.users.length };
  const sqlite = getSqlite()!;
  let applied = 0;
  let ignored = 0;
  const write = sqlite.transaction(() => {
    for (const projected of projection.users) {
      if (
        !projected.username ||
        projected.role !== 'admin' ||
        !projected.passwordVerifier ||
        !Number.isSafeInteger(projected.revision) ||
        projected.revision < 1
      ) {
        throw new Error('Administrator projection is invalid');
      }
      const current = sqlite
        .prepare('SELECT revision FROM site_users WHERE site_id = ? AND username = ?')
        .get(localSiteId, projected.username) as { revision: number } | undefined;
      if (current && current.revision >= projected.revision) {
        const local = sqlite
          .prepare('SELECT password, role FROM users WHERE username = ?')
          .get(projected.username) as { password: string; role: string } | undefined;
        if (
          projected.enabled &&
          (!local || local.password !== projected.passwordVerifier || local.role !== 'admin')
        ) {
          sqlite
            .prepare(
              `INSERT INTO users (username, password, role, created_at)
               VALUES (?, ?, 'admin', ?)
               ON CONFLICT(username) DO UPDATE SET password = excluded.password, role = 'admin'`,
            )
            .run(projected.username, projected.passwordVerifier, projected.updatedAt);
          applied++;
        } else if (!projected.enabled && local?.role === 'admin') {
          sqlite.prepare('DELETE FROM sessions WHERE username = ?').run(projected.username);
          sqlite
            .prepare("DELETE FROM users WHERE username = ? AND role = 'admin'")
            .run(projected.username);
          applied++;
        } else {
          ignored++;
        }
        continue;
      }
      sqlite
        .prepare(
          `INSERT INTO site_users
            (site_id, username, role, password_verifier, revision, enabled, updated_at)
           VALUES (?, ?, 'admin', ?, ?, ?, ?)
           ON CONFLICT(site_id, username) DO UPDATE SET
             role = 'admin', password_verifier = excluded.password_verifier,
             revision = excluded.revision, enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        )
        .run(
          localSiteId,
          projected.username,
          projected.passwordVerifier,
          projected.revision,
          projected.enabled ? 1 : 0,
          projected.updatedAt,
        );
      if (projected.enabled) {
        sqlite
          .prepare(
            `INSERT INTO users (username, password, role, created_at)
             VALUES (?, ?, 'admin', ?)
             ON CONFLICT(username) DO UPDATE SET password = excluded.password, role = 'admin'`,
          )
          .run(projected.username, projected.passwordVerifier, projected.updatedAt);
      } else {
        sqlite.prepare('DELETE FROM sessions WHERE username = ?').run(projected.username);
        sqlite
          .prepare("DELETE FROM users WHERE username = ? AND role = 'admin'")
          .run(projected.username);
      }
      applied++;
    }
  });
  write.immediate();
  return { applied, ignored };
}

export function projectAdministratorsToEverySuitcase(actor: string): number {
  const sites = getSqlite()!
    .prepare(
      `SELECT id FROM sites
        WHERE kind = 'suitcase' AND credential_status = 'active' AND revoked_at IS NULL`,
    )
    .all() as Array<{ id: string }>;
  for (const site of sites) projectAdministratorsToSite(site.id, actor);
  return sites.length;
}
