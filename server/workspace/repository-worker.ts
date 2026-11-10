import { sweepCheckpointRefs } from './checkpoint-retention.ts';
import { claimWorker } from './worker-lease.ts';
import { startSupervisorHeartbeat } from '../supervisor-heartbeat.ts';
import { db, now } from './store.ts';
import { RepositoryRunner } from './repository-runner.ts';
import { queueDueSyncs } from './repositories.ts';
import { closeTasksForMergedPulls } from './project-collaboration.ts';

// Git storage service only. Never starts agents, checks, source hooks or project commands.
claimWorker('repositories');
startSupervisorHeartbeat();
const runner = new RepositoryRunner();
runner.recover();
// Merges run here, so this service also closes tasks for pull requests merged before
// tasks closed on merge.
closeTasksForMergedPulls();
sweepCheckpointRefs();
const checkpointSweep = setInterval(sweepCheckpointRefs, 60 * 60 * 1000);
checkpointSweep.unref();
// Two-way remotes sync every five minutes, and soon after a merge.
const syncSchedule = setInterval(() => {
  try {
    queueDueSyncs();
  } catch (error: any) {
    console.error('Repository sync schedule:', error.message);
  }
}, 15 * 1000);
syncSchedule.unref();
const timer = setInterval(() => {
  db.prepare('UPDATE worker SET heartbeat=? WHERE id=? AND pid=?').run(
    now(),
    'repositories',
    process.pid,
  );
  void runner.tick().catch((error) => console.error('Repository service:', error.message));
}, 250);
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  clearInterval(checkpointSweep);
  clearInterval(syncSchedule);
  runner.stop();
  db.prepare('DELETE FROM worker WHERE id=? AND pid=?').run('repositories', process.pid);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
console.log('Repository service ready');
