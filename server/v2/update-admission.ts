import { db, list, save } from '../workspace/store.ts';

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
export function withUpdateAdmission<T>(action: () => T): T {
  return db.transaction(action).immediate();
}
/** The same SQLite write lock covers task claims and the idle check plus reservation. */
export function reserveComputerUpdate(nodeId: string, jobId: string) {
  if (updateReservation(nodeId)) return false;
  const workers: { owner: string; id: string }[] = [];
  for (const row of db
    .prepare("SELECT owner,data FROM records WHERE kind='v2-computer-roles'")
    .all() as { owner: string; data: string }[]) {
    const setting = JSON.parse(row.data);
    if (setting.id === nodeId)
      for (const id of setting.workerIds) workers.push({ owner: row.owner, id });
  }
  for (const worker of workers) {
    if (
      ['run', 'job', 'interactive-session'].some((kind) =>
        list(kind, worker.owner).some(
          (row) =>
            row.workerId === worker.id &&
            (kind === 'interactive-session'
              ? !['stopped', 'suspended'].includes(row.status)
              : ['starting', 'running', 'unknown'].includes(row.status)),
        ),
      )
    )
      return false;
  }
  save(kind, 'system', { id: nodeId, jobId, workers, at: Date.now() });
  return true;
}
export function releaseComputerUpdate(nodeId: string, jobId: string) {
  if (updateReservation(nodeId)?.jobId === jobId)
    db.prepare('DELETE FROM records WHERE kind=? AND owner=? AND id=?').run(kind, 'system', nodeId);
}

export function computerUpdateAllowed(payload: { releaseId: string; targetVersion: string }) {
  if (!list('v2-update-settings', 'system').some((row) => row.automatic === true)) return false;
  for (const row of db
    .prepare("SELECT owner,data FROM records WHERE kind='v2-project-current'")
    .all() as { owner: string; data: string }[]) {
    if (JSON.parse(row.data).releaseId !== payload.releaseId) continue;
    const record = list('v2-release', row.owner).find((record) => record.id === payload.releaseId);
    if (
      record?.release.state !== 'live' ||
      record.plan?.runtime?.kind !== 'coordinator-self-release'
    )
      continue;
    const receipt = list('v2-coordinator-activation', 'system').find(
      (receipt) => receipt.id === record.plan.runtime.id,
    );
    if (receipt?.state === 'activated' && receipt.version === payload.targetVersion) return true;
  }
  return false;
}
