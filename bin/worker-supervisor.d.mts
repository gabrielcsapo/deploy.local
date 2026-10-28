import type { installWorkerBuild } from './worker-update.mjs';
export function workerUpdateReceipt(root: string): any;
export function superviseWorker(input: {
  executable: string;
  args?: string[];
  root: string;
  version: string;
  stableMs?: number;
  startupMs?: number;
  install?: typeof installWorkerBuild;
  download?: (request: any) => Promise<Buffer>;
  signal?: AbortSignal;
}): Promise<void>;
