/**
 * Destructive benchmark on a disposable COPY only; never pass the live data directory.
 * Make a consistent SQLite backup as <directory>/deploy.db first, then:
 * node --import tsx scripts/perf/request-storage.ts --data-copy <directory>
 * Re-run the same command to measure resume. Ctrl-C leaves a committed cursor.
 * Includes the real worker's 500-row batches/10ms yield and next-start cleanup.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../../server/sqlite.ts';
import { openRequestsDb } from '../../server/requests-db.ts';
import {
  compactLegacyRequests,
  ensureImportSource,
  readImportState,
} from '../../server/requests-migration.ts';

if (process.argv.length !== 4 || process.argv[2] !== '--data-copy') {
  throw new Error(
    'Usage: node --import tsx scripts/perf/request-storage.ts --data-copy <disposable-copy-directory>',
  );
}
const directory = resolve(process.argv[3]);
const sourceFile = join(directory, 'deploy.db');
const targetFile = join(directory, 'requests.db');
const source = openDatabase(sourceFile, { fileMustExist: true, busyTimeoutMs: 5000, wal: true });
const target = openRequestsDb(targetFile);
const sourceId = ensureImportSource(source);
function sizes() {
  return Object.fromEntries(
    ['deploy.db', 'deploy.db-wal', 'requests.db', 'requests.db-wal'].map((name) => [
      name,
      existsSync(join(directory, name)) ? statSync(join(directory, name)).size : 0,
    ]),
  );
}
console.log(
  JSON.stringify({ directory, before: sizes(), resume: readImportState(target, sourceId) ?? null }),
);
const started = performance.now();
const times: number[] = [];
let rows = 0;
try {
  const worker = new Worker(new URL('../../server/requests-copy-worker.ts', import.meta.url), {
    workerData: { sourceFile, targetFile, sourceId },
  });
  worker.on('message', (batch: { rows: number; ms: number }) => {
    rows += batch.rows;
    times.push(batch.ms);
  });
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Copy worker exited ${code}`)),
    );
  });
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      copyMs: performance.now() - started,
      rows,
      batches: times.length,
      batchMs: {
        p50: times[Math.floor(times.length * 0.5)],
        p95: times[Math.floor(times.length * 0.95)],
        max: times.at(-1),
      },
      afterCopy: sizes(),
      state: readImportState(target, sourceId),
    }),
  );
  const vacuumStart = performance.now();
  const vacuum = compactLegacyRequests(source, target, sourceId);
  console.log(
    JSON.stringify({ vacuum, vacuumMs: performance.now() - vacuumStart, afterVacuum: sizes() }),
  );
} finally {
  target.close();
  source.close();
}

console.log(JSON.stringify({ afterClose: sizes() }));
