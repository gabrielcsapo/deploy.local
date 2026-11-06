/** All request-log connections (control plane, edge, writers, and migration). */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { deployDataPath } from './data-directory.ts';

export const REQUEST_RETENTION_DAYS = 90;
export const ROLLUP_RETENTION_DAYS = 396;
export const REQUEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS request_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
 deployment_name TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
 status INTEGER NOT NULL, duration INTEGER NOT NULL, timestamp INTEGER NOT NULL,
 ip TEXT, user_agent TEXT, referrer TEXT, request_size INTEGER, response_size INTEGER,
 query_params TEXT, username TEXT, capture_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(deployment_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs(timestamp);
CREATE TABLE IF NOT EXISTS request_logs_1m (
 deployment_name TEXT NOT NULL, bucket_ms INTEGER NOT NULL,
 count INTEGER NOT NULL DEFAULT 0, errors_4xx INTEGER NOT NULL DEFAULT 0,
 errors_5xx INTEGER NOT NULL DEFAULT 0, duration_sum INTEGER NOT NULL DEFAULT 0,
 duration_min INTEGER NOT NULL DEFAULT 0, duration_max INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(deployment_name, bucket_ms)
);
CREATE INDEX IF NOT EXISTS idx_request_logs_1m_bucket ON request_logs_1m(bucket_ms);
CREATE TABLE IF NOT EXISTS request_log_import (source TEXT PRIMARY KEY, state TEXT NOT NULL);
`;

export function requestsDbFile() {
  return deployDataPath('requests.db');
}

export function openRequestsDb(file = requestsDbFile()) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(REQUEST_SCHEMA);
    // Reserve the legacy ID range before ANY new writer can insert. This also
    // works when the edge opens first. MAX(id) is a primary-key lookup, not a scan.
    const sourceFile = join(dirname(file), 'deploy.db');
    if (existsSync(sourceFile)) {
      const source = new Database(sourceFile, { readonly: true, fileMustExist: true });
      try {
        if (source.prepare("SELECT 1 FROM sqlite_master WHERE name='request_logs'").get()) {
          const high = (
            source.prepare('SELECT coalesce(max(id),0) AS id FROM request_logs').get() as {
              id: number;
            }
          ).id;
          db.transaction(() => {
            const seq = db
              .prepare("SELECT seq FROM sqlite_sequence WHERE name='request_logs'")
              .get() as { seq: number } | undefined;
            if (!seq)
              db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('request_logs',?)").run(
                high,
              );
            else if (seq.seq < high)
              db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='request_logs'").run(high);
          }).immediate();
        }
      } finally {
        source.close();
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

let connection: Database.Database | undefined;
let file: string | undefined;
export function getRequestsSqlite() {
  const next = requestsDbFile();
  if (file !== next || !connection?.open) {
    resetRequestsDb();
    connection = openRequestsDb(next);
    file = next;
  }
  return connection!;
}
export function getRequestsDb() {
  return drizzle(getRequestsSqlite());
}
export function resetRequestsDb() {
  connection?.close();
  connection = undefined;
  file = undefined;
}

export function pruneRequests(db = getRequestsSqlite(), now = Date.now()) {
  return db.transaction(() => ({
    requests: db
      .prepare('DELETE FROM request_logs WHERE timestamp < ?')
      .run(now - REQUEST_RETENTION_DAYS * 86_400_000).changes,
    rollups: db
      .prepare('DELETE FROM request_logs_1m WHERE bucket_ms < ?')
      .run(now - ROLLUP_RETENTION_DAYS * 86_400_000).changes,
  }))();
}
