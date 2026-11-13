import { deployDataDirectory, deployDataPath } from '../data-directory.ts';
import { openDatabase, type Database } from '../sqlite.ts';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve, dirname } from 'node:path';
import { resetRequestLogWriter } from '../request-log.ts';
import { resetRequestStorage } from '../requests-lifecycle.ts';
import { deployments } from '../schema.ts';
import { eq } from 'drizzle-orm';
import { notifyRouteChanged } from '../ipc.ts';
import { createHash, randomUUID } from 'node:crypto';
import { configureCiFence } from '../ci-fence.ts';
import { assertReleaseMutation } from '../v2/releases-fence.ts';
import { threadId } from 'node:worker_threads';
import { withMigrationLock } from './migration-lock.ts';

export const DATA_DIR = deployDataDirectory();

const DB_FILE = deployDataPath('deploy.db');

const UPLOADS_DIR = deployDataPath('uploads');

let _sqlite: Database | null = null;

let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (_db) return _db;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

  _sqlite = openDatabase(DB_FILE, { busyTimeoutMs: 5000 });
  const db = drizzle(_sqlite);

  // WAL promotion itself needs a lock on a fresh database. Serialize it with
  // migrations: SQLite can reject simultaneous journal-mode changes immediately,
  // even with busy_timeout, before the migrator would acquire its lock.
  withMigrationLock(DB_FILE, () => {
    _sqlite!.pragma('journal_mode = WAL');
    // Existing databases keep their mode; incremental maintenance avoids a full VACUUM.
    _sqlite!.pragma('auto_vacuum = INCREMENTAL');
    migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  });

  // SQLite ignores declared foreign keys unless each connection asks for them, so until now
  // `REFERENCES` and `ON DELETE CASCADE` in the schema did nothing. Turned on after the
  // migrations on purpose: a migration that rebuilds a table drops the old one, and with
  // enforcement on that drop would cascade into the tables that reference it.
  _sqlite.pragma('foreign_keys = ON');
  const broken = _sqlite.pragma('foreign_key_check') as Array<{ table: string; parent: string }>;
  if (broken.length > 0) {
    const where = [...new Set(broken.map((row) => `${row.table} -> ${row.parent}`))].join(', ');
    console.error(
      `[store] ${broken.length} rows reference a row that no longer exists (${where}). They predate enforcement and are left as they are.`,
    );
  }

  _db = db;
  backfillApplicationRevisionArtifacts();
  return _db;
}

export function getSqlite() {
  getDb(); // Ensure database is initialized
  return _sqlite;
}

export function _resetDb() {
  resetRequestLogWriter();
  resetRequestStorage();
  if (_sqlite) _sqlite.close();
  _sqlite = null;
  _db = null;
  _deploymentsCache = null;
}

export function getUploadsDir() {
  return UPLOADS_DIR;
}

// ── In-memory deployments cache ──────────────────────────────────────────────
// `getDeployment(name)` is called once for every request the reverse proxy
// handles (api.ts mDNS branch). At 100 req/s that's 100 synchronous SQLite
// queries on the main event loop — drizzle adds non-trivial dispatch overhead
// even though sqlite itself is fast. The cache makes each lookup an O(1) Map
// hit; writes invalidate or update individual rows.
type DeploymentRow = typeof deployments.$inferSelect;

export let _deploymentsCache: Map<string, DeploymentRow> | null = null;

export function loadDeploymentsCache(): Map<string, DeploymentRow> {
  if (_deploymentsCache) return _deploymentsCache;
  const db = getDb();
  const rows = db.select().from(deployments).all();
  const map = new Map<string, DeploymentRow>();
  for (const r of rows) map.set(r.name, r);
  _deploymentsCache = map;
  return map;
}

export function refreshDeploymentInCache(name: string) {
  if (_deploymentsCache) {
    const db = getDb();
    const row = db.select().from(deployments).where(eq(deployments.name, name)).get();
    if (row) {
      _deploymentsCache.set(name, row);
    } else {
      _deploymentsCache.delete(name);
    }
  }
  // Hint the edge process (or in-process edge modules) that this deployment's
  // row changed — it re-reads the row and reconciles routes/mDNS/TCP proxies.
  // No-op when no IPC link is registered.
  notifyRouteChanged(name);
}

/** Drop the cache. Useful in tests; production code should prefer refreshDeploymentInCache. */
export function _invalidateDeploymentsCache() {
  _deploymentsCache = null;
}

export function retainApplicationRevisionArtifact(
  source: string,
  type: 'application-spec-source' | 'application-spec-normalized',
  mediaType: string,
): string {
  const bytes = Buffer.from(source, 'utf8');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const hash = digest.slice('sha256:'.length);
  const destination = deployDataPath('blobs', 'sha256', hash.slice(0, 2), hash);
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    try {
      renameSync(temporary, destination);
    } catch (error) {
      if (!existsSync(destination)) throw error;
      unlinkSync(temporary);
    }
    chmodSync(destination, 0o400);
  }
  const now = new Date().toISOString();
  getSqlite()!
    .prepare(
      `INSERT INTO artifacts
        (digest, type, byte_size, media_type, architecture, local_path,
         verification_status, created_by_event_id, retention_class, pin_count,
         created_at, last_access_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'verified', NULL, 'release', 0, ?, ?)
       ON CONFLICT(digest) DO UPDATE SET
         verification_status = 'verified', retention_class = 'release',
         last_access_at = excluded.last_access_at`,
    )
    .run(digest, type, statSync(destination).size, mediaType, destination, now, now);
  return digest;
}

function backfillApplicationRevisionArtifacts(): void {
  const rows = _sqlite!
    .prepare(
      `SELECT deployment_name, digest, normalized_spec
         FROM application_spec_revisions
        WHERE normalized_artifact_digest IS NULL`,
    )
    .all() as Array<{ deployment_name: string; digest: string; normalized_spec: string }>;
  const update = _sqlite!.prepare(
    `UPDATE application_spec_revisions
        SET normalized_artifact_digest = ?
      WHERE deployment_name = ? AND digest = ? AND normalized_artifact_digest IS NULL`,
  );
  for (const row of rows) {
    const artifactDigest = retainApplicationRevisionArtifact(
      row.normalized_spec,
      'application-spec-normalized',
      'application/vnd.deploy.local.application+json',
    );
    if (artifactDigest !== row.digest) {
      throw new Error(
        `Stored application revision ${row.deployment_name}/${row.digest} failed content verification`,
      );
    }
    update.run(artifactDigest, row.deployment_name, row.digest);
  }
}

/** Verify/backfill normalized content artifacts before transfer or Home recovery capture. */
export function ensureApplicationRevisionArtifacts(): void {
  getDb();
  backfillApplicationRevisionArtifacts();
}

configureCiFence(
  (application) => {
    const target = getSqlite()!
      .prepare('SELECT name FROM deployments WHERE name=? OR app_id=?')
      .get(application, application) as { name: string } | undefined;
    assertReleaseMutation(target?.name || application);
    const row = getSqlite()!
      .prepare(
        "SELECT id FROM ci_releases WHERE application IN (SELECT name FROM deployments WHERE name=? OR app_id=?) AND status IN ('accepted','building','starting','interrupted','failed')",
      )
      .get(application, application) as { id: string } | undefined;
    return row?.id;
  },
  (application) => {
    assertReleaseMutation(application);
    const sqlite = getSqlite()!;
    return sqlite
      .transaction(() => {
        const target = sqlite
          .prepare('SELECT name FROM deployments WHERE name=? OR app_id=?')
          .get(application, application) as { name: string } | undefined;
        if (!target) return undefined;
        const active = sqlite
          .prepare(
            "SELECT id FROM ci_releases WHERE application=? AND status IN ('accepted','building','starting','interrupted','failed')",
          )
          .get(target.name);
        if (active)
          throw Object.assign(new Error('Application has a durable CI release reservation'), {
            status: 409,
          });
        const id = randomUUID();
        sqlite
          .prepare('INSERT INTO ci_mutations VALUES(?,?,?,?,?)')
          .run(id, target.name, process.pid, threadId, Date.now());
        return id;
      })
      .immediate();
  },
  (id) => {
    getSqlite()!.prepare('DELETE FROM ci_mutations WHERE id=?').run(id);
  },
  (application) => {
    const sqlite = getSqlite()!;
    const rows = sqlite
      .prepare(
        'SELECT id,pid FROM ci_mutations WHERE application IN (SELECT name FROM deployments WHERE name=? OR app_id=?)',
      )
      .all(application, application) as Array<{ id: string; pid: number }>;
    for (const row of rows) {
      try {
        process.kill(row.pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
        sqlite.prepare('DELETE FROM ci_mutations WHERE id=? AND pid=?').run(row.id, row.pid);
      }
    }
    return false;
  },
  (pid, thread) => {
    const sqlite = getSqlite()!;
    sqlite
      .transaction(() => {
        sqlite.prepare('DELETE FROM ci_mutations WHERE pid=? AND thread_id=?').run(pid, thread);
        sqlite
          .prepare(
            "UPDATE ci_releases SET owner_active=0,status='interrupted',updated_at=? WHERE owner_pid=? AND owner_thread=? AND owner_active=1",
          )
          .run(Date.now(), pid, thread);
      })
      .immediate();
  },
);
