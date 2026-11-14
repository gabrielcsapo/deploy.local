import { computerView } from './computer-view.ts';
import {
  computerPreferences as getComputerRolePreferences,
  computerNode as getNode,
  computerNodesConfigured,
} from './nodes.ts';
import type { ComputerRoleId, Role } from './nodes.ts';
import { workerUpdateReserved } from './reservations.ts';
import { namedDatabase } from '../db/named-store.ts';
import { list } from '../db/records.ts';

// Computers has two role switches: the per-computer preferences and the v2 computer records.
// A role is on only when neither turns it off, whichever API a caller checks through.
const v2Roles: Partial<Record<ComputerRoleId, Role>> = {
  tasks: 'take-tasks',
  computer: 'use-screen',
};
const preferenceRoles: Partial<Record<Role, ComputerRoleId>> = {
  'take-tasks': 'tasks',
  'use-screen': 'computer',
};

// Passive worker inventory may lag two seconds; explicit policy/inventory writes invalidate.
export const WORKER_ROLE_CADENCE_MS = 2_000;
const inventory = computerView(
  (owner: string) => ({
    managed: list('managed-worker', owner),
    workers: list('worker', owner),
    roles: list('v2-computer-roles', owner),
  }),
  WORKER_ROLE_CADENCE_MS,
);

export function workerComputerId(owner: string, workerId: string) {
  if (workerId.startsWith('node-worker-')) {
    const nodeId = workerId.slice('node-worker-'.length);
    if (getNode(nodeId)) return nodeId;
  }
  if (workerId === 'local' || inventory.read(owner).managed.some((w) => w.id === workerId))
    return 'coordinator';
  const nodeId = inventory.read(owner).workers.find((w) => w.id === workerId)?.nodeId;
  if (nodeId && getNode(nodeId)) return nodeId;
  return workerId;
}
function preferred(owner: string, workerId: string, role: ComputerRoleId) {
  return getComputerRolePreferences(workerComputerId(owner, workerId))[role] !== false;
}
// Only the computer API writes these records; worker registration cannot grant roles.
function recorded(owner: string, workerId: string, role: Role) {
  const record = inventory.read(owner).roles.find((row) => row.workerIds.includes(workerId));
  return record ? record.roles.includes(role) && !record.removed : true;
}
export function workerRoleEnabled(owner: string, workerId: string, role: ComputerRoleId) {
  if (!workerAvailable(owner, workerId)) return false;
  const v2Role = v2Roles[role];
  return preferred(owner, workerId, role) && (!v2Role || recorded(owner, workerId, v2Role));
}
export function workerRole(owner: string, workerId: string, role: Role) {
  if (!workerAvailable(owner, workerId)) return false;
  const preference = preferenceRoles[role];
  return recorded(owner, workerId, role) && (!preference || preferred(owner, workerId, preference));
}
export function assertWorkerRole(owner: string, workerId: string, role: ComputerRoleId) {
  if (!workerRoleEnabled(owner, workerId, role))
    throw new Error(`The ${role} role is off on this computer. Turn it on in Computers to use it.`);
}

/** Shared update exclusion; terminal permission remains its own explicit grant. */
export function workerAvailable(owner: string, workerId: string) {
  return computerPolicyConfigured() && !workerUpdateReserved(owner, workerId);
}

/** A missing owning-store registration is never permission to run work. */
export function computerPolicyConfigured() {
  if (!computerNodesConfigured()) return false;
  try {
    return namedDatabase('workspace').open;
  } catch {
    return false;
  }
}

/** Raw settings for product projection; presentation and all writers remain in the feature. */
export function computerRoleRecords(owner: string) {
  return list('v2-computer-roles', owner);
}

/** Node-level admission, retaining every caller's existing readiness/capability gate. */
export function computerRole(owner: string, computerId: string, role: Role) {
  if (!computerPolicyConfigured()) return false;
  if (list('v2-update-reservation', 'system').some((row) => row.id === computerId)) return false;
  const preference = role === 'run-apps' ? 'deploy' : preferenceRoles[role];
  if (preference && getComputerRolePreferences(computerId)[preference] === false) return false;
  const record = computerRoleRecords(owner).find((row) => row.id === computerId);
  return record ? record.roles.includes(role) && !record.removed : true;
}

/** Engine admission has no owner: any explicit owner denial on this fleet node wins. */
export function deployRoleEnabled(computerId: string) {
  if (!computerPolicyConfigured()) return false;
  if (getComputerRolePreferences(computerId).deploy === false) return false;
  if (list('v2-update-reservation', 'system').some((row) => row.id === computerId)) return false;
  const rows = namedDatabase('workspace')
    .prepare("SELECT data FROM records WHERE kind='v2-computer-roles' AND id=?")
    .all(computerId) as { data: string }[];
  return rows.every(({ data }) => {
    const record = JSON.parse(data);
    return !record.removed && record.roles.includes('run-apps');
  });
}
export function assertDeployRole(id: string) {
  if (!deployRoleEnabled(id))
    throw new Error(
      'The deploy role is off on this computer. Turn it on in Computers before deploying here.',
    );
}
