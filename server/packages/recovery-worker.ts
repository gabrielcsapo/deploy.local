import { parentPort, workerData } from 'node:worker_threads';
import {
  writeRecoveryPayload,
  verifyRecoveryBundle,
  restoreRecoveryBundle,
  rehearseRecoveryBundle,
} from '../recovery-bundle.ts';
try {
  const result =
    workerData.action === 'verify'
      ? verifyRecoveryBundle(workerData.input)
      : workerData.action === 'restore'
        ? restoreRecoveryBundle(workerData.input)
        : workerData.action === 'rehearse'
          ? rehearseRecoveryBundle(workerData.input)
          : await writeRecoveryPayload(workerData);
  parentPort!.postMessage(result);
} catch (error: any) {
  parentPort!.postMessage({ error: error.message });
}
