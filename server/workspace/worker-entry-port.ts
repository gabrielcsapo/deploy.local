import type { WorkerEntry } from '../contracts/worker-entry.ts';

let provider: WorkerEntry | undefined;

export function registerWorkerEntry(value: WorkerEntry) {
  provider = value;
}

export function requireWorkerEntry(processName: string): WorkerEntry {
  if (!provider) throw new Error(`WorkerEntry is not wired in ${processName}`);
  return provider;
}
