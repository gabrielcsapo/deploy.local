import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-question-test-'));
await import('../../test-ports.ts');
const { get, save, list, events } = await import('../../workspace/store.ts');
const { questionTool, answerQuestion, taskQuestions, tasksWaitingForAnswer } =
  await import('./questions.ts');
const { startRun, setTaskOutcome } = await import('../../workspace/service.ts');
const { queueMessage } = await import('../../workspace/queued-message.ts');
const { workerCommand } = await import('../../workspace/protocol.ts');
const { resolveRestartedRun } = await import('../../workspace/run-recovery.ts');
const { closeMergedTasks } = await import('../../workspace/project-collaboration.ts');
const { continueQuestion } = await import('./question-continuation.ts');
const { coordinationApi } = await import('../../workspace/coordination-api.ts');
const { workspaceApi } = await import('../../workspace/api.ts');
const { issueAgentToken } = await import('../../workspace/coordination.ts');
function fixture() {
  const scope = { owner: randomUUID(), taskId: randomUUID(), runId: randomUUID() };
  save('task', scope.owner, { id: scope.taskId, status: 'running', revision: 1 });
  save('run', scope.owner, { id: scope.runId, taskId: scope.taskId, status: 'running' });
  return scope;
}
const ask = (scope: ReturnType<typeof fixture>, extra = {}) =>
  questionTool(scope, {
    question: 'Which label should this disposable test use?',
    options: ['Blue', 'Green'],
    operationId: randomUUID(),
    ...extra,
  });
test('question creation and identical replies are idempotent; competing answers cannot overwrite', () => {
  const s = fixture(),
    operationId = randomUUID();
  const q = ask(s, { operationId });
  assert.equal(ask(s, { operationId }).id, q.id);
  assert.throws(() => ask(s, { operationId, question: 'Different question' }), /different command/);
  assert.throws(() => ask(s), /already has a pending/);
  const result = answerQuestion(s.owner, s.taskId, q.id, { answer: 'Custom purple' });
  assert.equal(result.answer, 'Custom purple');
  assert.deepEqual(answerQuestion(s.owner, s.taskId, q.id, { answer: 'Custom purple' }), result);
  assert.throws(
    () => answerQuestion(s.owner, s.taskId, q.id, { answer: 'Blue' }),
    /already resolved/,
  );
  assert.equal(events(s.owner).filter((e) => e.type === 'question.answered').length, 1);
  assert.equal(list('question', s.owner).length, 1);
});
test('owner, task and run boundaries reject disclosure and answers', () => {
  const s = fixture(),
    other = fixture(),
    q = ask(s);
  assert.throws(() => answerQuestion(other.owner, s.taskId, q.id, { answer: 'Blue' }), /Not found/);
  assert.throws(
    () => answerQuestion(s.owner, other.taskId, q.id, { answer: 'Blue' }),
    /another task/,
  );
  assert.throws(
    () => questionTool({ ...s, runId: other.runId }, { action: 'read', questionId: q.id }),
    /another run/,
  );
  assert.throws(() => taskQuestions(other.owner, s.taskId), /Not found/);
});
test('dismissal and task closure cancel questions, while stopping a run preserves them', () => {
  const s = fixture(),
    q = ask(s);
  save('run', s.owner, {
    ...get('run', s.owner, s.runId),
    stopRequested: true,
    status: 'interrupted',
  });
  assert.equal(taskQuestions(s.owner, s.taskId)[0].status, 'pending');
  answerQuestion(s.owner, s.taskId, q.id, { dismiss: true });
  assert.equal(taskQuestions(s.owner, s.taskId)[0].status, 'dismissed');
  assert.throws(
    () => answerQuestion(s.owner, s.taskId, q.id, { answer: 'Blue' }),
    /already resolved/,
  );
  const closed = fixture();
  ask(closed);
  save('run', closed.owner, { ...get('run', closed.owner, closed.runId), status: 'succeeded' });
  setTaskOutcome(closed.owner, closed.taskId, 'close', { revision: 1 });
  assert.equal(
    get('question', closed.owner, taskQuestions(closed.owner, closed.taskId)[0].id).status,
    'cancelled',
  );
});
test('bounded input rejects malformed questions, choices and answers', () => {
  const s = fixture();
  for (const extra of [
    { question: '' },
    { question: 'x'.repeat(2001) },
    { options: ['Blue', 'Blue'] },
    { options: [1] },
    { options: 'Blue' },
  ])
    assert.throws(() => ask(s, extra));
  const q = ask(s);
  for (const answer of ['', 'x'.repeat(4001), {}])
    assert.throws(() => answerQuestion(s.owner, s.taskId, q.id, { answer }));
  assert.equal(taskQuestions(s.owner, s.taskId)[0].status, 'pending');
});
test('one original tool call continues after a client answer; workers cannot answer', async (t) => {
  const s = fixture(),
    token = issueAgentToken(s);
  const server = createServer((req, res) => {
    if (req.headers['x-deploy-agent-token']) void coordinationApi(req, res);
    else
      void workspaceApi(
        req,
        res,
        s.owner,
        req.headers['x-test-worker'] ? 'worker-test' : undefined,
      );
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const call = async (args: any) => {
    const response = await fetch(origin + '/api/agent/tools', {
      method: 'POST',
      headers: { 'x-deploy-agent-token': token },
      body: JSON.stringify({ name: 'deploy_ask_user', args }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const q = await call({ question: 'Choose a label', operationId: randomUUID() });
  let reads = 0;
  const pending = continueQuestion(q, call, async () => {
    reads++;
    const path = origin + `/api/tasks/${s.taskId}/questions/${q.id}/answer`;
    const body = JSON.stringify({ operationId: randomUUID(), answer: 'Blue' });
    const denied = await fetch(path, { method: 'POST', headers: { 'x-test-worker': 'yes' }, body });
    assert.equal(denied.status, 403);
    const accepted = await fetch(path, { method: 'POST', body });
    assert.equal(accepted.status, 200);
    const replay = await fetch(path, { method: 'POST', body });
    assert.equal(replay.status, 200);
  });
  assert.equal((await pending).answer, 'Blue');
  assert.equal(reads, 1);
  assert.equal(events(s.owner).filter((e) => e.type === 'question.answered').length, 1);
});
test('continuation returns dismissal and propagates a stopped run without another question', async () => {
  assert.equal(
    (await continueQuestion({ id: 'q', status: 'pending' }, async () => ({ status: 'dismissed' })))
      .status,
    'dismissed',
  );
  await assert.rejects(
    continueQuestion({ id: 'q', status: 'pending' }, async () => {
      throw Object.assign(new Error('Run stopped'), { status: 401 });
    }),
    /Run stopped/,
  );
});

test('coordinator outage retries only reads and an unanswered wait stays bounded', async () => {
  let reads = 0,
    elapsed = 0;
  const initial = { id: 'q', status: 'pending', expiresAt: 2000 };
  const result = await continueQuestion(
    initial,
    async (args) => {
      assert.deepEqual(args, { action: 'read', questionId: 'q' });
      if (++reads === 1) throw new TypeError('fetch failed');
      if (reads === 2) throw Object.assign(new Error('Unavailable'), { status: 503 });
      return { ...initial, status: 'answered', answer: 'Recovered' };
    },
    async () => {
      elapsed += 500;
    },
    () => elapsed,
  );
  assert.equal(result.answer, 'Recovered');
  assert.equal(reads, 3);
  elapsed = 0;
  const expired = await continueQuestion(
    initial,
    async () => {
      throw new TypeError('Offline');
    },
    async () => {
      elapsed += 500;
    },
    () => elapsed,
  );
  assert.equal(expired.status, 'pending');
  assert.equal(expired.waitEnded, true);
  assert.match(expired.instruction, /still pending/);
  assert.equal(expired.answer, null);
  assert.equal(elapsed, 2000);
});

test('HTML authorization failures end the original question call without retrying', async (t) => {
  const { callCoordinationTool } = await import('../../workspace/coordination-tools.ts');
  let requests = 0;
  const server = createServer((_req, res) => {
    if (++requests === 1) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'q', status: 'pending', expiresAt: Date.now() + 30000 }));
    } else {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end('<html>Sign in again</html>');
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previous = { url: process.env.DEPLOY_AGENT_URL, token: process.env.DEPLOY_AGENT_TOKEN };
  t.after(() => {
    server.closeAllConnections();
    server.close();
    if (previous.url === undefined) delete process.env.DEPLOY_AGENT_URL;
    else process.env.DEPLOY_AGENT_URL = previous.url;
    if (previous.token === undefined) delete process.env.DEPLOY_AGENT_TOKEN;
    else process.env.DEPLOY_AGENT_TOKEN = previous.token;
  });
  process.env.DEPLOY_AGENT_URL = 'http://127.0.0.1:' + (server.address() as any).port;
  process.env.DEPLOY_AGENT_TOKEN = 'test-only';
  await assert.rejects(
    callCoordinationTool('deploy_ask_user', { question: 'Example?', operationId: randomUUID() }),
    (error: any) => error.status === 401 && error.message === 'Coordinator HTTP 401',
  );
  assert.equal(requests, 2);
});

test('questions survive actual run completion and old expiry; answers start exactly one contextual follow-up', () => {
  for (const status of ['succeeded', 'failed', 'interrupted']) {
    const s = fixture();
    save('worker', s.owner, {
      id: 'worker',
      heartbeat: new Date().toISOString(),
      capabilities: ['codex'],
      modelOptions: [],
    });
    save('task', s.owner, { ...get('task', s.owner, s.taskId), workerId: 'worker' });
    save('run', s.owner, {
      ...get('run', s.owner, s.runId),
      workerId: 'worker',
      adapter: 'codex',
      generation: 'generation',
      model: '',
      effort: '',
    });
    const q = ask(s);
    save('question', s.owner, { ...q, expiresAt: Date.now() - 1 });
    workerCommand(s.owner, '/workers/worker/complete', {
      runId: s.runId,
      generation: 'generation',
      status,
    });
    assert.ok(tasksWaitingForAnswer(s.owner).has(s.taskId));
    assert.equal(taskQuestions(s.owner, s.taskId)[0].status, 'pending');
    const result = answerQuestion(s.owner, s.taskId, q.id, { answer: 'Green' });
    const run = get('run', s.owner, result.followUpRunId);
    assert.equal(run.status, 'queued');
    assert.equal(run.adapter, 'codex');
    assert.match(run.prompt, /Agent question: Which label/);
    assert.match(run.prompt, /Owner answer: Green/);
    assert.equal(
      answerQuestion(s.owner, s.taskId, q.id, { answer: 'Green' }).followUpRunId,
      run.id,
    );
    assert.equal(list('run', s.owner).length, 2);
    assert.equal(tasksWaitingForAnswer(s.owner).has(s.taskId), false);
  }
});

test('different direct or queued follow-ups supersede pending questions; merging cancels them', () => {
  for (const queued of [false, true]) {
    const s = fixture();
    ask(s);
    if (!queued) save('run', s.owner, { ...get('run', s.owner, s.runId), status: 'succeeded' });
    const send = queued ? queueMessage : startRun;
    send(s.owner, s.taskId, {
      revision: 1,
      content: 'Do something else',
      answerQuestionId: taskQuestions(s.owner, s.taskId)[0].id,
    });
    assert.equal(
      get('question', s.owner, taskQuestions(s.owner, s.taskId)[0].id).status,
      'cancelled',
    );
  }
  const s = fixture();
  ask(s);
  save('task', s.owner, { ...get('task', s.owner, s.taskId), status: 'review' });
  closeMergedTasks(s.owner, { id: 'pull', status: 'merged', taskIds: [s.taskId] });
  assert.equal(taskQuestions(s.owner, s.taskId)[0].status, 'cancelled');
});

test('an answer arriving at run end resumes only if the original agent did not consume it', () => {
  for (const consumed of [true, false]) {
    const s = fixture();
    save('worker', s.owner, {
      id: 'worker',
      heartbeat: new Date().toISOString(),
      capabilities: ['codex'],
      modelOptions: [],
    });
    save('task', s.owner, { ...get('task', s.owner, s.taskId), workerId: 'worker' });
    save('run', s.owner, {
      ...get('run', s.owner, s.runId),
      workerId: 'worker',
      adapter: 'codex',
      generation: 'g',
    });
    const q = ask(s);
    answerQuestion(s.owner, s.taskId, q.id, { answer: 'Blue' });
    if (consumed) questionTool(s, { action: 'read', questionId: q.id });
    workerCommand(s.owner, '/workers/worker/complete', {
      runId: s.runId,
      generation: 'g',
      status: 'succeeded',
    });
    assert.equal(list('run', s.owner).length, consumed ? 1 : 2);
  }
});

test('an answer held by an interrupted writer resumes once the restart is resolved', () => {
  const s = fixture();
  const q = ask(s);
  save('run', s.owner, { ...get('run', s.owner, s.runId), status: 'unknown' });
  answerQuestion(s.owner, s.taskId, q.id, { answer: 'Blue' });
  assert.equal(list('run', s.owner).length, 1);
  resolveRestartedRun(s.owner, s.runId, 'user-confirmed');
  const answer = get('question', s.owner, q.id);
  assert.equal(get('run', s.owner, answer.followUpRunId).status, 'queued');
});
