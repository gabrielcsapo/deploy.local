import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  nodeCapabilities,
  parseNodeCapabilities,
  type NodeCapabilities,
} from './node-permissions.ts';
import { controlPaused } from './node-control.ts';

export type NodeStatus = {
  enrolled: boolean;
  coordinatorUrl: string | null;
  workerId: string | null;
  workerName: string;
  online: boolean;
  runningTaskCount: number | null;
  capabilities: NodeCapabilities;
};
export function nodeStatusPath(env = process.env, home = homedir()) {
  return (
    env.DEPLOY_NODE_STATUS_PATH ||
    join(env.XDG_STATE_HOME || join(home, '.local/state'), 'deploy/node-status.json')
  );
}
export function readNodeSnapshot(path = nodeStatusPath()) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
let snapshotWarning = false;
const lastSnapshot = new Map<string, { body: string; at: number }>();
/** Workers tick every second; rewrite only on change, or every 5s so readers (offline after 10s) see it fresh. */
export function writeNodeSnapshot(status: NodeStatus, path = nodeStatusPath(), now = Date.now()) {
  const body = JSON.stringify(status);
  const last = lastSnapshot.get(path);
  if (last && last.body === body && now - last.at < 5000) return true;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify({ ...status, reportedAt: now }), {
      mode: 0o600,
    });
    renameSync(temporary, path);
    lastSnapshot.set(path, { body, at: now });
    return true;
  } catch {
    if (!snapshotWarning)
      console.error(
        'Could not write local node status; the worker continues. Check DEPLOY_NODE_STATUS_PATH.',
      );
    snapshotWarning = true;
    return false;
  }
}
/** No heartbeat request here: a status probe must never make a stopped worker appear online. */
export async function readNodeStatus({
  config = null,
  snapshot = readNodeSnapshot(),
  helper,
  paused = controlPaused(),
  platform = process.platform,
  now = Date.now(),
}: {
  config?: { coordinatorUrl: string; workerId?: string; name?: string } | null;
  snapshot?: any;
  helper?: () => Promise<any>;
  paused?: boolean;
  platform?: string;
  now?: number;
} = {}): Promise<NodeStatus> {
  const matches =
    snapshot &&
    (!config?.workerId || snapshot.workerId === config.workerId) &&
    (!config?.coordinatorUrl || snapshot.coordinatorUrl === config.coordinatorUrl);
  const age = matches ? now - snapshot.reportedAt : Infinity;
  const online = !!matches && age >= 0 && age < 10000 && snapshot.online === true;
  let capabilities = online ? parseNodeCapabilities(snapshot.capabilities) : undefined;
  if (!capabilities) {
    let desktop;
    try {
      desktop = await helper?.();
    } catch {
      /* missing helper is represented below */
    }
    capabilities = nodeCapabilities(
      {
        worker: {
          id: config?.workerId || '',
          name: config?.name || hostname(),
          platform,
          status: online ? 'online' : 'offline',
        },
        managed: false,
        targets: desktop ? [{ id: 'desktop', kind: 'computer', desktopStatus: desktop }] : [],
        fresh: !!desktop,
        browserProjects: [],
      },
      paused,
    );
  }
  capabilities = {
    ...capabilities,
    controlPaused: nodeCapabilities(
      {
        worker: { id: '', name: '', platform, status: '' },
        managed: false,
        targets: [],
        fresh: false,
        browserProjects: [],
      },
      paused,
    ).controlPaused,
  };
  return {
    enrolled: !!config || !!(matches && snapshot.enrolled),
    coordinatorUrl: config?.coordinatorUrl || (matches ? snapshot.coordinatorUrl : null),
    workerId: config?.workerId || (matches ? snapshot.workerId : null),
    workerName: config?.name || (matches ? snapshot.workerName : hostname()),
    online,
    runningTaskCount:
      online && Number.isInteger(snapshot.runningTaskCount) ? snapshot.runningTaskCount : null,
    capabilities,
  };
}
