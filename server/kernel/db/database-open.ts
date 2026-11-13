import { openDatabase } from './sqlite.ts';

/**
 * Serialize opens with the offline rewrite using a tiny separate SQLite lock database.
 * The OS releases this lock on SIGKILL too; a failed conversion cannot strand a lock file.
 */
export function withWorkspaceDatabaseGate<T>(file: string, run: () => T): T {
  const gate = openDatabase(`${file}.maintenance.db`, { busyTimeoutMs: 5000 });
  try {
    gate.exec('CREATE TABLE IF NOT EXISTS gate(id INTEGER PRIMARY KEY)');
    return gate.transaction(run).immediate();
  } finally {
    gate.close();
  }
}

export function openWorkspaceDatabase(file: string, options?: Parameters<typeof openDatabase>[1]) {
  return withWorkspaceDatabaseGate(file, () => {
    const db = openDatabase(file);
    try {
      // Effective immediately on an empty database; legacy databases need the offline command.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get())
        db.pragma('auto_vacuum = INCREMENTAL');
      if (!options) return db;
      // The empty database header must be initialized before WAL promotion;
      // changing auto_vacuum after WAL is enabled does not take effect.
      // Keep both opens inside the maintenance gate.
      db.close();
      return openDatabase(file, options);
    } catch (error) {
      if (db.open) db.close();
      throw error;
    }
  });
}
