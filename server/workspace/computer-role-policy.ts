import { getComputerRolePreferences, getNode } from '../store.ts';
import type { ComputerRoleId } from '../computer-roles.ts';
import type { Role } from '../../shared/v2/contracts.ts';
import { workerUpdateReserved } from '../v2/update-admission.ts';
import { list } from './store.ts';

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

export function workerComputerId(owner: string, workerId: string) {
  if (workerId.startsWith('node-worker-')) {
    const nodeId = workerId.slice('node-worker-'.length);
    if (getNode(nodeId)) return nodeId;
  }
  if (workerId === 'local' || list('managed-worker', owner).some((w) => w.id === workerId))
    return 'coordinator';
  return workerId;
}
function preferred(owner: string, workerId: string, role: ComputerRoleId) {
  return getComputerRolePreferences(workerComputerId(owner, workerId))[role] !== false;
}
// Only the computer API writes these records; worker registration cannot grant roles.
function recorded(owner: string, workerId: string, role: Role) {
  if (workerUpdateReserved(owner, workerId)) return false;
  const record = list('v2-computer-roles', owner).find((row) => row.workerIds.includes(workerId));
  return record ? record.roles.includes(role) && !record.removed : true;
}
export function workerRoleEnabled(owner: string, workerId: string, role: ComputerRoleId) {
  const v2Role = v2Roles[role];
  return preferred(owner, workerId, role) && (!v2Role || recorded(owner, workerId, v2Role));
}
export function workerRole(owner: string, workerId: string, role: Role) {
  const preference = preferenceRoles[role];
  return recorded(owner, workerId, role) && (!preference || preferred(owner, workerId, preference));
}
export function assertWorkerRole(owner: string, workerId: string, role: ComputerRoleId) {
  if (!workerRoleEnabled(owner, workerId, role))
    throw new Error(`The ${role} role is off on this computer. Turn it on in Computers to use it.`);
}
