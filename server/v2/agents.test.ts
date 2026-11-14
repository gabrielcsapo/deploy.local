import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
const root = mkdtempSync(join(tmpdir(), 'v2-agents-'));
process.env.DEPLOY_DATA_DIR = root;
await import('../test-ports.ts');
const { db, save, list } = await import('../workspace/store.ts');
const { v2Api } = await import('./api.ts');
const { approvalRules, putApprovalRules, isAllowed, ProjectReleaseService } =
  await import('./releases.ts');
const { agentApprovalActions: approvalActions } = await import('./agents.ts');
const { saveProviderConnection } = await import('../workspace/provider-connections.ts');
let providerReply: unknown = {
  name: 'Keeper',
  job: 'Watch disk space. Ask before acting.',
  computers: ['SER', 'bazzite'],
};
let providerStatus = 200;
const server = createServer((req, res) => {
  if (req.url === '/v1/chat/completions') {
    res.writeHead(providerStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(providerReply) } }] }));
    return;
  }
  void v2Api(req, res, (request, response) => {
    const owner = request.headers['x-test-owner'];
    if (typeof owner === 'string') return { username: owner };
    response.writeHead(401);
    response.end();
    return null;
  });
});
let port = 5180;
for (; port <= 5183; port++) {
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    break;
  } catch (error: any) {
    if (error.code !== 'EADDRINUSE') throw error;
  }
}
if (port > 5183) throw new Error('No test port available');
const origin = `http://127.0.0.1:${port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  db.close();
  rmSync(root, { recursive: true, force: true });
});
async function request(owner: string, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${origin}/api${path}`, {
    method,
    headers: { 'x-test-owner': owner, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}
test('agents envelope, create defaults, patch and owner isolation', async () => {
  const owner = randomUUID();
  // Nothing ships by default; every agent is one you create.
  assert.deepEqual((await request(owner, '/agents')).body.agents, []);
  const created = await request(owner, '/agents', 'POST', {
    name: 'Keeper',
    job: 'Watch disk space',
    computers: ['SER'],
  });
  assert.equal(created.status, 201);
  const agent = created.body.agent;
  assert.equal(agent.createdBy, owner);
  const rules = approvalRules(owner);
  assert.equal(rules.length, 5);
  assert.ok(rules.every((rule) => rule.mode === 'ask' && rule.agent === agent.id));
  assert.deepEqual(
    rules.map((rule) => rule.action),
    approvalActions,
  );
  assert.equal(
    (await request(owner, `/agents/${agent.id}`, 'PATCH', { job: 'Suggest clean-ups' })).body.agent
      .job,
    'Suggest clean-ups',
  );
  assert.equal(
    (await request('another', `/agents/${agent.id}`, 'PATCH', { job: 'No' })).status,
    404,
  );
  assert.equal((await request('another', '/agents')).body.agents.length, 0);
  assert.equal(
    (await request(owner, `/agents/${agent.id}`, 'PATCH', { createdBy: 'another' })).status,
    400,
  );
  assert.equal(
    (await request(owner, '/agents', 'POST', { name: 'Bad', job: 'Job', computers: [3] })).status,
    400,
  );
  assert.equal((await request(owner, '/agents')).body.agents.length, 1);
});
test('an agent can be deleted with its rules, but never renamed to another identity', async () => {
  const owner = randomUUID();
  const { agent } = (await request(owner, '/agents', 'POST', { name: 'Keeper', job: 'Watch' }))
    .body;
  assert.equal((await request(owner, `/agents/${agent.id}`, 'PATCH', { id: 'gone' })).status, 400);
  assert.equal((await request('another', `/agents/${agent.id}`, 'DELETE')).status, 404);
  assert.equal((await request(owner, `/agents/${agent.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await request(owner, '/agents')).body.agents, []);
  assert.deepEqual(approvalRules(owner), []);
  assert.equal((await request(owner, `/agents/${agent.id}`, 'DELETE')).status, 404);
});
test('draft without an owner-connected provider is a clear 503 and creates nothing', async () => {
  const owner = randomUUID();
  const result = await request(owner, '/agents/draft', 'POST', { job: 'Watch disk space' });
  assert.equal(result.status, 503);
  assert.match(result.body.error, /Connect a compatible provider/);
  assert.equal(list('agent', owner).length, 0);
  assert.equal((await request(owner, '/agents/draft', 'POST', { job: '' })).status, 400);
});
test('draft uses configured provider, validates output, handles provider errors without fake drafts', async () => {
  const owner = randomUUID();
  save('worker', owner, { id: 'test' });
  saveProviderConnection(owner, {
    workerId: 'test',
    provider: 'compatible',
    enabled: true,
    mode: 'api-key',
    baseUrl: `${origin}/v1`,
    model: 'fixture',
    billingMode: 'local',
  });
  const result = await request(owner, '/agents/draft', 'POST', { job: 'Watch disk space' });
  assert.equal(result.status, 200);
  assert.equal(result.body.draft.name, 'Keeper');
  assert.equal(list('agent', owner).length, 0);
  providerReply = { name: 'Invalid' };
  assert.equal(
    (await request(owner, '/agents/draft', 'POST', { job: 'Watch disk space' })).status,
    502,
  );
  providerStatus = 401;
  assert.equal(
    (await request(owner, '/agents/draft', 'POST', { job: 'Watch disk space' })).status,
    502,
  );
  providerStatus = 200;
});
test('matrix PUT accepts every action, rejects invalid rules atomically', async () => {
  const owner = randomUUID();
  const rules = approvalActions.map((action) => ({
    id: action,
    agent: 'warden',
    action,
    mode: 'ask',
  }));
  assert.equal((await request(owner, '/approvals', 'PUT', { rules })).status, 200);
  for (const invalid of [
    null,
    {},
    [{ ...rules[0], action: 'delete-data' }],
    [{ ...rules[0], mode: 'yes' }],
    [{ ...rules[0], projectId: '' }],
    [{ ...rules[0], limit: 3 }],
    [rules[0], rules[0]],
    ...['ask', 'never', 'allow'].map((mode) => [{ ...rules[0], action: 'ship', mode }]),
  ]) {
    assert.equal((await request(owner, '/approvals', 'PUT', { rules: invalid })).status, 400);
    assert.equal((await request(owner, '/approvals')).body.rules.length, 5);
  }
});
test('isAllowed is owner/agent/action scoped, defaults to ask, respects project overrides and limits', () => {
  const owner = randomUUID();
  assert.equal(isAllowed(owner, 'warden', 'rollback', 'gym'), false);
  putApprovalRules(owner, [
    { id: 'global', agent: 'warden', action: 'rollback', mode: 'allow' },
    { id: 'project', agent: 'warden', action: 'rollback', projectId: 'gym', mode: 'never' },
  ]);
  assert.equal(isAllowed(owner, 'warden', 'rollback', 'other'), true);
  assert.equal(isAllowed(owner, 'warden', 'rollback', 'gym'), false);
  assert.equal(isAllowed(owner, 'scout', 'rollback', 'other'), false);
  assert.equal(isAllowed('another', 'warden', 'rollback', 'other'), false);
  assert.equal(isAllowed(owner, 'warden', 'restart', 'other'), false);
  putApprovalRules(owner, [
    { id: 'limited', agent: 'warden', action: 'rollback', mode: 'allow', limit: '3 times an hour' },
  ]);
  assert.equal(isAllowed(owner, 'warden', 'rollback'), false);
  save('v2-approval', owner, { id: 'legacy-ship', agent: 'scout', action: 'ship', mode: 'allow' });
  assert.equal(isAllowed(owner, 'scout', 'ship'), false);
});
test('rollback consults the common gate before touching runtime', () => {
  const owner = randomUUID();
  const service = new ProjectReleaseService({} as any);
  const project = { id: 'gym', name: 'home-gym', apps: [] };
  putApprovalRules(owner, [{ id: 'never', agent: 'warden', action: 'rollback', mode: 'never' }]);
  assert.deepEqual(service.requestAutoRollback(owner, project, 'Failed'), { allowed: false });
  assert.throws(() => service.rollback(owner, project, {}, 'rule', 'never'), /allow rule/);
  putApprovalRules(owner, [
    { id: 'limited', agent: 'warden', action: 'rollback', mode: 'allow', limit: '3 times' },
  ]);
  assert.throws(() => service.rollback(owner, project, {}, 'rule', 'limited'), /allow rule/);
});

test('a later Never rule blocks an already pending rollback decision', async () => {
  const { createInboxItem, answerInbox, syncInbox } = await import('./inbox.ts');
  const owner = randomUUID();
  const project = { id: 'gym', name: 'home-gym', apps: [] };
  const service = new ProjectReleaseService({} as any);
  const unregister = service.registerInbox();
  try {
    createInboxItem(
      owner,
      {
        id: 'pending',
        kind: 'rollback',
        title: 'Roll back?',
        text: 'Failed',
        from: 'warden',
        projectId: project.id,
        createdAt: new Date().toISOString(),
        state: 'waiting',
        actions: [{ id: 'rollback', label: 'Roll back' }],
      },
      { project },
    );
    putApprovalRules(owner, [{ id: 'never', agent: 'warden', action: 'rollback', mode: 'never' }]);
    assert.throws(
      () => answerInbox(owner, 'pending', { actionId: 'rollback', on: 'web' }),
      /forbidden/,
    );
    assert.equal(syncInbox(owner).find((item) => item.id === 'pending')?.state, 'waiting');
  } finally {
    unregister();
  }
});

test('schedule, triggers and coverage survive patching without granting permissions', async () => {
  const owner = randomUUID();
  const configuration = {
    name: 'Keeper',
    job: 'Watch disk space',
    computers: ['SER'],
    apps: ['home-gym'],
    schedule: { enabled: true, time: '08:00' },
    triggers: { mention: true, disk: true },
  };
  const created = await request(owner, '/agents', 'POST', configuration);
  assert.equal(created.status, 201);
  const patched = await request(owner, `/agents/${created.body.agent.id}`, 'PATCH', {
    job: 'Suggest clean-ups',
  });
  for (const key of ['schedule', 'triggers', 'apps'])
    assert.deepEqual(patched.body.agent[key], configuration[key as keyof typeof configuration]);
  assert.ok(approvalRules(owner).every((rule) => rule.mode === 'ask' && rule.action !== 'ship'));
  for (const body of [
    { schedule: { enabled: true, time: '25:00' } },
    { triggers: { mention: true, disk: 'yes' } },
    { apps: [3] },
  ])
    assert.equal(
      (await request(owner, `/agents/${created.body.agent.id}`, 'PATCH', body)).status,
      400,
    );
});
test('suggestions require four recent approved rollbacks and respect refusals and owner scope', async () => {
  const owner = randomUUID();
  const at = new Date().toISOString();
  const answered = (id: string, actionId = 'rollback', date = at) => {
    save('v2-inbox-native', owner, {
      id,
      item: {
        id,
        kind: 'rollback',
        from: 'warden',
        title: 'Rollback?',
        text: '',
        createdAt: date,
        state: 'answered',
        actions: [{ id: 'rollback', label: 'Roll back' }],
        answer: { actionId, by: owner, on: 'web', at: date },
      },
    });
  };
  for (let i = 0; i < 3; i++) answered(String(i));
  answered('old', 'rollback', '2020-01-01T00:00:00Z');
  assert.deepEqual((await request(owner, '/approvals')).body.suggestions, []);
  answered('four');
  assert.deepEqual((await request(owner, '/approvals')).body.suggestions, [
    { agent: 'warden', action: 'rollback', count: 4 },
  ]);
  assert.deepEqual((await request(randomUUID(), '/approvals')).body.suggestions, []);
  answered('declined', 'dismiss');
  assert.deepEqual((await request(owner, '/approvals')).body.suggestions, []);
});
test('legacy ship rules are excluded from the matrix and cannot be resaved', async () => {
  const owner = randomUUID();
  save('v2-approval', owner, { id: 'legacy', agent: 'scout', action: 'ship', mode: 'ask' });
  assert.deepEqual((await request(owner, '/approvals')).body.rules, []);
  assert.equal(
    (
      await request(owner, '/approvals', 'PUT', {
        rules: [{ id: 'legacy', agent: 'scout', action: 'ship', mode: 'ask' }],
      })
    ).status,
    400,
  );
});

test('tracking uses attributed tasks and linked issues and merged pull requests, isolated by owner', async () => {
  const owner = randomUUID();
  const at = new Date().toISOString();
  const agent = (await request(owner, '/agents', 'POST', { name: 'Fixer', job: 'Fix checks' })).body
    .agent;
  const quiet = (await request(owner, '/agents', 'POST', { name: 'Quiet', job: 'Wait' })).body
    .agent;
  save('worker', owner, { id: 'mac', name: 'MacBook Pro' });
  save('task', owner, {
    id: 'task',
    title: 'Self-release pipeline',
    status: 'running',
    workerId: 'mac',
    updatedAt: at,
  });
  save('run', owner, { id: 'run', taskId: 'task', agentId: agent.id, status: 'running' });
  save('issue', owner, {
    id: 'issue',
    title: 'Watch checks',
    status: 'open',
    taskIds: ['task'],
    projectId: 'deploy',
  });
  save('pull-request', owner, {
    id: 'pull',
    title: 'Fix checks',
    status: 'merged',
    taskIds: ['task'],
    mergedAt: at,
  });
  save('pull-request', owner, {
    id: 'old',
    title: 'Old work',
    status: 'merged',
    taskIds: ['task'],
    mergedAt: '2020-01-01T00:00:00Z',
  });
  const result = await request(owner, `/agents/${agent.id}/conversation`);
  assert.deepEqual(result.body.tracking, {
    running: [{ id: 'task', title: 'Self-release pipeline', computer: 'MacBook Pro', at }],
    watching: [{ id: 'issue', title: 'Watch checks', projectId: 'deploy' }],
    runs: [],
    shipped: [{ id: 'pull', title: 'Fix checks', at }],
  });
  assert.equal((await request(randomUUID(), `/agents/${agent.id}/conversation`)).status, 404);
  assert.deepEqual((await request(owner, `/agents/${quiet.id}/conversation`)).body.tracking, {
    running: [],
    watching: [],
    runs: [],
    shipped: [],
  });
});

test('always-yours and retired actions cannot be delegated, including legacy allows', async () => {
  const owner = randomUUID();
  for (const action of ['ship', 'use-screen', 'change-secrets', 'install', 'spend'] as const) {
    save('v2-approval', owner, { id: action, agent: 'scout', action, mode: 'allow' });
    assert.equal(isAllowed(owner, 'scout', action), false);
    for (const mode of ['ask', 'allow', 'never'])
      assert.equal(
        (
          await request(owner, '/approvals', 'PUT', {
            rules: [{ id: action, agent: 'scout', action, mode }],
          })
        ).status,
        400,
      );
  }
  assert.deepEqual((await request(owner, '/approvals')).body.rules, []);
});

test('agent controls are authenticated, owner scoped, and pause refuses new conversation work', async () => {
  const owner = randomUUID();
  const scout = (await request(owner, '/agents', 'POST', { name: 'Scout', job: 'Help' })).body.agent
    .id;
  assert.equal(
    (await request(owner, `/agents/${scout}/control`, 'PATCH', { paused: true, muteMinutes: 60 }))
      .status,
    200,
  );
  assert.equal((await request(owner, `/agents/${scout}/control`)).body.paused, true);
  assert.equal((await request(randomUUID(), `/agents/${scout}/control`)).status, 404);
  assert.equal(
    (await request(owner, '/agents/missing/control', 'PATCH', { paused: true })).status,
    404,
  );
  assert.equal(
    (await request(owner, `/agents/${scout}/conversation`, 'POST', { text: 'Start' })).status,
    409,
  );
  assert.equal((await request(owner, `/agents/${scout}/run`, 'POST')).status, 409);
  assert.equal(
    (await request(owner, `/agents/${scout}/control`, 'PATCH', { paused: false })).status,
    200,
  );
});

test('notification preferences API preserves owner isolation and validates mutations', async () => {
  const owner = randomUUID();
  assert.equal((await request(owner, '/notifications')).body.decisions, true);
  assert.equal(
    (
      await request(owner, '/notifications', 'PATCH', {
        decisions: false,
        quietHours: true,
        timeZone: 'America/New_York',
      })
    ).status,
    200,
  );
  assert.equal((await request(owner, '/notifications')).body.decisions, false);
  assert.equal((await request(randomUUID(), '/notifications')).body.decisions, true);
  assert.equal(
    (await request(owner, '/notifications', 'PATCH', { failingApps: 'no' })).status,
    400,
  );
  assert.equal((await request(owner, '/notifications', 'POST', {})).status, 405);
});

test('chat-first creation and explicit item confirmation preserve identity and owner scope', async () => {
  const owner = randomUUID();
  const avatar = { glyph: 'variant28', color: '#af61f2' };
  const created = await request(owner, '/agents', 'POST', { name: '  Notes  ', avatar });
  assert.equal(created.status, 201);
  assert.equal(created.body.agent.name, 'Notes');
  assert.equal(created.body.agent.job, '');
  assert.deepEqual(created.body.agent.looksAfter, []);
  const path = `/agents/${created.body.agent.id}`;
  const draft = {
    id: 'weekly',
    what: 'Draft notes',
    where: 'all-active',
    when: { every: 'week', day: 5, time: '16:00', timezone: 'America/New_York' },
    brings: 'message',
  };
  const patched = await request(owner, path, 'PATCH', { looksAfter: [draft] });
  assert.deepEqual(patched.body.agent.avatar, avatar);
  assert.equal(patched.body.agent.looksAfter[0].confirmedAt, undefined);
  assert.equal((await request(owner, `${path}/items/weekly/run`, 'POST')).status, 409);
  assert.equal((await request(randomUUID(), `${path}/items/weekly/confirm`, 'POST')).status, 404);
  const confirmed = await request(owner, `${path}/items/weekly/confirm`, 'POST');
  assert.equal(confirmed.status, 200);
  assert.ok(confirmed.body.agent.looksAfter[0].confirmedAt);
  assert.deepEqual((await request(owner, `${path}/items/weekly/runs`)).body.runs, []);
  assert.equal(list('task', owner).length, 0);
  assert.equal((await request(owner, '/agents', 'POST', { name: ' ' })).status, 400);
  assert.equal(
    (await request(owner, path, 'PATCH', { avatar: { ...avatar, glyph: 'variant36' } })).status,
    400,
  );
});
