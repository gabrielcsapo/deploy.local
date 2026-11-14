import { namedDatabase } from '../db/named-store.ts';
import { list, save } from '../db/records.ts';

const now = () => new Date().toISOString();
import { stopStaleWorker, workerLease } from './worker-lease-process.ts';

export function claimWorker(workerId: string) {
  const db = namedDatabase('workspace');
  const read = () =>
    db.prepare('SELECT pid FROM worker WHERE id=?').get(workerId) as { pid: number } | undefined;
  const lease = workerLease();
  for (;;) {
    const prior = read();
    if (prior) {
      const metadata = list('worker-lease', 'system').find((row) => row.id === workerId);
      // Let the old worker finish its own SQLite writes during graceful shutdown.
      stopStaleWorker(metadata?.pid === prior.pid ? metadata : prior.pid, lease);
    }
    // Reserve the writer before re-reading; competing starts cannot upgrade a stale WAL
    // snapshot. Retry if another contender claimed the lease while the old worker stopped.
    const claimed = db
      .transaction(() => {
        if (read()?.pid !== prior?.pid) return false;
        save('worker-lease', 'system', { id: workerId, ...lease });
        db.prepare('INSERT OR REPLACE INTO worker VALUES(?,?,?)').run(workerId, process.pid, now());
        return true;
      })
      .immediate();
    if (claimed) return;
  }
}
