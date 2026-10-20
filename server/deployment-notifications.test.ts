import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeploymentNotifications,
  normalizeDeploymentNotification,
} from './deployment-notifications.ts';
import { isDeploymentMessage, type DeploymentMessage } from './deployment-notification-message.ts';

const event = { type: 'deployment:status', deploymentName: 'app', data: { status: 'building' } };
const lookup = {
  deployment: () => ({ username: 'owner', activeNodeId: 'a', desiredNodeId: 'b' }),
  node: (id: string) => ({ name: `Node ${id}` }),
};
const message: DeploymentMessage = {
  type: 'deployment',
  name: 'app',
  status: 'building',
  nodeId: 'a',
  nodeName: 'Node a',
  username: 'owner',
  at: 123,
};

test('normalizes only deployment building/running/failed into a small allowlisted message', () => {
  for (const status of ['building', 'running', 'failed']) {
    assert.deepEqual(
      normalizeDeploymentNotification(
        { ...event, data: { status, logs: 'private', env: 'secret' } },
        lookup,
        123,
      ),
      { ...message, status },
    );
  }
  for (const status of [
    'uploading',
    'starting',
    'stopped',
    'backing-up',
    'restoring',
    'configuration-required',
    undefined,
  ]) {
    assert.equal(normalizeDeploymentNotification({ ...event, data: { status } }, lookup), null);
  }
  for (const source of ['startup', 'sync', 'restart', 'recreate']) {
    assert.equal(
      normalizeDeploymentNotification({ ...event, data: { status: 'running', source } }, lookup),
      null,
    );
  }
  assert.equal(normalizeDeploymentNotification({ ...event, type: 'build:output' }, lookup), null);
  assert.equal(normalizeDeploymentNotification(event, { ...lookup, deployment: () => null }), null);
});

test('resolves explicit target, active node, desired node and coordinator in order', () => {
  assert.equal(normalizeDeploymentNotification(event, lookup)?.nodeId, 'a');
  assert.deepEqual(
    normalizeDeploymentNotification(
      { ...event, data: { status: 'failed', nodeId: 'c', username: 'actor' } },
      lookup,
      123,
    ),
    { ...message, status: 'failed', nodeId: 'c', nodeName: 'Node c', username: 'actor' },
  );
  assert.equal(
    normalizeDeploymentNotification(event, {
      ...lookup,
      deployment: () => ({ username: 'owner', desiredNodeId: 'b' }),
    })?.nodeId,
    'b',
  );
  const coordinator = normalizeDeploymentNotification(
    event,
    { deployment: () => ({ username: 'owner' }), node: () => null },
    123,
  );
  assert.deepEqual(coordinator, { ...message, nodeId: 'coordinator', nodeName: 'coordinator' });
  assert.ok(isDeploymentMessage(coordinator));
  for (const value of [
    null,
    {},
    { ...message, at: '123' },
    { ...message, status: 'stopped' },
    { ...message, name: '' },
  ])
    assert.equal(isDeploymentMessage(value), false);
});

class Response extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  lines: string[] = [];
  stalled = false;
  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
  }
  write(line: string) {
    this.lines.push(line);
    return !this.stalled;
  }
  end(line?: string) {
    if (line) this.lines.push(line);
    this.emit('close');
  }
  destroy() {
    this.emit('close');
  }
}

test('node SSE uses enrolled credentials, delivers to deploy computers, replaces the oldest stream and releases closed slots', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-events-'));
  const previousDataDir = process.env.DEPLOY_DATA_DIR;
  process.env.DEPLOY_DATA_DIR = directory;
  const store = await import('./store.ts');
  const hub = new DeploymentNotifications();
  const responses: Response[] = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    store.registerUser('owner', 'password');
    const enroll = (name: string) =>
      store.redeemNodeEnrollment({ code: store.createNodeEnrollment(name, 'owner').code });
    const a = enroll('A');
    const b = enroll('B');
    assert.ok(a.nodeId && a.secret && b.nodeId && b.secret);
    const open = (headers: Record<string, string> = {}) => {
      const response = new Response();
      responses.push(response);
      hub.stream(
        { headers } as IncomingMessage,
        response as unknown as ServerResponse,
        store.authenticateNode,
        store.deployRoleEnabled,
      );
      return response;
    };
    for (const headers of [
      {},
      { 'x-deploy-node-id': a.nodeId },
      { 'x-deploy-node-id': a.nodeId, 'x-deploy-node-secret': 'wrong' },
    ]) {
      assert.equal(open(headers as Record<string, string>).status, 401);
    }
    const headersA = { 'x-deploy-node-id': a.nodeId, 'x-deploy-node-secret': a.secret };
    const first = open(headersA);
    const second = open(headersA);
    const other = open({ 'x-deploy-node-id': b.nodeId, 'x-deploy-node-secret': b.secret });
    assert.equal(first.status, 200);
    assert.equal(first.headers['Content-Type'], 'text/event-stream');
    assert.deepEqual(first.lines, [': connected\n\n']);
    // A third stream for A replaces the oldest instead of locking the node out.
    let firstClosed = false;
    first.once('close', () => (firstClosed = true));
    const third = open(headersA);
    assert.equal(third.status, 200);
    assert.ok(firstClosed, 'the oldest stream for a node is replaced');
    hub.publish({ ...message, nodeId: b.nodeId, name: 'only-b' });
    hub.publish({ ...message, nodeId: a.nodeId, name: 'only-a' });
    assert.equal(first.lines.length, 1, 'a replaced stream receives nothing more');
    assert.equal(second.lines.length, 3);
    assert.equal(other.lines.length, 3);
    assert.ok(second.lines[2].includes('only-a'));
    assert.ok(second.lines[1].includes('only-b'));
    assert.ok(other.lines[1].includes('only-b'));
    assert.ok(other.lines[2].includes('only-a'));
    store.setComputerRolePreferences(b.nodeId!, { deploy: false });
    hub.publish({ ...message, name: 'deploy-off' });
    assert.equal(other.lines.length, 3, 'an off computer receives no new notifications');
    assert.equal(second.lines.length, 4);
    t.mock.timers.tick(25_000);
    assert.equal(second.lines.at(-1), ': heartbeat\n\n');
    third.destroy();
    first.end();
    second.destroy();
    const replacement = open(headersA);
    assert.equal(replacement.status, 200);
    assert.deepEqual(replacement.lines, [': connected\n\n']);
    const before = first.lines.length;
    hub.publish({ ...message, nodeId: a.nodeId });
    assert.equal(first.lines.length, before);
    replacement.stalled = true;
    hub.publish({ ...message, nodeId: a.nodeId });
    assert.equal(open(headersA).status, 200);
    store.revokeNode(a.nodeId);
    assert.equal(open(headersA).status, 401);
    t.mock.timers.tick(25_000);
    const closedAt = replacement.lines.length;
    hub.publish({ ...message, nodeId: a.nodeId });
    assert.equal(replacement.lines.length, closedAt);
  } finally {
    for (const response of responses) response.end();
    store._resetDb();
    if (previousDataDir === undefined) delete process.env.DEPLOY_DATA_DIR;
    else process.env.DEPLOY_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the coordinator receives notifications even with its deploy role off', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const hub = new DeploymentNotifications();
  const response = new Response();
  hub.stream(
    {
      headers: { 'x-deploy-node-id': 'coordinator', 'x-deploy-node-secret': 'fixture' },
    } as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    (id) => id === 'coordinator',
    () => false,
  );
  try {
    hub.publish(message);
    assert.equal(response.lines.length, 2);
    assert.ok(response.lines[1].includes(message.name));
  } finally {
    response.end();
  }
});
