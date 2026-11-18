import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'v2-task-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save, event } = await import('../../workspace/store.ts');
const { taskSnapshot } = await import('./tasks.ts');
const { mapConversationEvent } = await import('../../v2/events.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a task carries only its landed approved design and the latest check state', () => {
  const owner = 'design-check';
  save('task', owner, { id: 'build', title: 'Build', status: 'ready', revision: 1 });
  assert.equal('designCheck' in taskSnapshot(owner, 'build'), false);
  const row = {
    id: 'design:p:header',
    context: {
      source: 'design',
      taskId: 'build',
      checkBoards: [
        { file: 'Header.html', title: 'Header', widths: [1440, 700], height: 900 },
        { file: 'HeaderPhone.html', title: 'Header on iPhone', widths: [390], height: 844 },
      ],
    },
    item: {
      title: 'A calmer Tally header',
      state: 'answered',
      answer: { actionId: 'approve', at: '2026-11-09T14:14:00Z' },
    },
  };
  save('v2-inbox-native', owner, row);
  assert.equal('designCheck' in taskSnapshot(owner, 'build'), false);
  save('design-review-landing', owner, { id: row.id, state: 'pending', commit: 'approved-main' });
  assert.equal('designCheck' in taskSnapshot(owner, 'build'), false);
  save('design-review-landing', owner, { id: row.id, state: 'landed', commit: 'approved-main' });
  const check = taskSnapshot(owner, 'build').designCheck!;
  assert.equal(check.state, 'waiting');
  assert.equal(check.title, row.item.title);
  assert.equal(check.approvedAt, row.item.answer.at);
  assert.equal(check.commit, 'approved-main');
  assert.deepEqual(check.boards, row.context.checkBoards);
  assert.equal(check.reviewHref, '/dashboard/inbox?item=design%3Ap%3Aheader');
  for (const state of ['matches', 'differs', 'kept', 'waiting']) {
    save('design-review-built', owner, {
      id: row.id,
      state,
      captures: 2,
      text: 'History wraps',
      at: '2026-11-09T14:30:00Z',
    });
    assert.equal(taskSnapshot(owner, 'build').designCheck!.state, state);
  }
  save('v2-inbox-native', owner, {
    ...row,
    item: { ...row.item, answer: { ...row.item.answer, actionId: 'changes' } },
  });
  assert.equal('designCheck' in taskSnapshot(owner, 'build'), false);
  assert.throws(() => taskSnapshot('another-owner', 'build'), /Not found/);
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
  save('checkpoint', 'owner', { id: 'c1', taskId: 't', createdAt: '2026-10-27T12:00:00Z' });
  save('checkpoint', 'owner', { id: 'c2', taskId: 't', createdAt: '2026-10-27T12:02:00Z' });
  save('checkpoint', 'other', { id: 'c3', taskId: 't', createdAt: '2026-10-27T12:04:00Z' });
  const result = taskSnapshot('owner', 't');
  assert.deepEqual(result.checkpoint, { number: 2, at: '2026-10-27T12:02:00Z' });
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
      // A task's events; a pipeline's jobs (no task) are no conversation's.
      taskId: 't',
      createdAt: '2026-10-27T12:00:00Z',
    });
  assert.equal(map('task.created', { id: 'task' })?.kind, 'task');
  // Its deploy_checkpoint call is the step; the event would repeat it as a raw digest.
  assert.equal(map('checkpoint.created', { checkpointId: 'c', digest: 'sha' }), undefined);
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
  assert.equal(
    map('v2.conversation', {
      event: {
        kind: 'decision',
        id: 'build-decision',
        at: '2026-11-09T14:00:00Z',
        inboxItemId: 'design-build:1',
      },
    })?.kind,
    'decision',
  );
});

test('Task route passes through owner authentication and refuses agent credentials', async () => {
  const { v2Api } = await import('../../v2/api.ts');
  async function request(owner: string | null, headers = {}) {
    let status = 0,
      body = '';
    const req = {
      method: 'GET',
      url: '/api/task-snapshots/t',
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

test('the first-task flag is false on later tasks and scoped to the account', () => {
  save('task', 'owner', { id: 'later', title: 'Second task' });
  assert.equal(taskSnapshot('owner', 'later').firstTask, false);
  assert.equal(taskSnapshot('owner', 't').firstTask, false);
  save('task', 'new-owner', { id: 'first', title: 'First task' });
  assert.equal(taskSnapshot('new-owner', 'first').firstTask, true);
});

test('checkpoint history reads the recorded shell and job checks that populate published descriptions', () => {
  const owner = 'history-owner';
  save('task', owner, {
    id: 'history',
    title: 'Time',
    publishedCheckpointId: 'second',
    publishedCommit: 'published-head',
    startedBy: 'Gabriel',
    startedFrom: 'New task',
    createdAt: '2026-10-30T10:00:00Z',
    updatedAt: '2026-10-30T10:02:00Z',
  });
  save('run', owner, {
    id: 'run',
    taskId: 'history',
    workerId: 'computer',
    adapter: 'claude',
    model: 'opus-id',
  });
  save('worker', owner, {
    id: 'computer',
    name: 'SER',
    modelOptions: [{ id: 'claude', models: [{ id: 'opus-id', name: 'Opus' }] }],
  });
  const activity = (id: string, type: string, at: string, extra = {}) => {
    event(owner, 'history', 'run', 'item.completed', { item: { id, type, ...extra } });
    db.prepare('UPDATE events SET createdAt=? WHERE cursor=(SELECT MAX(cursor) FROM events)').run(
      at,
    );
  };
  activity('test', 'command_execution', '2026-10-30T10:00:01Z', {
    command: 'node --test web',
    exit_code: 0,
    duration_ms: 3000,
  });
  assert.equal(taskSnapshot(owner, 'history').checks[0].source, 'workspace');
  save('checkpoint', owner, {
    id: 'first',
    taskId: 'history',
    createdAt: '2026-10-30T10:00:02Z',
    snapshot: { digest: 'first-digest' },
  });
  activity('edit', 'file_change', '2026-10-30T10:01:00Z');
  save('checkpoint', owner, {
    id: 'second',
    taskId: 'history',
    createdAt: '2026-10-30T10:02:00Z',
    snapshot: { digest: 'second-digest' },
  });
  save('job', owner, {
    id: 'job',
    taskId: 'history',
    checkpointId: 'second',
    digest: 'second-digest',
    command: 'node --test web',
    name: 'Unit tests',
    output: 'Midnight read 24:00:00',
    startedAt: '2026-10-30T10:02:02Z',
    finishedAt: '2026-10-30T10:02:05Z',
    status: 'failed',
    createdAt: '2026-10-30T10:02:01Z',
  });
  save('job', 'another-owner', {
    id: 'other',
    taskId: 'history',
    digest: 'second-digest',
    status: 'succeeded',
  });
  const snapshot = taskSnapshot(owner, 'history');
  assert.equal(snapshot.checkpoints.length, 2);
  assert.equal(snapshot.checkpoints[0].checks[0].source, 'workspace');
  assert.equal(snapshot.checkpoints[0].checks[0].status, 'succeeded');
  assert.equal(snapshot.checkpoints[0].checks[0].durationMs, 3000);
  assert.deepEqual(
    snapshot.checkpoints[1].checks.map((check) => check.id),
    ['job'],
  );
  assert.equal(snapshot.checkpoints[1].checks[0].status, 'failed');
  assert.equal(snapshot.checkpoints[1].checks[0].name, 'Unit tests');
  assert.equal(snapshot.checkpoints[1].checks[0].output, 'Midnight read 24:00:00');
  assert.equal(snapshot.checkpoints[1].checks[0].finishedAt, '2026-10-30T10:02:05Z');
  assert.equal(snapshot.checkpoints[1].published, true);
  assert.equal(snapshot.checkpoints[1].commit, 'published-head');
  assert.equal(snapshot.task.startedBy, 'Gabriel');
  assert.equal(snapshot.task.startedFrom, 'New task');
  assert.equal(snapshot.task.startedModel, 'Opus');
  assert.equal(snapshot.task.updatedAt, '2026-10-30T10:02:00Z');
  assert.equal(snapshot.project, undefined);
});

test('task route reads branch distance and linked app facts without exposing a repository API URL', async () => {
  const repo = join(root, 'facts-repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  writeFileSync(
    join(repo, 'deploy.yaml'),
    'apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: tally\ncomponents:\n  web:\n    image: example/web\n',
  );
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Base');
  git('checkout', '-b', 'task/time');
  writeFileSync(join(repo, 'time.txt'), 'HH:MM:SS');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Time');
  git('checkout', 'main');
  writeFileSync(join(repo, 'main.txt'), 'Main change');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Main');
  save('project', 'facts-owner', {
    id: 'facts-project',
    name: 'Tally',
    repositoryPath: repo,
    defaultBranch: 'main',
  });
  save('task', 'facts-owner', { id: 'facts-task', projectId: 'facts-project', title: 'Time' });
  save('pull-request', 'facts-owner', {
    id: 'facts-pull',
    projectId: 'facts-project',
    taskIds: ['facts-task'],
    sourceBranch: 'task/time',
    targetBranch: 'main',
    status: 'open',
  });
  const { saveDeployment } = await import('../../store.ts');
  saveDeployment({ name: 'tally', username: 'facts-owner', port: 3000 });
  const { tasksApi } = await import('./tasks.ts');
  let body: any;
  await tasksApi(
    { method: 'GET', url: '/api/task-snapshots/facts-task' } as import('node:http').IncomingMessage,
    {
      writeHead() {},
      end(value: string) {
        body = JSON.parse(value);
      },
    } as unknown as import('node:http').ServerResponse,
    'facts-owner',
  );
  assert.deepEqual(body.comparison, { ahead: 1, behind: 1 });
  assert.deepEqual(body.project, {
    id: 'facts-project',
    name: 'Tally',
    kind: 'Web app',
    address: 'tally.local',
  });
  assert.equal(body.task.startedFrom, undefined);
  assert.equal(body.task.branch, undefined);
});
