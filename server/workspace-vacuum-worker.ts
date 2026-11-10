import { parentPort, workerData } from 'node:worker_threads';
import { convertWorkspaceDatabase } from './workspace/database-conversion.ts';
try {
  parentPort!.postMessage(convertWorkspaceDatabase(workerData.file));
} catch (error) {
  parentPort!.postMessage({ error: String(error) });
}
