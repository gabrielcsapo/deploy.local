import { list } from './store.ts';
import type { Role } from '../../shared/v2/contracts.ts';

// Only the computer API writes these records; worker registration cannot grant roles.
export function workerRole(owner: string, workerId: string, role: Role) {
  const record = list('v2-computer-roles', owner).find((row) => row.workerIds.includes(workerId));
  return record ? record.roles.includes(role) && !record.removed : true;
}
