import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
try {
  const index = JSON.parse(await readFile(workerData.path, 'utf8'));
  const version = workerData.version;
  parentPort.postMessage({
    index: version ? (Object.hasOwn(index, version) ? { [version]: index[version] } : {}) : index,
  });
} catch {
  parentPort.postMessage({ error: 'Package index reader failed' });
}
