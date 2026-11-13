import { namedDatabase } from '../db/named-store.ts';

export { createOwnerEventPoller } from './owner-poller.ts';

// Use the caller's connection: inserts participate in its transaction. Polling
// observes committed writes from independent processes without an in-memory bus.
export function event(
  owner: string,
  taskId: string,
  runId: string | null,
  type: string,
  payload: any,
) {
  const db = namedDatabase('workspace');
  db.prepare(
    'INSERT INTO events(owner,taskId,runId,type,payload,createdAt) VALUES(?,?,?,?,?,?)',
  ).run(owner, taskId, runId, type, JSON.stringify(payload), new Date().toISOString());
}
export function events(owner: string, after = 0, taskId?: string) {
  const db = namedDatabase('workspace');
  const rows = db
    .prepare(
      `SELECT * FROM events WHERE owner=? AND cursor>? ${taskId ? 'AND taskId=?' : ''} ORDER BY cursor LIMIT 1000`,
    )
    .all(...(taskId ? [owner, after, taskId] : [owner, after])) as any[];
  return rows.map(({ owner: _, payload, ...r }) => ({ ...r, payload: JSON.parse(payload) }));
}
export function cursor(owner: string) {
  const db = namedDatabase('workspace');
  return (
    db.prepare('SELECT COALESCE(MAX(cursor),0) AS n FROM events WHERE owner=?').get(owner) as any
  ).n;
}
