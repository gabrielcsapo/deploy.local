import { cpus } from 'node:os';

export interface DeployLease {
  release(): void;
}

interface Waiter {
  name: string;
  resolve: (lease: DeployLease) => void;
  onPosition?: (position: number) => void;
}

const configured = Number.parseInt(process.env.DEPLOY_BUILD_CONCURRENCY || '', 10);
const MAX_CONCURRENT = Number.isFinite(configured) && configured > 0
  ? configured
  : Math.max(1, Math.floor(cpus().length / 2));
const activeApps = new Set<string>();
const queue: Waiter[] = [];

function dispatch() {
  let progressed = true;
  while (activeApps.size < MAX_CONCURRENT && progressed) {
    progressed = false;
    const index = queue.findIndex((waiter) => !activeApps.has(waiter.name));
    if (index === -1) break;
    const [waiter] = queue.splice(index, 1);
    activeApps.add(waiter.name);
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
  onPosition?: (position: number) => void,
): Promise<DeployLease> {
  return new Promise((resolve) => {
    queue.push({ name, resolve, onPosition });
    dispatch();
  });
}

export function getDeployAdmissionState() {
  return { active: activeApps.size, queued: queue.length, limit: MAX_CONCURRENT };
}
