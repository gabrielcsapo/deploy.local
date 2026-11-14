import { startRun } from '../workspace/service.ts';
import { registerTaskRunStarter } from '../workspace/task-run-starter-port.ts';

export function wireTaskRunStarter() {
  registerTaskRunStarter(startRun);
}
