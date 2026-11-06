import { parentPort, workerData } from 'node:worker_threads';
import { lockfileVersions, lockfileLinks } from './lockfiles.ts';
try {
  parentPort!.postMessage({
    versions: lockfileVersions(workerData.file, workerData.text, workerData.name),
    links: lockfileLinks(workerData.file, workerData.text, workerData.name),
  });
} catch {
  parentPort!.postMessage({ versions: [], links: [] });
}
