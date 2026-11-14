import type { TaskRunStarter } from '../contracts/task-run-starter.ts';

let provider: TaskRunStarter | undefined;

export function registerTaskRunStarter(value: TaskRunStarter) {
  provider = value;
}

export function requireTaskRunStarter(processName: string): TaskRunStarter {
  if (!provider) throw new Error(`TaskRunStarter is not wired in ${processName}`);
  return provider;
}
