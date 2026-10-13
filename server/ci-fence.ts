import type { Worker } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage<string | undefined>();
const mutations = new Map<string, number>();
let reservation: (application: string) => string | undefined = () => undefined;
let enter: (app: string) => string | undefined = () => undefined;
let leave: (id: string) => void = () => {};
let workerExited: (pid: number, thread: number) => void = () => {};
let busy: (app: string) => boolean = () => false;
export function configureCiFence(
  reader: typeof reservation,
  begin: typeof enter,
  end: typeof leave,
  active: typeof busy,
  cleanup: typeof workerExited,
) {
  reservation = reader;
  enter = begin;
  leave = end;
  busy = active;
  workerExited = cleanup;
}
export function assertCiMutation(application: string) {
  const id = reservation(application);
  if (id && id !== context.getStore())
    throw Object.assign(new Error('Application has a durable CI release reservation'), {
      status: 409,
    });
}
export function ciMutationActive(application: string) {
  return busy(application) || (mutations.get(application) || 0) > 0;
}
export function withCiMutation<T>(id: string | undefined, action: () => T): T {
  return context.run(id, action);
}
export async function withApplicationMutation<T>(
  application: string,
  action: () => Promise<T>,
): Promise<T> {
  assertCiMutation(application);
  if (context.getStore()) return action();
  const lease = enter(application);
  mutations.set(application, (mutations.get(application) || 0) + 1);
  try {
    return await action();
  } finally {
    if (lease) leave(lease);
    const count = (mutations.get(application) || 1) - 1;
    if (count) mutations.set(application, count);
    else mutations.delete(application);
  }
}

// Only the parent observing the actual exit event may release a worker lease.
export function trackCiWorker(worker: Worker) {
  const thread = worker.threadId;
  worker.once('exit', () => workerExited(process.pid, thread));
  return worker;
}
