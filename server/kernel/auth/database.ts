import type { Database } from '../db/sqlite.ts';

let database: (() => Database) | undefined;

/** The existing engine bootstrap supplies its existing connection, never a second store. */
export function configureAuthDatabase(open: () => Database) {
  database = open;
}
export function authDatabase(): Database {
  if (!database) throw new Error('Auth database is not configured');
  return database();
}
