import { advanceAllPipelinePackages } from '../packages/pipelines.ts';
import { claimWorker } from './worker-lease.ts';
import { startSupervisorHeartbeat } from '../supervisor-heartbeat.ts';
import { db, now } from './store.ts';
import { reconcilePipelines, scanPipelineTriggers } from './pipelines.ts';
import { advancePipelineDeployments } from './pipeline-deployment.ts';
claimWorker('pipelines');
startSupervisorHeartbeat();
let busy = false;
let publishing = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    db.prepare("UPDATE worker SET heartbeat=? WHERE id='pipelines' AND pid=?").run(
      now(),
      process.pid,
    );
    reconcilePipelines();
    await scanPipelineTriggers();
    if (!publishing) {
      publishing = true;
      void advanceAllPipelinePackages()
        .then(() => advancePipelineDeployments())
        .catch((error) => console.error('Pipeline release:', error.message))
        .finally(() => {
          publishing = false;
        });
    }
  } catch (error: any) {
    console.error('Pipeline service:', error.message);
  } finally {
    busy = false;
  }
}, 1000);
const stop = () => {
  clearInterval(timer);
  db.prepare("DELETE FROM worker WHERE id='pipelines' AND pid=?").run(process.pid);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('Pipeline service ready');
