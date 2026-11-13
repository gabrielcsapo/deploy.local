import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from './kernel/db/sqlite.ts';
import type { IntegrityCheck, IntegrityDatabases } from './readiness-integrity.ts';

function check(file: string): IntegrityCheck {
  try {
    const database = openDatabase(file, { readonly: true, fileMustExist: true });
    try {
      const rows = database.pragma('quick_check') as { quick_check: string }[];
      return rows.length === 1 && rows[0].quick_check === 'ok' ? 'ok' : 'integrity check failed';
    } finally {
      database.close();
    }
  } catch {
    // Public readiness must never expose SQL, paths or driver errors.
    return 'integrity check unavailable';
  }
}

const databases = workerData as IntegrityDatabases;
parentPort!.postMessage({ deploy: check(databases.deploy), workspace: check(databases.workspace) });
