import { advanceAllPipelinePackages } from '../packages/pipelines.ts';
import { claimWorker } from './worker-lease.ts';
import { startSupervisorHeartbeat } from '../supervisor-heartbeat.ts';
import { startServiceLoop } from '../kernel/jobs/service-loop.ts';
import { db, now } from './store.ts';
import { reconcilePipelines, scanPipelineTriggers } from './pipelines.ts';
import { advancePipelineDeployments } from './pipeline-deployment.ts';
claimWorker('pipelines');
startSupervisorHeartbeat();
let publishing = false;
const loop = startServiceLoop({
  beat: () =>
    db
      .prepare("UPDATE worker SET heartbeat=? WHERE id='pipelines' AND pid=?")
      .run(now(), process.pid),
  pass: async () => {
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
  },
  onError: (error) => console.error('Pipeline service:', (error as Error).message),
});
const stop = () => {
  loop.stop();
  db.prepare("DELETE FROM worker WHERE id='pipelines' AND pid=?").run(process.pid);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('Pipeline service ready');
