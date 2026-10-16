import { claimWorker } from './worker-lease.ts';
import { db, now } from './store.ts';
import { RepositoryRunner } from './repository-runner.ts';

// Git storage service only. Never starts agents, checks, source hooks or project commands.
claimWorker('repositories');
const runner = new RepositoryRunner();
runner.recover();
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
  runner.stop();
  db.prepare('DELETE FROM worker WHERE id=? AND pid=?').run('repositories', process.pid);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
console.log('Repository service ready');
