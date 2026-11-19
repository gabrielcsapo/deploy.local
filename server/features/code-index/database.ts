import { closeSync, openSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { withMigrationLock, openDatabase } from '../../kernel/db/index.ts';
import type { IndexProject, IndexStatus } from './model.ts';

export const schema = `
CREATE TABLE IF NOT EXISTS code_projects (
  owner TEXT NOT NULL, project TEXT NOT NULL, branch TEXT NOT NULL, "commit" TEXT NOT NULL,
  indexedAt TEXT NOT NULL, durationMs INTEGER NOT NULL, computer TEXT NOT NULL,
  extractedFiles INTEGER NOT NULL, incremental INTEGER NOT NULL, omittedFiles INTEGER NOT NULL,
  PRIMARY KEY(owner, project)
);
CREATE TABLE IF NOT EXISTS code_attempts (
  owner TEXT NOT NULL, project TEXT NOT NULL, "commit" TEXT NOT NULL, error TEXT,
  PRIMARY KEY(owner, project)
);
CREATE TABLE IF NOT EXISTS code_files (
  id INTEGER PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL,
  oid TEXT NOT NULL, bytes INTEGER NOT NULL, policy TEXT NOT NULL,
  kind TEXT NOT NULL, coverage TEXT NOT NULL, lines INTEGER NOT NULL, reason TEXT, errorLine INTEGER,
  data BLOB NOT NULL, title TEXT, body BLOB,
  UNIQUE(owner, project, path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS code_text USING fts5(body, content='', contentless_delete=1, tokenize='trigram');
CREATE TABLE IF NOT EXISTS code_staged_files (
  owner TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL, oid TEXT NOT NULL,
  bytes INTEGER NOT NULL, policy TEXT NOT NULL, data BLOB NOT NULL, body BLOB,
  PRIMARY KEY(owner, project, path)
);
CREATE TABLE IF NOT EXISTS code_packages (
  owner TEXT NOT NULL, project TEXT NOT NULL, manifest TEXT NOT NULL, ecosystem TEXT NOT NULL,
  name TEXT NOT NULL, version TEXT, description TEXT,
  PRIMARY KEY(owner, project, manifest)
);
CREATE INDEX IF NOT EXISTS code_package_name ON code_packages(owner, ecosystem, name);
CREATE TABLE IF NOT EXISTS code_dependencies (
  owner TEXT NOT NULL, project TEXT NOT NULL, manifest TEXT NOT NULL, ecosystem TEXT NOT NULL,
  alias TEXT NOT NULL, name TEXT NOT NULL, requirement TEXT, versions TEXT NOT NULL,
  producer TEXT, latest TEXT, places INTEGER NOT NULL, files INTEGER NOT NULL, mostly TEXT NOT NULL,
  PRIMARY KEY(owner, project, manifest, alias)
);
CREATE INDEX IF NOT EXISTS code_dependency_name ON code_dependencies(owner, ecosystem, name);
CREATE INDEX IF NOT EXISTS code_dependency_producer ON code_dependencies(owner, producer);
CREATE TABLE IF NOT EXISTS code_entries (
  owner TEXT NOT NULL, project TEXT NOT NULL, manifest TEXT NOT NULL, name TEXT NOT NULL,
  path TEXT NOT NULL, exposure TEXT NOT NULL,
  PRIMARY KEY(owner, project, manifest, name, path)
);
CREATE TABLE IF NOT EXISTS code_symbols (
  owner TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL, offset INTEGER NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, col INTEGER NOT NULL,
  signature TEXT NOT NULL, doc TEXT, handle TEXT NOT NULL,
  PRIMARY KEY(owner, project, path, offset)
);
CREATE UNIQUE INDEX IF NOT EXISTS code_symbol_handle ON code_symbols(owner, project, handle);
CREATE INDEX IF NOT EXISTS code_symbol_name ON code_symbols(owner, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS code_exports (
  owner TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
  targetProject TEXT NOT NULL, targetPath TEXT NOT NULL, targetOffset INTEGER NOT NULL,
  PRIMARY KEY(owner, project, path, name, targetProject, targetPath, targetOffset)
);
CREATE INDEX IF NOT EXISTS code_export_target ON code_exports(owner, targetProject, targetPath, targetOffset);
CREATE TABLE IF NOT EXISTS code_references (
  owner TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL, offset INTEGER NOT NULL,
  line INTEGER NOT NULL, col INTEGER NOT NULL,
  targetProject TEXT NOT NULL, targetPath TEXT NOT NULL, targetOffset INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  PRIMARY KEY(owner, project, path, offset, targetProject, targetPath, targetOffset)
);
CREATE INDEX IF NOT EXISTS code_reference_target ON code_references(owner, targetProject, targetPath, targetOffset);
`;

export const compress = (text: string) => deflateRawSync(text, { level: 1 });
export const expand = (blob: Buffer) => inflateRawSync(blob).toString();

export function openIndex(path: string, readonly = false) {
  if (readonly) return openDatabase(path, { readonly, fileMustExist: true, busyTimeoutMs: 1000 });
  // The index stores private repository text as well as identifiers.
  // Create it with owner-only permissions before SQLite creates WAL sidecars.
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const db = openDatabase(path, { wal: true, busyTimeoutMs: 5000 });
  try {
    if (db.pragma('user_version', { simple: true }) === 0) {
      withMigrationLock(path, () => {
        if (db.pragma('user_version', { simple: true }) === 0)
          db.transaction(() => {
            db.exec(schema);
            db.pragma('user_version = 1');
          })();
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export const readStatus = (db: ReturnType<typeof openIndex>, owner: string, project: string) =>
  db.prepare('SELECT * FROM code_projects WHERE owner=? AND project=?').get(owner, project) as
    | (IndexStatus & { owner: string })
    | undefined;

export function listIndexProjects(workspace: string, owner: string): IndexProject[] {
  const db = openDatabase(workspace, { readonly: true, fileMustExist: true, busyTimeoutMs: 1000 });
  try {
    return (
      db
        .prepare(`SELECT id, json_extract(data,'$.name') name,
      json_extract(data,'$.description') description, json_extract(data,'$.repositoryPath') repositoryPath,
      COALESCE(NULLIF(json_extract(data,'$.defaultBranch'),''),'main') defaultBranch
      FROM records WHERE kind='project' AND owner=? AND json_type(data,'$.repositoryPath')='text'
      AND COALESCE(json_extract(data,'$.repositoryStatus'),'ready')='ready'`)
        .all(owner) as IndexProject[]
    ).filter((project) => project.repositoryPath);
  } finally {
    db.close();
  }
}
