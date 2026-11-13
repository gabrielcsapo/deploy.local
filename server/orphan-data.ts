import type { Database } from './kernel/db/sqlite.ts';
import { lstatSync } from 'node:fs';
import { basename, join } from 'node:path';

export type CleanupCounts = {
  history: number;
  build_logs: number;
  agent_jobs: number;
  resource_metrics: number;
  backups: number;
};
const emptyCounts = (): CleanupCounts => ({
  history: 0,
  build_logs: 0,
  agent_jobs: 0,
  resource_metrics: 0,
  backups: 0,
});

function archiveMissing(root: string, name: string, filename: string) {
  // Malformed legacy paths or inaccessible archives are not evidence of absence.
  if (
    basename(name) !== name ||
    basename(filename) !== filename ||
    name === '..' ||
    filename === '..'
  )
    return false;
  try {
    lstatSync(join(root, 'backups', name, filename));
    return false;
  } catch (error: any) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

/** Caller holds the deletion transaction. Never removes files, volumes, or unfinished jobs. */
export function cleanupDeploymentRows(
  db: Database,
  root: string,
  name: string,
  apply = false,
): CleanupCounts {
  const counts = emptyCounts();
  const predicates = {
    history: `deployment_name = ? AND id != COALESCE((SELECT MAX(id) FROM history WHERE deployment_name = ? AND action = 'delete'),-1)`,
    build_logs: 'deployment_name = ?',
    agent_jobs: "deployment_name = ? AND status IN ('complete','failed')",
    resource_metrics: 'deployment_name = ?',
  };
  for (const table of ['history', 'build_logs', 'agent_jobs', 'resource_metrics'] as const) {
    const args = table === 'history' ? [name, name] : [name];
    counts[table] = (
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${predicates[table]}`).get(...args) as {
        n: number;
      }
    ).n;
    if (apply) {
      if (table === 'build_logs') {
        db.prepare(
          'UPDATE backups SET related_build_log_id = NULL WHERE related_build_log_id IN (SELECT id FROM build_logs WHERE deployment_name = ?)',
        ).run(name);
        db.prepare(
          'UPDATE history SET build_log_id = NULL WHERE build_log_id IN (SELECT id FROM build_logs WHERE deployment_name = ?)',
        ).run(name);
      }
      db.prepare(`DELETE FROM ${table} WHERE ${predicates[table]}`).run(...args);
    }
  }
  const backups = db
    .prepare('SELECT id,filename FROM backups WHERE deployment_name = ?')
    .all(name) as { id: number; filename: string }[];
  for (const backup of backups) {
    if (!archiveMissing(root, name, backup.filename)) continue;
    counts.backups++;
    if (apply) db.prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
  }
  return counts;
}

/** A dry run is read-only. Apply rechecks existence while holding each app's write transaction. */
export function purgeOrphanedDeploymentData(
  db: Database,
  root: string,
  options: { apply?: boolean } = {},
): CleanupCounts {
  const totals = emptyCounts();
  const names = db
    .prepare(
      `SELECT deployment_name AS name FROM history UNION SELECT deployment_name FROM build_logs UNION SELECT deployment_name FROM agent_jobs UNION SELECT deployment_name FROM resource_metrics UNION SELECT deployment_name FROM backups`,
    )
    .all() as { name: string }[];
  for (const { name } of names) {
    const run = () => {
      if (db.prepare('SELECT 1 FROM deployments WHERE name = ?').get(name)) return;
      const counts = cleanupDeploymentRows(db, root, name, options.apply === true);
      for (const table of Object.keys(totals) as (keyof CleanupCounts)[])
        totals[table] += counts[table];
    };
    if (options.apply) db.transaction(run).immediate();
    else run();
  }
  return totals;
}
