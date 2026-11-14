import { setStoredValueReader } from '../kernel/read-value.ts';
import { migrateCoordinatorUrls } from './startup-url-migration.ts';
import { readStoredUrls } from './stored-urls.ts';
import { workspaceRecords } from '../kernel/db/records.ts';
export { save, get, list, remove, onRecordChange } from '../kernel/db/records.ts';
export { command, commandReplay } from '../kernel/db/operations.ts';
import { registerDatabase } from '../kernel/db/named-store.ts';
export { event, events, cursor } from '../kernel/events/index.ts';
import { migrateJobOutput } from './job-output.ts';
import { ensureMessageSearch } from './message-search.ts';
import { openWorkspaceDatabase, withWorkspaceDatabaseGate } from '../kernel/db/database-open.ts';
import { externalizeCheckpoint, materializeCheckpoint } from './checkpoint-storage.ts';
export { checkpointInfo } from './checkpoint-metadata.ts';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deployDataDirectory } from '../kernel/files/data-directory.ts';
setStoredValueReader(readStoredUrls);
export const root = resolve(deployDataDirectory(), 'workspace');
mkdirSync(root, { recursive: true });
export const db = openWorkspaceDatabase(resolve(root, 'workspace.db'), {
  busyTimeoutMs: 5000,
  wal: true,
});
withWorkspaceDatabaseGate(resolve(root, 'workspace.db'), () => {
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
  // Only the record kinds these lookups read, so the indexes stay small and quick to build.
  db.exec(`CREATE INDEX IF NOT EXISTS record_run_project ON records(owner,json_extract(data,'$.projectId')) WHERE kind='pipeline-run';
CREATE INDEX IF NOT EXISTS record_trigger_project ON records(owner,json_extract(data,'$.projectId')) WHERE kind='pipeline-trigger';
CREATE INDEX IF NOT EXISTS record_pull_project ON records(owner,json_extract(data,'$.projectId')) WHERE kind='pull-request';
CREATE INDEX IF NOT EXISTS record_checkpoint_task ON records(owner,json_extract(data,'$.taskId')) WHERE kind='checkpoint';
CREATE INDEX IF NOT EXISTS record_job_pipeline ON records(owner,json_extract(data,'$.pipelineId')) WHERE kind='job';
CREATE INDEX IF NOT EXISTS record_job_status ON records(owner,json_extract(data,'$.status')) WHERE kind='job';`);
  migrateJobOutput(db);
  ensureMessageSearch(db);
  migrateCoordinatorUrls(db, root);
});
// Register only after the existing schema, indexes and inline upgrades finish.
registerDatabase('workspace', db);
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
// Feature serialization and SQL remain here; the named store owns generic CRUD.
workspaceRecords.registerAdapter('checkpoint', {
  encode: (_owner, row) => externalizeCheckpoint(root, row),
  decode: (row) => materializeCheckpoint(root, row),
});
workspaceRecords.registerAdapter('job', {
  immediate: true,
  encode(owner, row) {
    if (Object.hasOwn(row, 'output')) {
      db.prepare(`INSERT INTO job_output(owner,id,output) VALUES(?,?,?)
          ON CONFLICT(owner,id) DO UPDATE SET output=excluded.output`).run(
        owner,
        row.id,
        String(row.output ?? ''),
      );
    } else {
      // A legacy writer may have replaced the metadata since it was listed.
      // Preserve that newer inline output before overwriting the row.
      db.prepare(`INSERT INTO job_output(owner,id,output)
          SELECT owner,id,COALESCE(json_extract(data,'$.output'),'') FROM records
          WHERE kind='job' AND owner=? AND id=? AND json_type(data,'$.output') IS NOT NULL
          ON CONFLICT(owner,id) DO UPDATE SET output=excluded.output`).run(owner, row.id);
    }
    const { output: _, ...metadata } = row;
    return metadata;
  },
  list(owner) {
    // Strip legacy inline output too, without ever consulting job_output.
    const rows = db
      .prepare(`SELECT json_remove(data,'$.output') AS data
      FROM records WHERE kind=? AND owner=? ORDER BY rowid`)
      .all('job', owner) as { data: string }[];
    return rows.map((row) => readStoredUrls(JSON.parse(row.data)));
  },
  get(owner, recordId) {
    // Read metadata and output in one SQLite snapshot, including legacy inline writes.
    const r = db.prepare(`SELECT r.data, ${jobOutputQuery}`).get(owner, recordId) as
      | { data: string; output?: string | null }
      | undefined;
    if (!r) throw Object.assign(new Error('Not found'), { status: 404 });
    return { ...readStoredUrls(JSON.parse(r.data)), output: r.output ?? '' };
  },
});
const jobOutputQuery = `CASE WHEN json_type(r.data,'$.output') IS NOT NULL
    THEN json_extract(r.data,'$.output') ELSE o.output END AS output
  FROM records r LEFT JOIN job_output o ON o.owner=r.owner AND o.id=r.id
  WHERE r.kind='job' AND r.owner=? AND r.id=?`;

/** Hydrate only jobs whose output is actually consumed, after filtering metadata.
 * Inline output from a legacy writer always wins, including an explicit empty string.
 */
export function jobOutput(owner: string, recordId: string): string {
  const row = db.prepare(`SELECT ${jobOutputQuery}`).get(owner, recordId) as
    | { output: string | null }
    | undefined;
  return readStoredUrls(row?.output ?? '');
}

const checkpointFields = [
  'id',
  'taskId',
  'runId',
  'createdAt',
  'baseRef',
  'projectId',
  'title',
  'summary',
  'baseUpdateId',
  'baseUpdateGeneration',
];
const checkpointProjection = `json_object(
  ${checkpointFields.map((field) => `'${field}',json_extract(data,'$.${field}')`).join(',')},
  'snapshotInfo',json(COALESCE(json_extract(data,'$.snapshotInfo'),json_object(
    'digest',json_extract(data,'$.snapshot.digest'),
    'baseCommit',json_extract(data,'$.snapshot.base.commit'),
    'fileCount',COALESCE(json_array_length(data,'$.snapshot.files'),0),
    'excludedCount',COALESCE(json_array_length(data,'$.snapshot.excluded'),0)
  )))
)`;

/** Filtering precedes projection, using the checkpoint-only task index. */
export function listCheckpointMetadata(owner: string, taskId?: string): any[] {
  return (
    db
      .prepare(`SELECT ${checkpointProjection} AS data FROM records
    WHERE kind='checkpoint' AND owner=? ${taskId === undefined ? '' : "AND json_extract(data,'$.taskId')=?"}
    ORDER BY rowid`)
      .all(...(taskId === undefined ? [owner] : [owner, taskId])) as { data: string }[]
  ).map((row) => readStoredUrls(JSON.parse(row.data)));
}

export function getCheckpointMetadata(owner: string, recordId: string): any {
  const row = db
    .prepare(`SELECT ${checkpointProjection} AS data FROM records
    WHERE kind='checkpoint' AND owner=? AND id=?`)
    .get(owner, recordId) as { data: string } | undefined;
  if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
  return readStoredUrls(JSON.parse(row.data));
}

/** Task detail carries a bounded tail of raw events; older ones page via eventsBefore(). */
export const TASK_DETAIL_EVENT_LIMIT = 200;
export const TASK_DETAIL_EVENT_BYTES = 256 * 1024;
/** A single payload above this is summarized as `{ omitted: true, bytes }` in the snapshot. */
export const TASK_DETAIL_EVENT_PAYLOAD_BYTES = 16 * 1024;

/**
 * Recent raw events for a task snapshot, newest kept first under a count and
 * byte budget. `before` is the cursor to pass to eventsBefore() (the events
 * API's `before=`) for the next older page, or null when nothing was left out.
 */
export function recentEvents(
  owner: string,
  taskId: string,
  {
    limit = TASK_DETAIL_EVENT_LIMIT,
    maxBytes = TASK_DETAIL_EVENT_BYTES,
    maxPayloadBytes = TASK_DETAIL_EVENT_PAYLOAD_BYTES,
  } = {},
) {
  const rows = db
    .prepare('SELECT * FROM events WHERE owner=? AND taskId=? ORDER BY cursor DESC LIMIT ?')
    .all(owner, taskId, limit + 1) as any[];
  const events: any[] = [];
  let truncated = rows.length > limit;
  let bytes = 0;
  for (const { owner: _, payload, ...row } of rows.slice(0, limit)) {
    const size = Buffer.byteLength(payload);
    const omitted = size > maxPayloadBytes;
    const cost = (omitted ? 0 : size) + 160; // + the event's own fields
    if (events.length && bytes + cost > maxBytes) {
      truncated = true;
      break;
    }
    bytes += cost;
    events.push({
      ...row,
      payload: omitted ? { omitted: true, bytes: size } : readStoredUrls(JSON.parse(payload)),
    });
  }
  events.reverse();
  return { events, truncated, before: truncated ? (events[0]?.cursor ?? null) : null };
}

/** Older raw events for one task, oldest first, ending just before `before`. */
export function eventsBefore(owner: string, before: number, taskId: string, limit = 200) {
  const rows = db
    .prepare(
      'SELECT * FROM events WHERE owner=? AND taskId=? AND cursor<? ORDER BY cursor DESC LIMIT ?',
    )
    .all(owner, taskId, before, limit) as any[];
  return rows
    .reverse()
    .map(({ owner: _, payload, ...r }) => ({ ...r, payload: readStoredUrls(JSON.parse(payload)) }));
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
    .map((r) => ({ ...r, payload: readStoredUrls(JSON.parse(r.payload)) }));
}
export function revise(task: any, revision: number) {
  if (task.revision !== revision)
    throw Object.assign(new Error('Task changed; refresh before retrying'), { status: 409 });
}
