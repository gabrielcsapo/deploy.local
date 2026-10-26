import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'deploy-worker-repository-access-'));
process.env.DEPLOY_DATA_DIR = data;
const { workerMayReadRepository } = await import('./api.ts');
const { save } = await import('./store.ts');
after(() => rmSync(data, { recursive: true, force: true }));

const owner = 'alice';
save('task', owner, { id: 'task-a', projectId: 'project-a', title: 'A' });
save('task', owner, { id: 'task-b', projectId: 'project-b', title: 'B' });

test('a running checkpoint job lets its worker read the task repository', () => {
  // Job records carry the task, not the project: the check must resolve it through the task.
  save('job', owner, { id: 'job-1', taskId: 'task-a', workerId: 'linux', status: 'running' });
  assert.equal(workerMayReadRepository(owner, 'linux', 'project-a'), true);
  assert.equal(workerMayReadRepository(owner, 'linux', 'project-b'), false);
  assert.equal(workerMayReadRepository(owner, 'mac', 'project-a'), false);
});

test('finished jobs, other workers and missing tasks grant nothing', () => {
  save('job', owner, { id: 'job-2', taskId: 'task-b', workerId: 'mac', status: 'succeeded' });
  save('job', owner, { id: 'job-3', taskId: 'gone', workerId: 'mac', status: 'running' });
  assert.equal(workerMayReadRepository(owner, 'mac', 'project-b'), false);
});

test('a running agent run still grants its task repository', () => {
  save('run', owner, { id: 'run-1', taskId: 'task-b', workerId: 'mac', status: 'running' });
  assert.equal(workerMayReadRepository(owner, 'mac', 'project-b'), true);
  assert.equal(workerMayReadRepository(owner, 'mac', 'project-a'), false);
});
