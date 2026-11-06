import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { openRequestsDb } from './requests-db.ts';
import { copyRequestBatch, legacyHighId } from './requests-migration.ts';

const { sourceFile, targetFile, sourceId } = workerData as {
  sourceFile: string;
  targetFile: string;
  sourceId: string;
};
const source = new Database(sourceFile, { readonly: true, fileMustExist: true });
const target = openRequestsDb(targetFile);
source.pragma('busy_timeout = 5000');
let stopped = false;
parentPort?.on('message', () => {
  stopped = true;
});
let rows = 0;
let batches = 0;
let maxMs = 0;
const start = Date.now();
try {
  while (!stopped) {
    const batch = copyRequestBatch(source, target, sourceId);
    parentPort?.postMessage(batch);
    rows += batch.rows;
    batches++;
    maxMs = Math.max(maxMs, batch.ms);
    if (batches % 100 === 0 || batch.state.phase === 'done') {
      console.log(
        `[requests] Copy ${batch.state.phase}: ${rows} rows, ${batches} batches, last=${batch.ms.toFixed(1)}ms max=${maxMs.toFixed(1)}ms elapsed=${Date.now() - start}ms`,
      );
    }
    if (batch.state.phase === 'done' && legacyHighId(source) <= batch.state.highId) break;
    // Release the write lock and yield between batches so live writers get turns.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
} finally {
  target.close();
  source.close();
  parentPort?.close();
}
