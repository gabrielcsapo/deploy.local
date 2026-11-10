import { chmodSync, renameSync, rmSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from './sqlite.ts';

/**
 * Copies each live database in one backup step, which is one read transaction: every committed page,
 * WAL included, and nothing uncommitted. The default page-by-page rate restarts on every write from
 * another connection and may never finish; one step on the control thread would block it for the
 * whole copy. Here it blocks nothing, and writers carry on in the WAL. Loads no server code.
 */
try {
  for (const { source, target } of workerData.databases as Array<{
    source: string;
    target: string;
  }>) {
    const temporary = `${target}.tmp`;
    rmSync(temporary, { force: true });
    try {
      const database = openDatabase(source, { readonly: true, fileMustExist: true });
      try {
        await database.backup(temporary, { progress: () => 0x7fffffff });
      } finally {
        database.close();
      }
      // A snapshot stands alone, with no -wal or -shm. The server turns WAL back on when it opens it.
      const snapshot = openDatabase(temporary);
      try {
        snapshot.pragma('journal_mode = DELETE');
      } finally {
        snapshot.close();
      }
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new Error(`${source}: ${(error as Error).message}`);
    }
  }
  parentPort!.postMessage({ ok: true });
} catch (error) {
  parentPort!.postMessage({ error: (error as Error).message });
}
