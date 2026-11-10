import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

if (
  process.argv.slice(2).join(' ') !== '--apply --server-stopped' ||
  !process.env.DEPLOY_DATA_DIR
) {
  throw new Error(
    'Stop the server and automatic restarts first. Usage: DEPLOY_DATA_DIR=/path node scripts/convert-workspace-database.ts --apply --server-stopped',
  );
}
const bundled = new URL('../dist/workspace-vacuum-worker.js', import.meta.url);
const worker = new Worker(
  existsSync(bundled) ? bundled : new URL('../server/workspace-vacuum-worker.ts', import.meta.url),
  {
    workerData: { file: resolve(process.env.DEPLOY_DATA_DIR, 'workspace', 'workspace.db') },
  },
);
worker.on('message', (result) => {
  console.log(JSON.stringify(result));
  if (result.error) process.exitCode = 1;
});
worker.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
worker.on('exit', (code) => {
  if (code) process.exitCode = 1;
});
