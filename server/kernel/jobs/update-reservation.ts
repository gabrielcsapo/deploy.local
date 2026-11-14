import { updateReservation } from '../computers/reservations.ts';
import { save, remove } from '../db/records.ts';

const kind = 'v2-update-reservation';

/** Admission owns the idle check and its surrounding SQLite write lock. */
export function saveComputerUpdateReservation(
  nodeId: string,
  jobId: string,
  workers: { owner: string; id: string }[],
) {
  save(kind, 'system', { id: nodeId, jobId, workers, at: Date.now() });
}

export function releaseComputerUpdate(nodeId: string, jobId: string) {
  if (updateReservation(nodeId)?.jobId === jobId) remove(kind, 'system', nodeId);
}
