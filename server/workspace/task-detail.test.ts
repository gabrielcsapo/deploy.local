import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-task-detail-test-'));
const { save, event, id, now, TASK_DETAIL_EVENT_BYTES, TASK_DETAIL_EVENT_LIMIT } =
  await import('./store.ts');
const { ACTIVITY_DETAIL_CHARS, ACTIVITY_OUTPUT_CHARS, ACTIVITY_TEXT_BUDGET } =
  await import('./activity.ts');
const { TASK_DETAIL_JOB_OUTPUT_CHARS, TASK_DETAIL_ACTIVE_JOB_OUTPUT_CHARS } =
  await import('./coordination.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { workspaceApi } = await import('./api.ts');

const owner = 'detail-owner';
const server = createServer((req, res) => void workspaceApi(req, res, owner));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => server.close());

async function read(path: string) {
  const response = await fetch(base + path);
  const text = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) };
}

// The shape behind the 6.5 MB task detail: thousands of tool events with large
// outputs, dozens of jobs with long logs.
const project = createProject(owner, { name: 'Heavy' });
const task = createTask(owner, { projectId: project.id, title: 'Long task' });
const run = save('run', owner, {
  id: id(),
  taskId: task.id,
  status: 'succeeded',
  createdAt: now(),
  updatedAt: now(),
});
const longOutput = 'line of tool output\n'.repeat(1_500); // 30,000 chars
for (let n = 0; n < 1_200; n++) {
  const item = {
    id: 'item-' + n,
    type: 'command_execution',
    command: 'echo ' + 'arg '.repeat(1_000) + n,
    aggregated_output: longOutput + n,
    exit_code: 0,
  };
  event(owner, task.id, run.id, 'item.started', { item });
  event(owner, task.id, run.id, 'item.completed', { item });
}
event(owner, task.id, run.id, 'item.updated', { blob: 'z'.repeat(100_000) });
const jobOutput = 'build step output\n'.repeat(3_500).slice(-64_000);
for (let n = 0; n < 68; n++)
  save('job', owner, {
    id: 'job-' + n,
    taskId: task.id,
    runId: run.id,
    digest: 'abc1234',
    workerId: 'local',
    command: 'make test',
    status: n === 67 ? 'running' : 'succeeded',
    output: jobOutput + 'job ' + n,
    truncated: true,
    createdAt: now(),
    updatedAt: now(),
  });

test('task detail stays bounded for a long task', async (t) => {
  const detail = await read('/tasks/' + task.id);
  t.diagnostic(`task detail: ${detail.bytes} bytes`);
  assert.equal(detail.status, 200);
  assert.ok(detail.bytes < 1_600_000, `task detail was ${detail.bytes} bytes`);

  const events = JSON.stringify(detail.body.events).length;
  assert.ok(detail.body.events.length <= TASK_DETAIL_EVENT_LIMIT);
  assert.ok(events < TASK_DETAIL_EVENT_BYTES * 1.2, `events were ${events} bytes`);
  assert.equal(detail.body.eventsTruncated, true);
  assert.equal(detail.body.eventsBefore, detail.body.events[0].cursor);
  // Newest events are the ones kept, in cursor order; an oversized payload is summarized.
  const cursors = detail.body.events.map((row: any) => row.cursor);
  assert.deepEqual(
    cursors,
    [...cursors].sort((a, b) => a - b),
  );
  assert.equal(detail.body.events.at(-1).cursor, detail.body.cursor);
  assert.deepEqual(detail.body.events.at(-1).payload, {
    omitted: true,
    bytes: JSON.stringify({ blob: 'z'.repeat(100_000) }).length,
  });

  const items = detail.body.activity[0].items;
  assert.equal(items.length, 1_200, 'every action is still listed');
  const newest = items.at(-1);
  assert.equal(newest.detail.length, ACTIVITY_DETAIL_CHARS);
  assert.equal(newest.detailTruncated, true);
  assert.equal(newest.output.length, ACTIVITY_OUTPUT_CHARS);
  assert.ok(newest.output.endsWith('1199'), 'output keeps its tail');
  assert.equal(newest.outputTruncated, true);
  assert.equal(items[0].output, '');
  assert.equal(items[0].outputTruncated, true);
  const text = items.reduce(
    (n: number, item: any) => n + item.detail.length + item.output.length,
    0,
  );
  assert.ok(text < ACTIVITY_TEXT_BUDGET + 200 * items.length + ACTIVITY_OUTPUT_CHARS * 2);
  assert.equal(detail.body.activity[0].summary, 'Ran 1200 commands');

  assert.equal(detail.body.jobs.length, 68);
  for (const job of detail.body.jobs) {
    const limit =
      job.status === 'running' ? TASK_DETAIL_ACTIVE_JOB_OUTPUT_CHARS : TASK_DETAIL_JOB_OUTPUT_CHARS;
    assert.equal(job.output.length, limit);
    assert.equal(job.outputTruncated, true);
    assert.ok(job.output.endsWith(job.id.replace('job-', 'job ')), 'job output keeps its tail');
  }
});

test('older raw events page behind the task detail', async () => {
  const detail = await read('/tasks/' + task.id);
  const older = await read(`/events?taskId=${task.id}&before=${detail.body.eventsBefore}&limit=50`);
  assert.equal(older.status, 200);
  assert.equal(older.body.events.length, 50);
  assert.equal(older.body.events.at(-1).cursor, detail.body.eventsBefore - 1);
  assert.equal(older.body.before, older.body.events[0].cursor);
  assert.ok(older.body.events.every((row: any) => row.taskId === task.id));

  assert.equal((await read(`/events?before=10`)).status, 400);
  assert.equal((await read(`/events?taskId=${task.id}&before=10&limit=0`)).status, 400);
});

test('a short task detail is unchanged', async () => {
  const small = createTask(owner, { projectId: project.id, title: 'Short task' });
  const smallRun = save('run', owner, {
    id: id(),
    taskId: small.id,
    status: 'succeeded',
    createdAt: now(),
    updatedAt: now(),
  });
  const item = { id: 'one', type: 'command_execution', command: 'ls', aggregated_output: 'a\nb' };
  event(owner, small.id, smallRun.id, 'item.completed', { item });
  save('job', owner, {
    id: 'small-job',
    taskId: small.id,
    runId: smallRun.id,
    digest: 'abc1234',
    command: 'ls',
    status: 'succeeded',
    output: 'done',
    truncated: false,
    createdAt: now(),
    updatedAt: now(),
  });
  const detail = await read('/tasks/' + small.id);
  assert.equal(detail.body.eventsTruncated, false);
  assert.equal(detail.body.eventsBefore, null);
  assert.deepEqual(detail.body.events.at(-1).payload, { item });
  const [shown] = detail.body.activity[0].items;
  assert.equal(shown.output, 'a\nb');
  assert.equal('outputTruncated' in shown, false);
  assert.equal(detail.body.jobs[0].output, 'done');
  assert.equal('outputTruncated' in detail.body.jobs[0], false);
});
