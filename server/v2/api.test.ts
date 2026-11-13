import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = mkdtempSync(join(tmpdir(), 'deploy-v2-api-'));
process.env.DEPLOY_DATA_DIR = root;
const { STATE_REFRESH_INTERVAL_MS } = await import('./state-refresh.ts');
const { db, save, get, list, event, cursor, now } = await import('../workspace/store.ts');
const { registerUser } = await import('../store.ts');
const { questionTool, answerQuestion } = await import('../workspace/questions.ts');
const { interactiveTool, interactiveWorker, interactiveOperator } =
  await import('../workspace/interactive.ts');
const { syncInbox } = await import('./inbox.ts');
const { mapConversationEvent, waitForV2Events } = await import('./events.ts');
const { v2Api } = await import('./api.ts');

// Exercise the actual cookie/header auth helper, which no longer starts API background services.
const { requireAuth } = await import('../api/shared.ts');
const server = createServer((req, res) => {
  void v2Api(req, res, requireAuth);
});
let port = 5180;
for (; port <= 5199; port++) {
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    break;
  } catch (error: any) {
    if (error.code !== 'EADDRINUSE') throw error;
  }
}
if (port > 5199) throw new Error('No test port available in 5180–5199');
const origin = `http://127.0.0.1:${port}/api/v2`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const owner = randomUUID();
  const token = registerUser(owner, 'test-password').token!;
  const scope = { owner, taskId: randomUUID(), runId: randomUUID() };
  save('task', owner, { id: scope.taskId, projectId: 'home-gym', status: 'running' });
  save('run', owner, {
    id: scope.runId,
    taskId: scope.taskId,
    status: 'running',
    agentId: 'scout',
    adapter: 'codex',
    model: 'local',
  });
  return { ...scope, headers: { 'x-deploy-username': owner, 'x-deploy-token': token } };
}
function ask(scope: ReturnType<typeof fixture>) {
  return questionTool(scope, {
    question: 'Which color?',
    options: ['Blue', 'Green'],
    operationId: randomUUID(),
  });
}
function control(scope: ReturnType<typeof fixture>) {
  interactiveWorker(scope.owner, 'local', 'poll', {
    instanceId: 'instance',
    targets: [{ id: 'screen', kind: 'computer', label: 'SER', available: true }],
  });
  return interactiveTool(scope, {
    action: 'request',
    workerId: 'local',
    targetId: 'screen',
    operationId: randomUUID(),
  });
}
async function request(scope: ReturnType<typeof fixture>, path: string, body?: any) {
  const res = await fetch(origin + path, {
    headers: scope.headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

test('auth uses the existing mount and rejects missing, invalid, agent and worker credentials', async () => {
  assert.match(
    readFileSync(new URL('../api/v2.ts', import.meta.url), 'utf8'),
    /if \(path\.startsWith\('\/api\/v2\/'\)\)[\s\S]*v2Api\(req, res, requireAuth\)/,
  );
  const s = fixture();
  for (const path of ['/inbox', '/events?waitMs=10000', '/inbox/question:q/answer']) {
    for (const headers of [
      {},
      { 'x-deploy-username': s.owner, 'x-deploy-token': 'wrong' },
      { 'x-deploy-agent-token': 'agent' },
      { 'x-deploy-worker-id': 'worker', 'x-deploy-worker-token': 'worker' },
    ]) {
      const res = await fetch(origin + path, {
        headers: headers as Record<string, string>,
        ...(path.endsWith('/answer') ? { method: 'POST', body: '{}' } : {}),
      });
      assert.equal(res.status, 401);
    }
  }
  const cookie =
    'deploy-sh-auth=' + encodeURIComponent(s.owner + ':' + s.headers['x-deploy-token']);
  assert.equal((await fetch(origin + '/inbox', { headers: { cookie } })).status, 200);
  for (const header of ['x-deploy-agent-token', 'x-deploy-worker-token'])
    assert.equal(
      (await fetch(origin + '/inbox', { headers: { ...s.headers, [header]: 'restricted' } }))
        .status,
      403,
    );
});

test('question and control mappings share one owner-scoped inbox', async () => {
  const s = fixture(),
    other = fixture(),
    q = ask(s),
    c = control(s);
  const response = await request(s, '/inbox');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map((entry: any) => entry.kind).sort(), [
    'control',
    'question',
  ]);
  const item = response.body.items.find((entry: any) => entry.kind === 'question');
  assert.equal(item.id, 'question:' + q.id);
  assert.equal(item.from, 'scout');
  assert.equal(item.projectId, 'home-gym');
  assert.equal(item.actions[0].label, 'Blue');
  assert.equal(
    response.body.items.find((entry: any) => entry.id === 'control:' + c.id).text,
    'Use SER for this task.',
  );
  assert.deepEqual((await request(other, '/inbox')).body.items, []);
  assert.equal(
    (await request(other, `/inbox/${item.id}/answer`, { actionId: 'option:0', on: 'cli' })).status,
    404,
  );
});

test('concurrent answers preserve the first answer and return it with 409 on every retry', async () => {
  const s = fixture(),
    q = ask(s),
    path = `/inbox/question:${q.id}/answer`;
  const responses = await Promise.all([
    request(s, path, { actionId: 'option:0', on: 'iphone', by: 'forged', at: 'forged' }),
    request(s, path, { actionId: 'option:1', on: 'cli' }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const winner = responses.find((r) => r.status === 200)!.body.item;
  const loser = responses.find((r) => r.status === 409)!.body;
  assert.deepEqual(loser.answer, winner.answer);
  assert.equal(winner.answer.by, s.owner);
  assert.ok(Number.isFinite(Date.parse(winner.answer.at)));
  assert.equal(
    get('question', s.owner, q.id).answer,
    winner.answer.actionId === 'option:0' ? 'Blue' : 'Green',
  );
  const retry = await request(s, path, { actionId: winner.answer.actionId, on: 'web' });
  assert.equal(retry.status, 409);
  assert.deepEqual(retry.body.answer, winner.answer);
  assert.deepEqual((await request(s, '/inbox')).body.items, []);
  assert.deepEqual((await request(s, '/inbox?state=answered')).body.items, [winner]);
});

test('independent processes race through the same SQLite answer transaction', async () => {
  const s = fixture(),
    q = ask(s);
  const child = (on: string) =>
    new Promise<any>((resolve, reject) => {
      const code = `import { answerInbox } from './server/v2/inbox.ts'; import {db} from './server/workspace/store.ts'; try { console.log(JSON.stringify({status:200,item:answerInbox(${JSON.stringify(s.owner)},${JSON.stringify('question:' + q.id)},{actionId:'answer',note:${JSON.stringify(on)},on:${JSON.stringify(on)}})})); } catch(e) { console.log(JSON.stringify({status:e.status,answer:e.answer})); } db.close();`;
      const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code], {
        env: globalThis.process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '',
        errors = '';
      process.stdout.on('data', (chunk) => {
        output += chunk;
      });
      process.stderr.on('data', (chunk) => {
        errors += chunk;
      });
      process.on('error', reject);
      process.on('exit', (exitCode) =>
        exitCode === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)),
      );
    });
  const results = await Promise.all([child('desktop'), child('cli')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual(
    results.find((r) => r.status === 409).answer,
    results.find((r) => r.status === 200).item.answer,
  );
});

test('control approval uses existing validation and creates exactly one session', async () => {
  const s = fixture(),
    c = control(s),
    path = `/inbox/control:${c.id}/answer`;
  const accepted = await request(s, path, { actionId: 'approve', on: 'desktop' });
  assert.equal(accepted.status, 200);
  assert.equal(get('interactive-request', s.owner, c.id).status, 'approved');
  const sessions = list('interactive-session', s.owner);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].controlOwner, 'agent');
  assert.equal(sessions[0].targetId, c.targetId);
  const rejected = await request(s, path, { actionId: 'deny', on: 'web' });
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.body.answer, accepted.body.item.answer);
  assert.equal(list('interactive-session', s.owner).length, 1);
  const unavailable = fixture(),
    pending = control(unavailable);
  save('interactive-worker', unavailable.owner, {
    ...get('interactive-worker', unavailable.owner, 'local'),
    instanceId: 'new-process',
  });
  assert.equal(
    (
      await request(unavailable, `/inbox/control:${pending.id}/answer`, {
        actionId: 'approve',
        on: 'cli',
      })
    ).status,
    409,
  );
  assert.equal(list('v2-inbox-answer', unavailable.owner).length, 0);
});

test('free-text, dismissal and denial use their existing paths', async () => {
  for (const actionId of ['answer', 'dismiss']) {
    const s = fixture(),
      q = ask(s);
    const response = await request(s, `/inbox/question:${q.id}/answer`, {
      actionId,
      on: 'web',
      note: '  Purple  ',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.item.answer.note, 'Purple');
    assert.equal(
      get('question', s.owner, q.id).status,
      actionId === 'dismiss' ? 'dismissed' : 'answered',
    );
    assert.equal(get('question', s.owner, q.id).answer, actionId === 'dismiss' ? null : 'Purple');
  }
  const s = fixture(),
    c = control(s);
  assert.equal(
    (await request(s, `/inbox/control:${c.id}/answer`, { actionId: 'deny', on: 'cli' })).status,
    200,
  );
  assert.equal(get('interactive-request', s.owner, c.id).status, 'denied');
  assert.equal(list('interactive-session', s.owner).length, 0);
});

test('expired and withdrawn decisions cannot be answered; legacy answers stay resolved', async () => {
  for (const kind of ['question', 'control']) {
    // Questions wait for an answer and resume the run; only control requests expire.
    for (const state of kind === 'question' ? ['withdrawn'] : ['expired', 'withdrawn']) {
      const s = fixture(),
        row = kind === 'question' ? ask(s) : control(s);
      if (state === 'expired')
        save(kind === 'question' ? 'question' : 'interactive-request', s.owner, {
          ...row,
          expiresAt: Date.now() - 1,
        });
      // A stopped run withdraws its control request; a question is withdrawn with its task.
      else if (kind === 'question')
        save('task', s.owner, { ...get('task', s.owner, s.taskId), status: 'done' });
      else save('run', s.owner, { ...get('run', s.owner, s.runId), stopRequested: true });
      assert.equal(syncInbox(s.owner)[0].state, state);
      assert.equal(
        (
          await request(s, `/inbox/${kind}:${row.id}/answer`, {
            actionId: kind === 'question' ? 'option:0' : 'approve',
            on: 'web',
          })
        ).status,
        409,
      );
    }
  }
  const s = fixture(),
    q = ask(s),
    c = control(s);
  answerQuestion(s.owner, s.taskId, q.id, { answer: 'Legacy answer' });
  interactiveOperator(s.owner, s.taskId, 'deny', {
    requestId: c.id,
    clientId: randomUUID(),
    operationId: randomUUID(),
  });
  const items = syncInbox(s.owner);
  assert.ok(items.every((item) => item.state === 'answered' && !item.answer));
  const retry = await request(s, `/inbox/question:${q.id}/answer`, {
    actionId: 'option:1',
    on: 'cli',
  });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.answer, null);
  assert.equal(get('question', s.owner, q.id).answer, 'Legacy answer');
});

test('invalid requests cannot mutate decisions', async () => {
  const s = fixture(),
    q = ask(s),
    path = `/inbox/question:${q.id}/answer`;
  for (const body of [
    null,
    [],
    {},
    { actionId: 'answer', on: 'watch' },
    { actionId: 'option:9', on: 'web' },
    { actionId: 'answer', on: 'web', note: '' },
    { actionId: 'answer', on: 'web', note: 'x'.repeat(4001) },
  ])
    assert.equal((await request(s, path, body)).status, 400);
  for (const query of ['after=-1', 'after=1.5', 'after=NaN', 'waitMs=Infinity', 'waitMs=-1'])
    assert.equal((await request(s, '/events?' + query)).status, 400);
  assert.equal((await request(s, '/inbox?state=expired')).status, 400);
  assert.equal((await request(s, '/unknown')).status, 404);
  const invalid = await fetch(origin + path, { method: 'POST', headers: s.headers, body: '{' });
  assert.equal(invalid.status, 400);
  const oversized = await fetch(origin + path, {
    method: 'POST',
    headers: s.headers,
    body: 'x'.repeat(40000),
  });
  assert.equal(oversized.status, 413);
  assert.equal(get('question', s.owner, q.id).status, 'pending');
});

test('conversation mapping preserves message, decision and work item identities', () => {
  const base = { cursor: 1, taskId: 'task', runId: 'run', createdAt: now() };
  const row = (type: string, payload: any) => ({ ...base, type, payload });
  const user = mapConversationEvent(row('message', { id: 'msg', role: 'user', content: 'Hello' }));
  assert.deepEqual(user, {
    kind: 'you',
    id: 'msg',
    at: base.createdAt,
    text: 'Hello',
    attachments: [],
  });
  const reply = mapConversationEvent(
    row('message', { providerItemId: 'item', role: 'assistant', content: 'First\n\nSecond' }),
    { agentId: 'warden' },
  );
  assert.deepEqual(reply, {
    kind: 'reply',
    id: 'run:item:item',
    at: base.createdAt,
    agent: 'warden',
    paragraphs: ['First', 'Second'],
  });
  assert.equal(mapConversationEvent(row('question.requested', { id: 'q' }))?.kind, 'decision');
  assert.equal(
    mapConversationEvent(row('control.requested', { requestId: 'c' }))?.kind,
    'decision',
  );
  for (const [type, icon] of [
    ['command_execution', 'terminal'],
    ['file_change', 'edit'],
    ['web_search', 'search'],
    ['tool_call', 'pulse'],
    ['tool_result', 'pulse'],
    ['mcp_tool_call', 'pulse'],
  ]) {
    const started = mapConversationEvent(row('item.started', { item: { id: 'item', type } }));
    const completed = mapConversationEvent(row('item.completed', { item: { id: 'item', type } }));
    assert.equal(started?.id, completed?.id);
    assert.equal(started?.kind === 'worklog' && started.live, true);
    assert.equal(completed?.kind === 'worklog' && completed.live, false);
    assert.equal(completed?.kind === 'worklog' && completed.steps[0].icon, icon);
  }
  assert.equal(
    mapConversationEvent(
      row('item.completed', { item: { id: 'i', type: 'agent_message', text: 'Duplicate' } }),
    ),
    undefined,
  );
  assert.equal(mapConversationEvent(row('run.running', {})), undefined);
  assert.equal(mapConversationEvent(row('provider.event', null)), undefined);
  assert.equal(mapConversationEvent(row('question.requested', {})), undefined);
  assert.equal(
    mapConversationEvent(row('item.started', { item: { id: 'i', type: '__proto__' } })),
    undefined,
  );
  const malformed = mapConversationEvent(
    row('item.started', {
      item: { id: 'i', type: 'command_execution', command: { raw: 'value' } },
    }),
  );
  assert.equal(malformed?.kind === 'worklog' && malformed.summary, 'command execution');
});

test('after=latest starts a client at the newest event without replaying history', async () => {
  const s = fixture();
  ask(s);
  const all = await request(s, '/events?after=0');
  const latest = await request(s, '/events?after=latest');
  assert.deepEqual(latest.body, { events: [], cursor: all.body.cursor, supportsWait: true });
});

test('long-poll wakes for cross-process events and replays stable cursors', async () => {
  const s = fixture(),
    q = ask(s);
  const initial = await request(s, '/events?after=0');
  assert.ok(
    initial.body.events.some((e: any) => e.type === 'conversation' && e.event.kind === 'decision'),
  );
  assert.ok(initial.body.events.some((e: any) => e.type === 'inbox' && e.item.state === 'waiting'));
  const pending = request(s, '/events?after=' + initial.body.cursor + '&waitMs=10000');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {answerInbox} from './server/v2/inbox.ts'; import {db} from './server/workspace/store.ts'; answerInbox(${JSON.stringify(s.owner)},${JSON.stringify('question:' + q.id)},{actionId:'option:0',on:'iphone'}); db.close();`,
    ],
    { env: process.env, stdio: 'ignore' },
  );
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  const response = await pending;
  assert.equal(response.body.supportsWait, true);
  const answered = response.body.events.find((e: any) => e.type === 'inbox');
  assert.equal(answered.item.answer.on, 'iphone');
  assert.deepEqual((await request(s, '/events?after=' + initial.body.cursor)).body, response.body);
});

test('long-poll observes legacy mutations and expiry without a v2 writer', async () => {
  const s = fixture(),
    q = ask(s);
  syncInbox(s.owner);
  const pending = waitForV2Events(s.owner, cursor(s.owner), 1000, new AbortController().signal);
  answerQuestion(s.owner, s.taskId, q.id, { answer: 'Blue' });
  assert.ok((await pending).events.some((e) => e.type === 'inbox' && e.item.state === 'answered'));
  const expiring = fixture(),
    c = control(expiring);
  save('interactive-request', expiring.owner, { ...c, expiresAt: Date.now() + 100 });
  syncInbox(expiring.owner);
  // Expiry has no event of its own: it shows at the next state refresh, within the cadence.
  const expired = await waitForV2Events(
    expiring.owner,
    cursor(expiring.owner),
    STATE_REFRESH_INTERVAL_MS + 1000,
    new AbortController().signal,
  );
  assert.ok(expired.events.some((e) => e.type === 'inbox' && e.item.state === 'expired'));
});

test('waiters share one state refresh per cadence, and a new wait reads it instead of refreshing', async (t) => {
  const s = fixture();
  await waitForV2Events(s.owner, cursor(s.owner), 0, new AbortController().signal);
  // With no inbox items or live apps, each syncInbox refresh opens exactly one transaction.
  const transactions = t.mock.method(db, 'transaction');
  const started = Date.now();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      waitForV2Events(s.owner, cursor(s.owner), 1100, new AbortController().signal),
    ),
  );
  assert.ok(responses.every((response) => response.events.length === 0));
  // Inside the cadence, four waiters and their first passes recomputed nothing.
  assert.equal(transactions.mock.callCount(), 0);
  await delay(Math.max(0, STATE_REFRESH_INTERVAL_MS - (Date.now() - started)) + 50);
  // Once it has passed, the next wait refreshes once, and the one after reads that result.
  for (let i = 0; i < 2; i++)
    await waitForV2Events(s.owner, cursor(s.owner), 0, new AbortController().signal);
  assert.equal(transactions.mock.callCount(), 1);
});

test('plain events wake a waiter before the next state refresh', async () => {
  const s = fixture();
  const pending = waitForV2Events(s.owner, cursor(s.owner), 1000, new AbortController().signal);
  await delay(100);
  const sentAt = Date.now();
  event(s.owner, s.taskId, s.runId, 'message', { role: 'user', content: 'Wake now' });
  const response = await pending;
  // Sent 100 ms in; waiting for the next state refresh would take far longer than this.
  assert.ok(Date.now() - sentAt < 350, 'event delivery must not wait for the next state refresh');
  assert.ok(response.events.some((e) => e.type === 'conversation' && e.event.kind === 'you'));
});

test('unmapped events advance cursors, other owners cannot wake a waiter, and disconnect aborts', async () => {
  const s = fixture(),
    other = fixture();
  for (let i = 0; i < 1001; i++) event(s.owner, s.taskId, null, 'run.running', {});
  event(s.owner, s.taskId, null, 'message', {
    id: 'last',
    role: 'user',
    content: 'After ignored events',
  });
  const page = await waitForV2Events(s.owner, 0, 0, new AbortController().signal);
  assert.equal(page.events.length, 1);
  assert.equal(page.cursor, cursor(s.owner));
  const start = Date.now();
  const pending = waitForV2Events(s.owner, page.cursor, 150, new AbortController().signal);
  event(other.owner, other.taskId, null, 'message', { role: 'user', content: 'Private' });
  const empty = await pending;
  assert.deepEqual(empty.events, []);
  assert.equal(empty.cursor, page.cursor);
  assert.ok(Date.now() - start >= 140);
  const controller = new AbortController();
  const aborted = waitForV2Events(s.owner, page.cursor, 10000, controller.signal);
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  await assert.rejects(
    fetch(origin + '/events?after=' + page.cursor + '&waitMs=10000', {
      headers: s.headers,
      signal: AbortSignal.timeout(50),
    }),
  );
  await delay(75);
  assert.equal((await request(s, '/inbox')).status, 200);
});

test('wait duration is capped at ten seconds', async () => {
  const s = fixture(),
    started = Date.now();
  const response = await request(s, '/events?waitMs=100000');
  assert.deepEqual(response.body.events, []);
  assert.ok(Date.now() - started >= 9900);
  assert.ok(Date.now() - started < 12000);
});
