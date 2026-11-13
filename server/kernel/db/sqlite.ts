import { createRequire } from 'node:module';
import type Driver from 'better-sqlite3';

export type Database = Driver.Database;

/** Omitted options leave the driver's existing defaults and the file's mode alone. */
export function openDatabase(
  file: string,
  {
    readonly,
    fileMustExist,
    wal,
    busyTimeoutMs,
    foreignKeys,
  }: {
    readonly?: boolean;
    fileMustExist?: boolean;
    wal?: boolean;
    busyTimeoutMs?: number;
    foreignKeys?: boolean;
  } = {},
): Database {
  // Keep the native driver lazy: the standalone CLI also bundles secrets.ts, but
  // only needs SQLite when inspecting an existing local database for lost keys.
  const Driver = createRequire(import.meta.url)(
    'better-sqlite3',
  ) as typeof import('better-sqlite3');
  const db = new Driver(file, {
    ...(readonly !== undefined ? { readonly } : {}),
    ...(fileMustExist !== undefined ? { fileMustExist } : {}),
  });
  try {
    if (busyTimeoutMs !== undefined) db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (wal) {
      // Concurrent first opens can reject WAL promotion despite busy_timeout.
      // Retry only that startup lock; leave every other SQLite error visible.
      const deadline = Date.now() + 5000;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      for (;;) {
        try {
          db.pragma('journal_mode = WAL');
          break;
        } catch (error: any) {
          if (error.code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
          Atomics.wait(wait, 0, 0, 25);
        }
      }
    }
    if (foreignKeys !== undefined) db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
