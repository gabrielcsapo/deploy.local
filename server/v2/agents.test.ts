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
const { db, save, list } = await import('../workspace/store.ts');
const { v2Api } = await import('./api.ts');
const { approvalRules, approvalActions, putApprovalRules, isAllowed, ProjectReleaseService } =
  await import('./releases.ts');
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
for (; port <= 5199; port++) {
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    break;
  } catch (error: any) {
    if (error.code !== 'EADDRINUSE') throw error;
  }
}
if (port > 5199) throw new Error('No test port available');
const origin = `http://127.0.0.1:${port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  db.close();
  rmSync(root, { recursive: true, force: true });
});
async function request(owner: string, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${origin}/api/v2${path}`, {
    method,
    headers: { 'x-test-owner': owner, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}
test('agents envelope, create defaults, patch and owner isolation', async () => {
  const owner = randomUUID();
  const initial = await request(owner, '/agents');
  assert.deepEqual(
    initial.body.agents.map((a: any) => a.id),
    ['scout', 'warden'],
  );
  const created = await request(owner, '/agents', 'POST', {
    name: 'Keeper',
    job: 'Watch disk space',
    computers: ['SER'],
  });
  assert.equal(created.status, 201);
  const agent = created.body.agent;
  assert.equal(agent.createdBy, owner);
  const rules = approvalRules(owner);
  assert.equal(rules.length, 8);
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
  assert.equal((await request('another', '/agents')).body.agents.length, 2);
  assert.equal(
    (await request(owner, `/agents/${agent.id}`, 'PATCH', { createdBy: 'another' })).status,
    400,
  );
  assert.equal(
    (await request(owner, '/agents', 'POST', { name: 'Bad', job: 'Job', computers: [3] })).status,
    400,
  );
  assert.equal((await request(owner, '/agents')).body.agents.length, 3);
});
test('built-in agents can be tuned but cannot be deleted or have identity overwritten', async () => {
  const owner = randomUUID();
  for (const agent of ['scout', 'warden']) {
    assert.equal((await request(owner, `/agents/${agent}`, 'DELETE')).status, 403);
    assert.equal(
      (await request(owner, `/agents/${agent}`, 'PATCH', { job: 'Ask before acting' })).status,
      200,
    );
    assert.equal((await request(owner, `/agents/${agent}`, 'PATCH', { id: 'gone' })).status, 400);
  }
  assert.equal((await request(owner, '/agents')).body.agents.length, 2);
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
    [{ ...rules[0], action: 'ship', mode: 'allow' }],
  ]) {
    assert.equal((await request(owner, '/approvals', 'PUT', { rules: invalid })).status, 400);
    assert.equal((await request(owner, '/approvals')).body.rules.length, 8);
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
