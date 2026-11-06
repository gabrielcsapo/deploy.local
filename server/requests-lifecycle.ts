import type Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';
import { trackCiWorker } from './ci-fence.ts';
import { packageWorkerFile } from './packages/worker-file.ts';
import { getRequestsSqlite, requestsDbFile, resetRequestsDb } from './requests-db.ts';
import { compactLegacyRequests, ensureImportSource } from './requests-migration.ts';

let worker: Worker | undefined;
let sourceFile: string | undefined;

/** Only the control plane calls this, after Drizzle migration and before serving. */
export function initializeRequestStorage(source: Database.Database) {
  if (sourceFile === source.name) return;
  stopRequestCopy();
  const sourceId = ensureImportSource(source);
  const target = getRequestsSqlite();
  // Only receipts from a PREVIOUS start are eligible. The worker starts below.
  compactLegacyRequests(source, target, sourceId);
  sourceFile = source.name;
  if (
    !source.prepare('SELECT 1 FROM request_logs LIMIT 1').get() &&
    !source.prepare('SELECT 1 FROM request_logs_1m LIMIT 1').get()
  )
    return;
  console.log(
    '[requests] Copying legacy history in background; older history is partial until completion',
  );
  try {
    worker = trackCiWorker(
      new Worker(
        packageWorkerFile(import.meta.url, 'requests-copy-worker.js', './requests-copy-worker.ts'),
        {
          workerData: { sourceFile: source.name, targetFile: requestsDbFile(), sourceId },
        },
      ),
    );
  } catch (error) {
    console.error('[requests] Could not start copy; will retry next start:', error);
    return;
  }
  const current = worker;
  current.on('error', (error) =>
    console.error('[requests] Copy stopped; will resume on next start:', error),
  );
  current.on('exit', () => {
    if (worker === current) worker = undefined;
  });
  current.unref();
}
export function stopRequestCopy() {
  if (worker) {
    // Termination rolls back any in-flight batch; committed cursors remain safe.
    void worker.terminate();
    worker = undefined;
  }
  sourceFile = undefined;
}
export function resetRequestStorage() {
  stopRequestCopy();
  resetRequestsDb();
}
