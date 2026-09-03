import { cpus } from 'node:os';

export interface DeployLease {
  release(): void;
}

interface Waiter {
  name: string;
  username: string;
  resolve: (lease: DeployLease) => void;
  reject: (error: Error) => void;
  onPosition?: (position: number) => void;
}

const configured = Number.parseInt(process.env.DEPLOY_BUILD_CONCURRENCY || '', 10);
const MAX_CONCURRENT =
  Number.isFinite(configured) && configured > 0
    ? configured
    : Math.max(1, Math.floor(cpus().length / 2));
const activeApps = new Map<string, string>();
const queue: Waiter[] = [];

function dispatch() {
  let progressed = true;
  while (activeApps.size < MAX_CONCURRENT && progressed) {
    progressed = false;
    const index = queue.findIndex((waiter) => !activeApps.has(waiter.name));
    if (index === -1) break;
    const [waiter] = queue.splice(index, 1);
    activeApps.set(waiter.name, waiter.username);
    progressed = true;
    let released = false;
    waiter.resolve({
      release() {
        if (released) return;
        released = true;
        activeApps.delete(waiter.name);
        dispatch();
      },
    });
  }
  queue.forEach((waiter, index) => waiter.onPosition?.(index + 1));
}

export function acquireDeploySlot(
  name: string,
  username = '',
  onPosition?: (position: number) => void,
): Promise<DeployLease> {
  return new Promise((resolve, reject) => {
    queue.push({ name, username, resolve, reject, onPosition });
    dispatch();
  });
}

export function cancelQueuedDeploy(name: string, username: string): boolean {
  const index = queue.findIndex((waiter) => waiter.name === name && waiter.username === username);
  if (index === -1) return false;
  const [waiter] = queue.splice(index, 1);
  waiter.reject(new Error('Deploy cancelled while queued'));
  dispatch();
  return true;
}

export function getDeployAdmissionState(username?: string) {
  const active = [...activeApps].filter(([, owner]) => !username || owner === username);
  const queued = queue.filter((waiter) => !username || waiter.username === username);
  return {
    active: active.length,
    queued: queued.length,
    limit: MAX_CONCURRENT,
    activeDeployments: active.map(([name]) => name),
    queue: queued.map((waiter) => ({
      name: waiter.name,
      position: queue.indexOf(waiter) + 1,
    })),
  };
}
