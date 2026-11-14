import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { sql } from 'drizzle-orm';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'computer-roles-api-'));
process.env.DEPLOY_DATA_DIR = directory;
await import('./test-ports.ts');
const store = await import('./store.ts');
const { patchComputerRoles } = await import('./computer-roles-api.ts');
const { save, get, now } = await import('./workspace/store.ts');
const { workerCommand } = await import('./workspace/protocol.ts');
const { interactiveWorker, interactiveRead, interactiveTool } =
  await import('./workspace/interactive.ts');
const { jobCommand, allComputerRoles } = await import('./workspace/coordination.ts');
const { assertWorkerRole } = await import('./workspace/computer-role-policy.ts');
after(() => {
  store._resetDb();
  rmSync(directory, { recursive: true, force: true });
});

const owner = 'owner';
const workerId = 'node-worker-fixture';
const instanceId = 'instance';
const setup = () => {
  save('worker', owner, {
    id: workerId,
    name: 'Fixture',
    platform: 'linux',
    architecture: 'x64',
    heartbeat: now(),
    instanceId,
    capabilities: ['codex', 'checkpoint-jobs'],
  });
};

test('coordinator startup uses hostname, upgrades Main Host, and preserves owner names in every projection', () => {
  const previousName = process.env.DEPLOY_NODE_NAME;
  delete process.env.DEPLOY_NODE_NAME;
  try {
    assert.equal(store.ensureCoordinatorNode().name, hostname());
    store.getDb().run(sql`UPDATE nodes SET name = 'Main Host' WHERE id = 'coordinator'`);
    assert.equal(store.ensureCoordinatorNode().name, hostname());
    assert.equal(allComputerRoles(owner).find((c) => c.id === 'coordinator')?.name, hostname());
    store.getDb().run(sql`UPDATE nodes SET name = 'Home server' WHERE id = 'coordinator'`);
    process.env.DEPLOY_NODE_NAME = 'Configured host';
    assert.equal(store.ensureCoordinatorNode().name, 'Home server');
    assert.equal(store.getNodes().find((n) => n.id === 'coordinator')?.name, 'Home server');
    assert.equal(allComputerRoles(owner).find((c) => c.id === 'coordinator')?.name, 'Home server');
    store.getDb().run(sql`UPDATE nodes SET name = 'Main Host' WHERE id = 'coordinator'`);
    assert.equal(store.ensureCoordinatorNode().name, 'Configured host');
    assert.equal(store.ensureCoordinatorNode().name, 'Configured host');
  } finally {
    if (previousName === undefined) delete process.env.DEPLOY_NODE_NAME;
    else process.env.DEPLOY_NODE_NAME = previousName;
  }
});

test('PATCH validates, merges independent switches, preserves enrollment and persists across reopening', () => {
  setup();
  const result = patchComputerRoles(owner, workerId, { tasks: false, computer: true });
  assert.equal(result.computer?.roles.tasks.state, 'off');
  assert.equal(result.computer?.roles.computer.state, 'needs-setup');
  assert.equal(get('worker', owner, workerId).id, workerId);
  patchComputerRoles(owner, workerId, { browser: true });
  assert.equal(store.getComputerRolePreferences(workerId).tasks, false);
  assert.throws(() => patchComputerRoles(owner, workerId, { coordinator: false }), /Invalid role/);
  assert.throws(() => patchComputerRoles(owner, 'missing', { tasks: false }), /Unknown computer/);
  store._resetDb();
  assert.equal(store.getComputerRolePreferences(workerId).tasks, false);
});

test('task roles block new runs and jobs while polling preserves an already active run', () => {
  setup();
  // Without a linked node record, the worker keeps its own computer identity.
  store.setComputerRolePreferences(workerId, { tasks: false });
  save('task', owner, { id: 'task', workspaceStatus: 'ready' });
  save('run', owner, { id: 'run', taskId: 'task', workerId, status: 'queued' });
  assert.deepEqual(workerCommand(owner, `/workers/${workerId}/poll`, { instanceId }), {
    run: null,
  });
  assert.deepEqual(jobCommand(owner, workerId, 'poll', { instanceId }), { job: null });
  assert.throws(() => assertWorkerRole(owner, workerId, 'tasks'), /tasks role is off/);
  store.setComputerRolePreferences(workerId, { tasks: true });
  assert.equal(workerCommand(owner, `/workers/${workerId}/poll`, { instanceId }).run.id, 'run');
  store.setComputerRolePreferences(workerId, { tasks: false });
  assert.equal(workerCommand(owner, `/workers/${workerId}/poll`, { instanceId }).run.id, 'run');
});

test('off control roles remove targets and requests give the specific reason', () => {
  setup();
  interactiveWorker(owner, workerId, 'poll', {
    instanceId,
    targets: [
      { id: 'browser', kind: 'browser', label: 'Browser', available: true },
      { id: 'desktop', kind: 'computer', label: 'Desktop', available: true },
    ],
  });
  store.setComputerRolePreferences(workerId, { computer: false, browser: true });
  assert.deepEqual(
    interactiveRead(owner, 'task').targets.map((t: any) => t.id),
    ['browser'],
  );
  store.setComputerRolePreferences(workerId, { browser: false });
  assert.deepEqual(interactiveRead(owner, 'task').targets, []);
  assert.throws(
    () =>
      interactiveTool(
        { owner, taskId: 'task', runId: 'run' },
        { action: 'request', operationId: 'request', workerId, targetId: 'browser' },
      ),
    /browser role is off/,
  );
});

test('migration preserves existing nodes, deploy off blocks placement/default/claims; enrollment carries roles', () => {
  store.ensureCoordinatorNode();
  store.setDefaultNode('coordinator');
  const enrollment = store.createNodeEnrollment('Server', owner, { deploy: false, tasks: true });
  const enrolled = store.redeemNodeEnrollment({ code: enrollment.code });
  assert.ok(enrolled.nodeId);
  assert.equal(store.getComputerRolePreferences(enrolled.nodeId!).deploy, false);
  assert.throws(() => store.setDefaultNode(enrolled.nodeId!), /deploy role is off/);
  store.enqueueAgentJob({
    nodeId: 'coordinator',
    type: 'deploy',
    deploymentName: 'fixture-app',
    payload: {},
  });
  const maintenance = store.enqueueAgentJob({
    nodeId: 'coordinator',
    type: 'backup',
    deploymentName: 'fixture-app',
    payload: {},
  });
  store.setComputerRolePreferences('coordinator', { deploy: false });
  assert.equal(store.getFleetPlacementState().ready, false);
  assert.throws(() => store.setDeploymentDesiredNode('app', 'coordinator'), /deploy role is off/);
  assert.throws(
    () =>
      store.enqueueAgentJob({
        nodeId: 'coordinator',
        type: 'deploy',
        deploymentName: 'fixture-app',
        payload: {},
      }),
    /deploy role is off/,
  );
  assert.equal(
    store.claimAgentJob('coordinator')?.id,
    maintenance.id,
    'existing apps can still be maintained with deployments off',
  );
  assert.equal(store.claimAgentJob('coordinator'), null);
  assert.ok(
    allComputerRoles(owner).some(
      (c) => c.id === 'coordinator' && c.roles.coordinator?.state === 'ready',
    ),
  );
});

test('owner HTTP route enforces authentication and validates PATCH bodies without opening a listener', async () => {
  const { Readable } = await import('node:stream');
  const { apiMiddleware } = await import('./api.ts');
  const { stopMetricsCollector } = await import('./metrics-collector.ts');
  const { stopDockerEventStream } = await import('./docker.ts');
  const ownerAuth = store.registerUser('fleet-owner', 'fixture-password');
  const memberAuth = store.registerUser('fleet-member', 'fixture-password');
  const api = apiMiddleware();
  async function call(
    body: unknown,
    auth?: { username: string; token: string },
    method = 'PATCH',
    path = '/api/computers/coordinator/roles',
  ) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      url: path,
      method,
      headers: {
        host: 'deploy.local',
        ...(auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {}),
      },
      socket: {},
    });
    let status = 0;
    let response: any;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        response = JSON.parse(value);
      },
    };
    await api(req as any, res as any, () => {
      throw new Error('Unexpected fallthrough');
    });
    return { status, body: response };
  }
  try {
    const auth = { username: 'fleet-owner', token: ownerAuth.token! };
    assert.equal((await call({ tasks: false })).status, 401);
    assert.equal(
      (await call({ tasks: false }, { username: 'fleet-member', token: memberAuth.token! })).status,
      403,
    );
    assert.equal((await call({ coordinator: false }, auth)).status, 400);
    assert.equal((await call({ tasks: 'yes' }, auth)).status, 400);
    assert.equal(
      (await call({ tasks: false }, auth, 'PATCH', '/api/computers/missing/roles')).status,
      404,
    );
    const changed = await call({ tasks: false, deploy: false }, auth);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.computer.roles.tasks.state, 'off');
    assert.equal(changed.body.computer.roles.coordinator.state, 'ready');
    const { workerCommand } = await import('./workspace/protocol.ts');
    workerCommand('fleet-owner', '/workers/register', {
      workerId: 'old-worker',
      platform: 'linux',
    });
    workerCommand('fleet-owner', '/workers/register', {
      workerId: 'missing-tools',
      platform: 'linux',
      build: { version: '1.0.0' },
      agentTools: ['deploy_checkpoint'],
    });
    const inventory = await call({}, auth, 'GET', '/api/computer-roles');
    assert.equal(inventory.status, 200);
    assert.equal(
      inventory.body.computers.find((c: any) => c.id === 'old-worker')?.update.state,
      'unknown',
    );
    assert.ok(
      inventory.body.computers
        .find((c: any) => c.id === 'missing-tools')
        ?.update.missingTools.includes('deploy_commit'),
    );
    assert.ok(inventory.body.computers.some((c: any) => c.id === 'coordinator'));
    const defaultChoice = await call({ nodeId: 'coordinator' }, auth, 'PUT', '/api/nodes/default');
    assert.equal(defaultChoice.status, 400);
    assert.match(defaultChoice.body.error, /deploy role is off/);
    const placement = await call({}, auth, 'GET', '/api/deploy-admission');
    assert.equal(placement.status, 200);
    assert.ok(!placement.body.nodes.some((node: any) => node.id === 'coordinator'));
    const enrollment = await call(
      { name: 'HTTP Node', roles: { deploy: false, tasks: true, computer: true, browser: false } },
      auth,
      'POST',
      '/api/nodes/enrollment',
    );
    assert.equal(enrollment.status, 201);
    const enrolled = await call(
      { code: enrollment.body.code },
      undefined,
      'POST',
      '/api/agent/enroll',
    );
    assert.equal(enrolled.status, 201);
    assert.deepEqual(enrolled.body.roles, {
      deploy: false,
      tasks: true,
      computer: true,
      browser: false,
    });
    assert.ok(enrolled.body.workerToken);
    for (const [name, roles, taskWorker, expected] of [
      ['legacy-agent', undefined, false, false],
      ['deploy-agent', { deploy: true, tasks: false }, false, false],
      ['explicit-worker', { deploy: false, tasks: false }, true, true],
      ['no-services', { deploy: false, tasks: false, computer: true, browser: true }, false, false],
    ] as const) {
      const code = store.createNodeEnrollment(name, 'fleet-owner', roles).code;
      const result = await call({ code, taskWorker }, undefined, 'POST', '/api/agent/enroll');
      assert.equal(result.status, 201);
      assert.equal(!!result.body.workerToken, expected, name);
      assert.equal(result.body.roles.tasks, false);
      assert.equal(typeof result.body.roles.deploy, 'boolean');
      assert.equal(typeof result.body.roles.computer, 'boolean');
      assert.equal(typeof result.body.roles.browser, 'boolean');
    }
    const statusRequest = Object.assign(Readable.from([]), {
      url: '/api/agent/status',
      method: 'GET',
      headers: {
        'x-deploy-node-id': enrolled.body.nodeId,
        'x-deploy-node-secret': enrolled.body.secret,
      },
      socket: {},
    });
    let statusBody: any;
    const nodeBefore = store.getNode(enrolled.body.nodeId);
    await api(
      statusRequest as any,
      {
        writeHead(code: number) {
          assert.equal(code, 200);
        },
        end(value: string) {
          statusBody = JSON.parse(value);
        },
      } as any,
      () => assert.fail('Unexpected status fallthrough'),
    );
    assert.deepEqual(statusBody.roles, enrolled.body.roles);
    assert.equal(store.getNode(enrolled.body.nodeId)?.lastSeenAt, nodeBefore?.lastSeenAt);
    assert.doesNotMatch(JSON.stringify(statusBody), /secret|token|credential/i);
    assert.equal((await call({}, undefined, 'GET', '/api/agent/status')).status, 401);

    assert.equal(enrolled.body.workerId, `node-worker-${enrolled.body.nodeId}`);
    workerCommand('fleet-owner', '/workers/register', {
      workerId: enrolled.body.workerId,
      instanceId: 'http-worker',
      name: 'HTTP Node',
      platform: 'linux',
      codex: true,
    });
    const joined = allComputerRoles('fleet-owner').find((c) => c.id === enrolled.body.nodeId)!;
    assert.deepEqual(joined.workerIds, [enrolled.body.workerId]);
    assert.equal(joined.roles.deploy.state, 'off');
    assert.equal(joined.roles.browser.state, 'off');
    patchComputerRoles('fleet-owner', joined.id, { tasks: false });
    assert.throws(
      () => assertWorkerRole('fleet-owner', enrolled.body.workerId, 'tasks'),
      /tasks role is off/,
    );
  } finally {
    stopMetricsCollector();
    stopDockerEventStream();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stopDockerEventStream();
  }
});
