import { parentPort, workerData } from 'node:worker_threads';
import { lockfileIndex } from './lockfiles.ts';
parentPort!.postMessage(lockfileIndex(workerData.file, workerData.text, true));
