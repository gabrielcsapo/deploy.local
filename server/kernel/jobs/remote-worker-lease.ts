import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  requireWorkerLeaseProcess,
  stopStaleWorker,
  workerLease,
  type WorkerLease,
} from './worker-lease-process.ts';

/** Serialize read/stop/replace across app starts, including a crash during acquisition. */
export function claimRemoteWorker(
  path: string,
  lease: WorkerLease = { ...workerLease(), workerRoot: dirname(resolve(path)) },
) {
  requireWorkerLeaseProcess();
  const guard = path + '.claim';
  const owner = guard + '/pid';
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      mkdirSync(guard, { mode: 0o700 });
      break;
    } catch (claimError: any) {
      if (claimError.code !== 'EEXIST') throw claimError;
      try {
        const pid = Number(readFileSync(owner, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 1) {
          // A contender can observe the directory before its owner file is published.
          if (Date.now() - statSync(guard).mtimeMs > 5000)
            throw new Error('Invalid lease guard', { cause: claimError });
          if (Date.now() >= deadline)
            throw new Error('Worker lease acquisition is busy', { cause: claimError });
          pause();
          continue;
        }
        try {
          process.kill(pid, 0);
        } catch (probeError: any) {
          if (probeError.code === 'ESRCH') {
            rmSync(guard, { recursive: true });
            continue;
          }
          throw probeError;
        }
      } catch (readError: any) {
        if (readError.code !== 'ENOENT') throw readError;
        try {
          if (Date.now() - statSync(guard).mtimeMs > 5000) {
            rmSync(guard, { recursive: true, force: true });
            continue;
          }
        } catch (statError: any) {
          if (statError.code !== 'ENOENT') throw statError;
          continue; // The previous owner released the guard while it was inspected.
        }
      }
      if (Date.now() >= deadline)
        throw new Error('Worker lease acquisition is busy', { cause: claimError });
      pause();
    }
  }
  try {
    writeFileSync(owner + '.tmp', String(process.pid), { mode: 0o600 });
    renameSync(owner + '.tmp', owner);
    let prior: WorkerLease | number | undefined;
    try {
      prior = JSON.parse(readFileSync(path, 'utf8'));
    } catch (claimError: any) {
      if (claimError.code !== 'ENOENT') throw claimError;
    }
    if (prior !== undefined) stopStaleWorker(prior, lease);
    const temporary = path + '.tmp';
    writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
  return () => {
    try {
      if (readFileSync(path, 'utf8') === JSON.stringify(lease)) rmSync(path);
    } catch (claimError: any) {
      if (claimError.code !== 'ENOENT') throw claimError;
    }
  };
}
