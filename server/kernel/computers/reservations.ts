import { list } from '../db/records.ts';

const kind = 'v2-update-reservation';
export function updateReservation(nodeId: string) {
  return list(kind, 'system').find((row) => row.id === nodeId);
}
export function workerUpdateReserved(owner: string, workerId: string) {
  return list(kind, 'system').some((row) =>
    row.workers.some(
      (worker: { owner: string; id: string }) => worker.owner === owner && worker.id === workerId,
    ),
  );
}
