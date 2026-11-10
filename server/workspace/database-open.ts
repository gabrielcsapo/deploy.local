import Database from 'better-sqlite3';

/**
 * Serialize opens with the offline rewrite using a tiny separate SQLite lock database.
 * The OS releases this lock on SIGKILL too; a failed conversion cannot strand a lock file.
 */
export function withWorkspaceDatabaseGate<T>(file: string, run: () => T): T {
  const gate = new Database(`${file}.maintenance.db`);
  try {
    gate.pragma('busy_timeout = 5000');
    gate.exec('CREATE TABLE IF NOT EXISTS gate(id INTEGER PRIMARY KEY)');
    return gate.transaction(run).immediate();
  } finally {
    gate.close();
  }
}

export function openWorkspaceDatabase(file: string) {
  return withWorkspaceDatabaseGate(file, () => {
    const db = new Database(file);
    try {
      // Effective immediately on an empty database; legacy databases need the offline command.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get())
        db.pragma('auto_vacuum = INCREMENTAL');
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  });
}
