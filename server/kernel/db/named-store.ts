import type { openDatabase } from './sqlite.ts';

type Database = ReturnType<typeof openDatabase>;
const databases = new Map<string, Database>();

/** Feature bootstrap owns opening and upgrading a store before registering it. */
export function registerDatabase(name: string, db: Database) {
  const previous = databases.get(name);
  if (previous && previous !== db) throw new Error(`Database already registered: ${name}`);
  databases.set(name, db);
}

/** Registration never opens a database or starts background work on import. */
export function namedDatabase(name: string): Database {
  const db = databases.get(name);
  if (!db) throw new Error(`Database not registered: ${name}`);
  return db;
}
