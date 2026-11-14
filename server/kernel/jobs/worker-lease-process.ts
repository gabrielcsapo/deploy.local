/** Process identity is supplied by the worker owner, never inspected by the kernel. */
export type WorkerLease = {
  pid: number;
  executablePath: string;
  entryPath: string;
  workerRoot?: string;
  build: { version: string; commit?: string };
  started?: string;
};

type WorkerLeaseProcess = {
  workerLease(): WorkerLease;
  stopStaleWorker(prior: WorkerLease | number, current: WorkerLease): void;
};
let adapter: WorkerLeaseProcess | undefined;

export function configureWorkerLeaseProcess(value: WorkerLeaseProcess) {
  adapter = value;
}

export function requireWorkerLeaseProcess() {
  if (!adapter) throw new Error('Worker lease process adapter not registered');
  return adapter;
}

export const workerLease = (): WorkerLease => requireWorkerLeaseProcess().workerLease();
export const stopStaleWorker = (prior: WorkerLease | number, current: WorkerLease) =>
  requireWorkerLeaseProcess().stopStaleWorker(prior, current);
