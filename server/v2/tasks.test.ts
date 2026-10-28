import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'v2-task-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save, event } = await import('../workspace/store.ts');
const { taskSnapshot } = await import('./tasks.ts');
const { mapConversationEvent } = await import('./events.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('Task read model is owner scoped and retains messages beyond the recent-events window', () => {
  save('project', 'owner', { id: 'p', name: 'home-gym' });
  save('task', 'owner', {
    id: 't',
    projectId: 'p',
    title: 'Fix sync',
    status: 'ready',
    revision: 1,
  });
  event('owner', 't', null, 'task.created', { id: 't' });
  event('owner', 't', null, 'message', { id: 'first', role: 'user', content: 'Fix sync' });
  for (let i = 0; i < 1001; i++) event('owner', 't', null, 'ignored', {});
  event('owner', 't', null, 'question.requested', { id: 'q' });
  save('pull-request', 'owner', { id: 'pr', projectId: 'p', taskIds: ['t'] });
  save('check', 'owner', { id: 'c', taskId: 't', status: 'succeeded' });
  const result = taskSnapshot('owner', 't');
  assert.deepEqual(
    result.events.map((item) => item.kind),
    ['you', 'decision'],
  );
  assert.equal(result.pulls[0].id, 'pr');
  assert.equal(result.checks[0].id, 'c');
  assert.equal(result.firstTask, true);
  assert.throws(() => taskSnapshot('other', 't'), /Not found/);
});
test('Existing task, checkpoint, check and job events become stable typed conversation events', () => {
  const map = (type: string, payload: object) =>
    mapConversationEvent({
      type,
      payload,
      cursor: 1,
      runId: 'r',
      createdAt: '2026-10-27T12:00:00Z',
    });
  assert.equal(map('task.created', { id: 'task' })?.kind, 'task');
  assert.equal(map('checkpoint.created', { checkpointId: 'c', digest: 'sha' })?.id, 'checkpoint:c');
  for (const [type, live] of [
    ['queued', true],
    ['running', true],
    ['succeeded', false],
    ['failed', false],
    ['interrupted', false],
    ['unknown', false],
  ] as const) {
    const mapped = map(`check.${type}`, { id: 'c' });
    assert.equal(mapped?.id, 'check:c');
    assert.equal(mapped?.kind === 'worklog' && mapped.live, live);
  }
  assert.equal(map('job.running', { jobId: 'j' })?.id, map('job.succeeded', { jobId: 'j' })?.id);
  assert.equal(map('job.unknown', { jobId: 'j' })?.kind, 'worklog');
  assert.equal(map('checkpoint.created', {}), undefined);
  assert.equal(map('job.running', {}), undefined);
  assert.equal(map('agent.ship', { ref: 'main' }), undefined);
});

test('Task route passes through owner authentication and refuses agent credentials', async () => {
  const { v2Api } = await import('./api.ts');
  async function request(owner: string | null, headers = {}) {
    let status = 0,
      body = '';
    const req = {
      method: 'GET',
      url: '/api/v2/tasks/t',
      headers,
    } as import('node:http').IncomingMessage;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
      },
    } as unknown as import('node:http').ServerResponse;
    await v2Api(req, res, () =>
      owner ? { username: owner } : (res.writeHead(401), res.end('{}'), null),
    );
    return { status, body: JSON.parse(body) };
  }
  assert.equal((await request(null)).status, 401);
  assert.equal((await request('other')).status, 404);
  assert.equal((await request('owner', { 'x-deploy-agent-token': 'agent' })).status, 403);
  const result = await request('owner');
  assert.equal(result.status, 200);
  assert.equal(result.body.task.id, 't');
});
