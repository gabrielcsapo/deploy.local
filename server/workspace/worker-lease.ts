import { db, now } from './store.ts';

/** Reserve the write lock before reading: competing starts must not upgrade a stale WAL snapshot. */
export function claimWorker(workerId: string) {
  db.transaction(() => {
    const prior = db.prepare('SELECT pid FROM worker WHERE id=?').get(workerId) as
      | { pid: number }
      | undefined;
    if (prior) {
      try {
        process.kill(prior.pid, 0);
        throw new Error(`Workspace service ${workerId} is already running`);
      } catch (error: any) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    db.prepare('INSERT OR REPLACE INTO worker VALUES(?,?,?)').run(workerId, process.pid, now());
  }).immediate();
}
