import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-run-queue-'));
await import('../test-ports.ts');
const { save, get, list } = await import('./store.ts');
const { runQueue, taskQueue, moveQueuedRun, workerLoad } = await import('./run-queue.ts');
const { workerCommand } = await import('./protocol.ts');
const { stopRun } = await import('./service.ts');
function fixture() {
  const owner = randomUUID();
  for (const id of ['bazzite', 'mac', 'offline', 'other-agent'])
    save('worker', owner, {
      id,
      name: id,
      capabilities: [id === 'other-agent' ? 'claude' : 'codex'],
      heartbeat: id === 'offline' ? '2000-01-01' : new Date().toISOString(),
    });
  for (const [id, status] of [
    ['busy', 'running'],
    ['first', 'queued'],
    ['second', 'queued'],
  ]) {
    save('task', owner, {
      id,
      title: id === 'busy' ? 'Build bricks' : id,
      workerId: 'bazzite',
      status: 'running',
      revision: 1,
      workspaceStatus: 'ready',
    });
    save('run', owner, { id, taskId: id, status, workerId: 'bazzite', adapter: 'codex' });
  }
  return owner;
}
test('queued task snapshots expose the busy task and FIFO position, without changing stored lifecycle', () => {
  const owner = fixture();
  const first = taskQueue(owner, get('task', owner, 'first'));
  assert.equal(first.status, 'queued');
  assert.equal(get('task', owner, 'first').status, 'running');
  assert.equal(first.queue.reason, 'Waiting for bazzite — busy with Build bricks');
  assert.equal(first.queue.position, 1);
  assert.equal(first.queue.total, 2);
  assert.equal(runQueue(owner, get('run', owner, 'second'))?.position, 2);
  assert.deepEqual(workerLoad(owner, 'bazzite'), { activeTaskCount: 1, queuedTaskCount: 2 });
  assert.equal(runQueue(owner, get('run', owner, 'busy')), null);
});
test('queue follows worker claim order and distinguishes preparation, offline and interrupted blockers', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const owner = fixture();
  save('task', owner, { ...get('task', owner, 'first'), workspaceStatus: 'preparing' });
  assert.equal(runQueue(owner, get('run', owner, 'first'))?.position, null);
  assert.match(runQueue(owner, get('run', owner, 'first'))!.reason, /workspace preparation/);
  assert.equal(runQueue(owner, get('run', owner, 'second'))?.position, 1);
  save('run', owner, { ...get('run', owner, 'busy'), status: 'succeeded' });
  assert.equal(workerCommand(owner, '/workers/bazzite/poll', {}).run.id, 'second');
  save('run', owner, { ...get('run', owner, 'second'), status: 'unknown' });
  save('task', owner, { ...get('task', owner, 'first'), workspaceStatus: 'ready' });
  assert.match(runQueue(owner, get('run', owner, 'first'))!.reason, /resolving interrupted task/);
  save('worker', owner, { ...get('worker', owner, 'bazzite'), heartbeat: '2000-01-01' });
  t.mock.timers.tick(1000); // Passive liveness updates on the computer view cadence.
  assert.match(runQueue(owner, get('run', owner, 'first'))!.reason, /offline/);
});
test('only an unclaimed run moves to a fresh online compatible computer; old worker cannot claim it', () => {
  const owner = fixture();
  assert.deepEqual(runQueue(owner, get('run', owner, 'first'))?.alternatives, [
    { id: 'mac', name: 'mac', activeTaskCount: 0, queuedTaskCount: 0 },
  ]);
  assert.throws(
    () => moveQueuedRun(owner, 'first', { revision: 1, workerId: 'offline' }),
    /cannot move/,
  );
  const task = moveQueuedRun(owner, 'first', { revision: 1, workerId: 'mac' });
  assert.equal(task.workerId, 'mac');
  assert.equal(get('run', owner, 'first').workerId, 'mac');
  assert.throws(() => moveQueuedRun(owner, 'first', { revision: 1, workerId: 'bazzite' }));
  assert.equal(workerCommand(owner, '/workers/mac/poll', {}).run.id, 'first');
  assert.throws(
    () => moveQueuedRun(owner, 'first', { revision: 2, workerId: 'bazzite' }),
    /cannot move/,
  );
  assert.equal(workerCommand(owner, '/workers/bazzite/poll', {}).run.id, 'busy');
});
test('stopping queued work frees it immediately and never starts it later', () => {
  const owner = fixture();
  save('queued-message', owner, {
    id: 'first',
    taskId: 'first',
    content: 'Next',
    status: 'queued',
  });
  stopRun(owner, 'first', { revision: 1 });
  assert.equal(get('queued-message', owner, 'first').status, 'held');
  assert.equal(get('run', owner, 'first').status, 'interrupted');
  assert.equal(get('task', owner, 'first').status, 'review');
  assert.equal(taskQueue(owner, get('task', owner, 'first')).queue, null);
  assert.equal(runQueue(owner, get('run', owner, 'second'))?.total, 1);
  assert.equal(list('run', owner).filter((r) => r.status === 'queued').length, 1);
});

test('moving never abandons an existing task workspace', () => {
  const owner = fixture();
  save('run', owner, { id: 'previous', taskId: 'first', workerId: 'bazzite', status: 'succeeded' });
  const queue = runQueue(owner, get('run', owner, 'first'))!;
  assert.equal(queue.alternatives.length, 0);
  assert.match(queue.moveUnavailableReason!, /workspace transfer/);
  assert.throws(
    () => moveQueuedRun(owner, 'first', { revision: 1, workerId: 'mac' }),
    /cannot move/,
  );
});

test('workspace inventory and task detail both expose queued presentation', async (t) => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { workspaceApi } = await import('./api.ts');
  const owner = fixture();
  const server = createServer((req, res) => void workspaceApi(req, res, owner)).listen(
    0,
    '127.0.0.1',
  );
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const state = await (await fetch(origin + '/state')).json();
  assert.equal(state.tasks.find((task: any) => task.id === 'first').status, 'queued');
  // Lists read a task's latest run status, so a stopped run is not shown as finished.
  assert.equal(state.tasks.find((task: any) => task.id === 'first').runStatus, 'queued');
  assert.equal(state.runs.find((run: any) => run.id === 'second').queue.position, 2);
  assert.equal(state.workers.find((worker: any) => worker.id === 'bazzite').activeTaskCount, 1);
  const response = await fetch(origin + '/tasks/first');
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.task.status, 'queued');
  assert.equal(detail.task.queue.reason, 'Waiting for bazzite — busy with Build bricks');
});

test('shell work before the first agent run also pins the workspace', () => {
  const owner = fixture();
  save('message', owner, { id: 'shell', taskId: 'first', shell: { command: 'touch source' } });
  assert.equal(runQueue(owner, get('run', owner, 'first'))?.alternatives.length, 0);
});

test('alternatives carry worker load and put idle computers before busy computers', () => {
  const owner = fixture();
  for (const id of ['a-busy', 'z-idle', 'queued-only'])
    save('worker', owner, {
      id,
      name: id,
      capabilities: ['codex'],
      heartbeat: new Date().toISOString(),
    });
  for (const [id, workerId, status, taskId, stopRequested] of [
    ['active1', 'a-busy', 'running', 'same', false],
    ['active2', 'a-busy', 'unknown', 'same', false],
    ['waiting', 'a-busy', 'queued', 'waiting', false],
    ['cancelled', 'a-busy', 'queued', 'cancelled', true],
    ['queued', 'queued-only', 'queued', 'queued', false],
  ])
    save('run', owner, { id, workerId, status, taskId, stopRequested });
  const alternatives = runQueue(owner, get('run', owner, 'first'))!.alternatives;
  assert.deepEqual(
    alternatives.map((w) => w.id),
    ['mac', 'z-idle', 'queued-only', 'a-busy'],
  );
  for (const computer of alternatives)
    assert.deepEqual(
      { activeTaskCount: computer.activeTaskCount, queuedTaskCount: computer.queuedTaskCount },
      workerLoad(owner, computer.id),
    );
  assert.equal(alternatives.at(-1)!.activeTaskCount, 1);
  assert.equal(alternatives.at(-1)!.queuedTaskCount, 1);
});
