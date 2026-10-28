import { workerUpdateReserved } from '../v2/update-admission.ts';
import { list } from './store.ts';
import type { Role } from '../../shared/v2/contracts.ts';

// Only the computer API writes these records; worker registration cannot grant roles.
export function workerRole(owner: string, workerId: string, role: Role) {
  if (workerUpdateReserved(owner, workerId)) return false;
  const record = list('v2-computer-roles', owner).find((row) => row.workerIds.includes(workerId));
  return record ? record.roles.includes(role) && !record.removed : true;
}
