import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deployDataDirectory } from '../data-directory.ts';
export const root = resolve(deployDataDirectory(), 'workspace');
mkdirSync(root, { recursive: true });
export const db = new Database(resolve(root, 'workspace.db'));
db.pragma('busy_timeout = 5000');
// Concurrent first opens can fail WAL promotion immediately despite busy_timeout.
// Retry only that startup lock; all other SQLite errors must remain visible.
const walDeadline = Date.now() + 5000;
const walWait = new Int32Array(new SharedArrayBuffer(4));
for (;;) {
  try {
    db.pragma('journal_mode = WAL');
    break;
  } catch (error: any) {
    if (error.code !== 'SQLITE_BUSY' || Date.now() >= walDeadline) throw error;
    Atomics.wait(walWait, 0, 0, 25);
  }
}
db.exec(
  `CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,owner TEXT,data TEXT,PRIMARY KEY(kind,id,owner)); CREATE INDEX IF NOT EXISTS record_kind ON records(kind,owner); CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT,taskId TEXT,runId TEXT,type TEXT,payload TEXT,createdAt TEXT); CREATE TABLE IF NOT EXISTS operations(owner TEXT,id TEXT,result TEXT,PRIMARY KEY(owner,id)); CREATE TABLE IF NOT EXISTS worker(id TEXT PRIMARY KEY,pid INTEGER,heartbeat TEXT);`,
);
if ((db.pragma('table_info(records)') as any[]).filter((c) => c.pk).length < 3)
  db.transaction(() => {
    db.exec(
      'ALTER TABLE records RENAME TO records_v0; CREATE TABLE records(kind TEXT,id TEXT,owner TEXT,data TEXT,PRIMARY KEY(kind,id,owner)); INSERT INTO records SELECT * FROM records_v0; DROP TABLE records_v0; CREATE INDEX record_kind ON records(kind,owner)',
    );
  })();
// Keep task activity and reconnect reads bounded even after unrelated histories grow.
db.exec(
  'CREATE INDEX IF NOT EXISTS event_owner_cursor ON events(owner,cursor); CREATE INDEX IF NOT EXISTS event_task_cursor ON events(owner,taskId,cursor)',
);
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export function save(kind: string, owner: string, row: any) {
  db.prepare(
    'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id,owner) DO UPDATE SET data=excluded.data',
  ).run(kind, row.id, owner, JSON.stringify(row));
  return row;
}
export function list(kind: string, owner: string): any[] {
  return (
    db
      .prepare('SELECT data FROM records WHERE kind=? AND owner=? ORDER BY rowid')
      .all(kind, owner) as any[]
  ).map((r) => JSON.parse(r.data));
}
export function get(kind: string, owner: string, recordId: string): any {
  const r = db
    .prepare('SELECT data FROM records WHERE kind=? AND owner=? AND id=?')
    .get(kind, owner, recordId) as any;
  if (!r) throw Object.assign(new Error('Not found'), { status: 404 });
  return JSON.parse(r.data);
}
export function event(
  owner: string,
  taskId: string,
  runId: string | null,
  type: string,
  payload: any,
) {
  db.prepare(
    'INSERT INTO events(owner,taskId,runId,type,payload,createdAt) VALUES(?,?,?,?,?,?)',
  ).run(owner, taskId, runId, type, JSON.stringify(payload), now());
}
export function events(owner: string, after = 0, taskId?: string) {
  const rows = db
    .prepare(
      `SELECT * FROM events WHERE owner=? AND cursor>? ${taskId ? 'AND taskId=?' : ''} ORDER BY cursor LIMIT 1000`,
    )
    .all(...(taskId ? [owner, after, taskId] : [owner, after])) as any[];
  return rows.map(({ owner: _, payload, ...r }) => ({ ...r, payload: JSON.parse(payload) }));
}
/** Recent activity for a task snapshot; older history remains available via events(after). */
export function recentEvents(owner: string, taskId: string) {
  const rows = db
    .prepare('SELECT * FROM events WHERE owner=? AND taskId=? ORDER BY cursor DESC LIMIT 1000')
    .all(owner, taskId) as any[];
  return rows
    .reverse()
    .map(({ owner: _, payload, ...r }) => ({ ...r, payload: JSON.parse(payload) }));
}

/** Keep tool history independent of high-volume text deltas. Raw replay is unchanged. */
export function activityEvents(owner: string, taskId: string) {
  return (
    db
      .prepare(`SELECT cursor,runId,type,payload,createdAt FROM events
    WHERE owner=? AND taskId=? AND type IN ('item.started','item.updated','item.completed')
    AND json_extract(payload,'$.item.type') IN ('command_execution','tool_call','tool_result','mcp_tool_call','file_change','web_search')
    ORDER BY cursor DESC LIMIT 4000`)
      .all(owner, taskId) as any[]
  )
    .reverse()
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
export function cursor(owner: string) {
  return (
    db.prepare('SELECT COALESCE(MAX(cursor),0) AS n FROM events WHERE owner=?').get(owner) as any
  ).n;
}
export function commandReplay(
  owner: string,
  operationId: string,
  signature?: string,
): { found: boolean; result?: any } {
  if (typeof operationId !== 'string' || !operationId || operationId.length > 200)
    throw Object.assign(new Error('operationId required'), { status: 400 });
  const old = db
    .prepare('SELECT result FROM operations WHERE owner=? AND id=?')
    .get(owner, operationId) as any;
  if (!old) return { found: false };
  const decoded = JSON.parse(old.result);
  if (decoded['__workspaceOperation'] === 1) {
    if (signature && decoded.signature && signature !== decoded.signature)
      throw Object.assign(new Error('operationId was already used for a different command'), {
        status: 409,
      });
    return { found: true, result: decoded.result };
  }
  return { found: true, result: decoded };
}
export function command(owner: string, operationId: string, fn: () => any, signature?: string) {
  return db
    .transaction(() => {
      const replay = commandReplay(owner, operationId, signature);
      if (replay.found) return replay.result;
      const result = fn();
      db.prepare('INSERT INTO operations VALUES(?,?,?)').run(
        owner,
        operationId,
        JSON.stringify({ __workspaceOperation: 1, signature: signature || null, result }),
      );
      return result;
    })
    .immediate();
}
export function revise(task: any, revision: number) {
  if (task.revision !== revision)
    throw Object.assign(new Error('Task changed; refresh before retrying'), { status: 409 });
}
