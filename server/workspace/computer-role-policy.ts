import { getComputerRolePreferences, getNode } from '../store.ts';
import type { ComputerRoleId } from '../computer-roles.ts';
import { list } from './store.ts';

export function workerComputerId(owner: string, workerId: string) {
  if (workerId.startsWith('node-worker-')) {
    const nodeId = workerId.slice('node-worker-'.length);
    if (getNode(nodeId)) return nodeId;
  }
  if (workerId === 'local' || list('managed-worker', owner).some((w) => w.id === workerId))
    return 'coordinator';
  return workerId;
}
export function workerRoleEnabled(owner: string, workerId: string, role: ComputerRoleId) {
  return getComputerRolePreferences(workerComputerId(owner, workerId))[role] !== false;
}
export function assertWorkerRole(owner: string, workerId: string, role: ComputerRoleId) {
  if (!workerRoleEnabled(owner, workerId, role))
    throw new Error(`The ${role} role is off on this computer. Turn it on in Computers to use it.`);
}
