import { rm } from 'node:fs/promises';
import { setImmediate as yieldThread } from 'node:timers/promises';
import { db, fail, objectPath } from './store.ts';
import { writeCopy } from './cache.ts';
import { db as workspaceDb } from '../workspace/store.ts';

// Cargo.lock's usage index currently covers private crates only. Until public Cargo
// main/release snapshots are indexed, every Cargo copy is conservatively protected.
export const neededCopy = `(e.ecosystem='cargo' OR EXISTS (
  SELECT 1 FROM package_pins p WHERE p.ecosystem=e.ecosystem AND p.key=e.key
) OR (e.ecosystem='npm' AND EXISTS (
  SELECT 1 FROM package_project_requirements r WHERE r.key=e.key
)))`;
const packageName = "substr(e.key,1,instr(substr(e.key,2),'@'))";
const files = `WITH files AS (SELECT e.*, ${packageName} AS name,
  substr(e.key,instr(substr(e.key,2),'@')+2) AS version,
  ${neededCopy} AS needed FROM package_cache_entries e WHERE e.kind='file' AND e.size>0)`;
export type KeptQuery = {
  q: string;
  kind: 'all' | 'npm' | 'cargo';
  idle: boolean;
  sort: 'size' | 'name' | 'installed';
  page: number;
};
export function keptQuery(params = new URLSearchParams()): KeptQuery {
  const kind = params.get('kind') || 'all';
  const sort = params.get('sort') || 'size';
  if (!['all', 'npm', 'cargo'].includes(kind)) fail('Unknown package ecosystem');
  if (!['size', 'name', 'installed'].includes(sort)) fail('Unknown copy sort');
  const page = Number(params.get('page') || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) fail('Invalid page');
  return {
    q: (params.get('q') || '').trim().slice(0, 214),
    kind: kind as KeptQuery['kind'],
    idle: params.get('time') === 'idle',
    sort: sort as KeptQuery['sort'],
    page,
  };
}
function filter(query: KeptQuery, clock: number, name?: string) {
  return {
    sql: `(?='all' OR ecosystem=?) AND instr(lower(name),lower(?))>0
      AND (?=0 OR (needed=0 AND last_used_at<?)) AND (? IS NULL OR name=?)`,
    args: [
      query.kind,
      query.kind,
      query.q,
      Number(query.idle),
      new Date(clock - 30 * 86400000).toISOString(),
      name ?? null,
      name ?? null,
    ],
  };
}
const aggregate =
  "COUNT(*) AS versions, COUNT(DISTINCT ecosystem||':'||name) AS packages, COALESCE(SUM(size),0) AS bytes";
export type KeptTotals = { versions: number; packages: number; bytes: number };
export function keptTotals(clock = Date.now()) {
  const total = db().prepare(`${files} SELECT ${aggregate} FROM files`).get() as KeptTotals;
  const needed = db()
    .prepare(`${files} SELECT ${aggregate} FROM files WHERE needed=1`)
    .get() as KeptTotals;
  const idle = db()
    .prepare(`${files} SELECT ${aggregate} FROM files WHERE needed=0 AND last_used_at<?`)
    .get(new Date(clock - 30 * 86400000).toISOString()) as KeptTotals;
  const ecosystems = Object.fromEntries(
    db()
      .prepare(`${files} SELECT ecosystem,${aggregate} FROM files GROUP BY ecosystem`)
      .all()
      .map((row: any) => [row.ecosystem, row]),
  );
  return { ...total, needed, idle, ecosystems, cargoProtected: true };
}
// Both halves start from the kept versions of one package (package_cache_kept_name) and
// look their projects up by key. Starting from the requirements instead reads every
// lockfile entry of every project once per listed row.
function projectsFor(owner: string, ecosystem: string, name: string, version?: string) {
  const kept = `e.kind='file' AND e.size>0 AND ${packageName}=? AND (? IS NULL OR e.key=?||'@'||?)`;
  const rows = db()
    .prepare(
      `SELECT project_id,COUNT(*) OVER () AS total FROM (
    SELECT p.project_id FROM package_cache_entries e CROSS JOIN package_pins p
      ON p.ecosystem=e.ecosystem AND p.key=e.key
      WHERE e.ecosystem=? AND ${kept}
    UNION SELECT r.project_id FROM package_cache_entries e CROSS JOIN package_project_requirements r
      ON r.key=e.key
      WHERE e.ecosystem='npm' AND ?='npm' AND ${kept}
  ) ORDER BY project_id LIMIT 100`,
    )
    .all(
      ecosystem,
      name,
      version ?? null,
      name,
      version ?? null,
      ecosystem,
      name,
      version ?? null,
      name,
      version ?? null,
    ) as { project_id: string; total: number }[];
  const project = workspaceDb.prepare(
    "SELECT json_extract(data,'$.name') name FROM records WHERE kind='project' AND owner=? AND id=?",
  );
  return {
    neededByCount: rows[0]?.total || 0,
    neededBy: rows.map((row) => ({
      id: row.project_id,
      name:
        (project.get(owner, row.project_id) as { name: string } | undefined)?.name || 'a project',
    })),
  };
}
export function listKept(owner: string, query: KeptQuery, clock = Date.now()) {
  const where = filter(query, clock);
  const totals = db()
    .prepare(`${files} SELECT ${aggregate} FROM files WHERE ${where.sql}`)
    .get(...where.args) as KeptTotals;
  const kinds = db()
    .prepare(
      `${files} SELECT ecosystem,COUNT(DISTINCT name) AS packages FROM files WHERE ${where.sql} GROUP BY ecosystem`,
    )
    .all(...filter({ ...query, kind: 'all' }, clock).args) as {
    ecosystem: string;
    packages: number;
  }[];
  const order = {
    size: 'bytes DESC',
    name: 'name COLLATE NOCASE',
    installed: 'lastInstalled DESC',
  }[query.sort];
  const page = Math.min(query.page, Math.max(1, Math.ceil(totals.packages / 50)));
  const entries = db()
    .prepare(
      `${files} SELECT ecosystem,name,COUNT(*) AS versions,SUM(size) AS bytes,
    MAX(last_used_at) AS lastInstalled,MAX(needed) AS needed,
    (SELECT COUNT(*) FROM package_cache_entries original WHERE original.ecosystem=files.ecosystem AND original.kind='file' AND original.size>0 AND substr(original.key,1,instr(substr(original.key,2),'@'))=files.name) AS allVersions FROM files WHERE ${where.sql}
    GROUP BY ecosystem,name ORDER BY ${order},ecosystem,name LIMIT 50 OFFSET ?`,
    )
    .all(...where.args, (page - 1) * 50)
    .map((row: any) => ({
      ...row,
      ...projectsFor(owner, row.ecosystem, row.name),
    }));
  return {
    ...totals,
    entries,
    page,
    pageSize: 50,
    kinds: Object.fromEntries(kinds.map((row) => [row.ecosystem, row.packages])),
  };
}
const versionDatabases = new WeakSet<object>();
/** A binary sort key keeps numeric prerelease identifiers numeric in paged SQL results. */
export function versionOrder(version: string) {
  const withoutBuild = version.split('+')[0];
  const separator = withoutBuild.indexOf('-');
  const core = separator < 0 ? withoutBuild : withoutBuild.slice(0, separator);
  const numeric = (value: string) => `${String(value.length).padStart(3, '0')}:${value}`;
  const base = core.split('.').map(numeric).join('!');
  return (
    base +
    (separator < 0
      ? '~'
      : '!' +
        withoutBuild
          .slice(separator + 1)
          .split('.')
          .map((value) => (/^\d+$/.test(value) ? '0' + numeric(value) : '1' + value))
          .join('!'))
  );
}
export function readKept(owner: string, ecosystem: string, name: string, offset = 0, limit = 5) {
  if (!['npm', 'cargo'].includes(ecosystem)) fail('Unknown package ecosystem');
  const totals = db()
    .prepare(
      `${files} SELECT ${aggregate},COALESCE(SUM(needed),0) AS neededVersions,
    COALESCE(SUM(CASE WHEN needed=0 THEN size ELSE 0 END),0) AS unusedBytes FROM files WHERE ecosystem=? AND name=?`,
    )
    .get(ecosystem, name) as KeptTotals & {
    neededVersions: number;
    unusedBytes: number;
  };
  // Empty detail remains useful after removing the final version.
  if (!versionDatabases.has(db())) {
    db().function('kept_version_order', { deterministic: true }, (value) =>
      versionOrder(String(value)),
    );
    versionDatabases.add(db());
  }
  const versions = db()
    .prepare(
      `${files} SELECT version,size AS bytes,last_used_at AS lastInstalled,needed FROM files
    WHERE ecosystem=? AND name=? ORDER BY kept_version_order(version) DESC,version DESC LIMIT ? OFFSET ?`,
    )
    .all(ecosystem, name, limit, offset)
    .map((row: any) => ({
      ...row,
      ...projectsFor(owner, ecosystem, name, row.version),
    }));
  return {
    name,
    ecosystem,
    ...totals,
    totalVersions: totals.versions,
    unusedVersions: totals.versions - totals.neededVersions,
    ...projectsFor(owner, ecosystem, name),
    versions,
    offset,
    cargoProtected: ecosystem === 'cargo',
  };
}

/** Serializes file deletion with cache opens/promotions; rechecks pins and last use
 * inside the immediate transaction. Batches bound memory and yield to installs. */
export async function removeKept(query: KeptQuery, name?: string, clock = Date.now()) {
  const where = filter(query, clock, name);
  let versions = 0,
    bytes = 0;
  let after = '';
  for (;;) {
    const candidates = db()
      .prepare(
        `${files} SELECT ecosystem,key FROM files WHERE ${where.sql}
      AND needed=0 AND ecosystem||':'||key>? ORDER BY ecosystem,key LIMIT 100`,
      )
      .all(...where.args, after) as { ecosystem: string; key: string }[];
    if (!candidates.length) break;
    for (const candidate of candidates) {
      after = candidate.ecosystem + ':' + candidate.key;
      await writeCopy(async () => {
        const row = db()
          .transaction(() => {
            const current = db()
              .prepare(
                `${files} SELECT * FROM files WHERE ${where.sql} AND needed=0 AND ecosystem=? AND key=?`,
              )
              .get(...where.args, candidate.ecosystem, candidate.key) as any;
            if (!current) return null;
            // Keep upstream removal tombstones, so removal never permits serving a revoked version.
            if (current.removed_at)
              db()
                .prepare(
                  "UPDATE package_cache_entries SET size=0 WHERE ecosystem=? AND kind='file' AND key=?",
                )
                .run(current.ecosystem, current.key);
            else
              db()
                .prepare(
                  "DELETE FROM package_cache_entries WHERE ecosystem=? AND kind='file' AND key=?",
                )
                .run(current.ecosystem, current.key);
            return current;
          })
          .immediate();
        if (!row) return;
        versions++;
        if (
          !db()
            .prepare(
              "SELECT 1 FROM package_cache_entries WHERE kind='file' AND sha256=? AND size>0 LIMIT 1",
            )
            .get(row.sha256)
        ) {
          await rm(objectPath('cache', row.sha256), { force: true });
          bytes += row.size;
        }
      });
    }
    await yieldThread();
  }
  return { versions, bytes };
}
