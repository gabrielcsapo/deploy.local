import type { CoordinatorStatus } from './tray-model.ts';
import type { DeploymentMessage } from '../../../server/deployment-notification-message.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketFromServerUnit, applySupervisorMessage } from './supervisor.ts';

test('DEPLOY_DATA_DIR in the server unit wins over its release working directory', () => {
  // As on SER: drop-ins move WorkingDirectory to each release but keep the data directory.
  assert.equal(
    socketFromServerUnit(
      'Environment=PATH=/usr/bin:/bin NODE_ENV=production DEPLOY_DATA_DIR=/home/u/Documents/deploy.local/.deploy-data\nWorkingDirectory=/home/u/.local/share/deploy.local/current\n',
    ),
    '/home/u/Documents/deploy.local/.deploy-data/supervisor.sock',
  );
  assert.equal(
    socketFromServerUnit(
      'Environment="DEPLOY_DATA_DIR=/srv/deploy data" NODE_ENV=production\nWorkingDirectory=/opt/x\n',
    ),
    '/srv/deploy data/supervisor.sock',
  );
});

test('without DEPLOY_DATA_DIR the socket is under the working directory, and nothing means null', () => {
  assert.equal(
    socketFromServerUnit('Environment=NODE_ENV=production\nWorkingDirectory=/opt/deploy/\n'),
    '/opt/deploy/.deploy-data/supervisor.sock',
  );
  assert.equal(socketFromServerUnit('Environment=\nWorkingDirectory=\n'), null);
  assert.equal(socketFromServerUnit(''), null);
});

test('supervisor monitor forwards valid deployment messages without storing or replaying them', () => {
  const state: CoordinatorStatus = { present: true, connected: true };
  const message: DeploymentMessage = {
    type: 'deployment',
    name: 'app',
    status: 'running',
    nodeId: 'b',
    nodeName: 'B',
    username: 'owner',
    at: 123,
  };
  const received: DeploymentMessage[] = [];
  const handle = (value: unknown) =>
    applySupervisorMessage(state, value, (notice) => received.push(notice));
  handle(message);
  handle({ ...message, status: 'invalid' });
  handle(null);
  handle({ type: 'status', children: [{ name: 'control', state: 'running' }] });
  handle({
    type: 'fleet',
    dockerReachable: true,
    running: 1,
    total: 1,
    cpuCores: 2,
    cpuPercent: 0,
    memUsageBytes: 1,
  });
  assert.deepEqual(received, [message]);
  assert.equal(state.status?.children[0].name, 'control');
  assert.equal(state.fleet?.running, 1);
  assert.ok(state.fleetAt);
});
