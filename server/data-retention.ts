import type Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';

const DAY = 86_400_000;
export const RETENTION_BATCH_SIZE = 100;

/** Scan bounded primary-key pages, including retained rows, instead of a large DELETE scan. */
export async function pruneDeploymentData(
  db: Database.Database,
  now = Date.now(),
  onBatch?: () => void,
) {
  const counts = { history: 0, agent_jobs: 0, build_logs: 0 };
  const iso = (days: number) => new Date(now - days * DAY).toISOString();
  const policies = {
    history: {
      where: `timestamp < CASE WHEN action = 'graph:recovered' THEN ? ELSE ? END`,
      args: [iso(14), iso(365)],
    },
    agent_jobs: {
      where: `status IN ('complete','failed') AND COALESCE(completed_at,created_at) < CASE WHEN type = 'logs' THEN ? ELSE ? END`,
      args: [now - 2 * DAY, now - 90 * DAY],
    },
    // CI release records in workspace.db also retain build IDs. Preserve row identity
    // and metadata; reclaim only the large payloads (output is NOT NULL).
    build_logs: {
      where: `timestamp < ? AND (output != '' OR runtime_logs IS NOT NULL) AND status NOT IN ('building','running','queued')
      AND id NOT IN (SELECT newest.id FROM build_logs newest WHERE newest.deployment_name = build_logs.deployment_name ORDER BY newest.timestamp DESC, newest.id DESC LIMIT 50)
      AND NOT EXISTS (SELECT 1 FROM deployments WHERE current_build_log_id = build_logs.id)
      AND NOT EXISTS (SELECT 1 FROM history WHERE build_log_id = build_logs.id)
      AND NOT EXISTS (SELECT 1 FROM backups WHERE related_build_log_id = build_logs.id)`,
      args: [iso(90)],
    },
  };
  for (const table of ['history', 'agent_jobs', 'build_logs'] as const) {
    const { where, args } = policies[table];
    const through = (
      db.prepare(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${table}`).get() as { n: number }
    ).n;
    let cursor = 0;
    while (cursor < through) {
      const timeout = db.pragma('busy_timeout', { simple: true }) as number;
      db.pragma('busy_timeout = 25');
      try {
        db.transaction(() => {
          const rows = db
            .prepare(
              `SELECT rowid AS id FROM ${table} WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
            )
            .all(cursor, through, RETENTION_BATCH_SIZE) as { id: number }[];
          const end = rows.at(-1)?.id ?? through;
          counts[table] += db
            .prepare(
              `${table === 'build_logs' ? "UPDATE build_logs SET output = '', runtime_logs = NULL" : `DELETE FROM ${table}`} WHERE rowid > ? AND rowid <= ? AND (${where})`,
            )
            .run(cursor, end, ...args).changes;
          cursor = end;
        }).immediate();
      } finally {
        db.pragma(`busy_timeout = ${timeout}`);
      }
      onBatch?.();
      await delay(10);
    }
  }
  return counts;
}
