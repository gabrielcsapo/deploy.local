import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentNotification, type RecentNotification } from './notification-model.ts';
import type { DeploymentMessage } from '../../../server/deployment-notification-message.ts';

const message: DeploymentMessage = {
  type: 'deployment',
  name: 'app',
  status: 'building',
  nodeId: 'a',
  nodeName: 'Node A',
  username: 'owner',
  at: 1,
};
const history: RecentNotification[] = [
  { name: 'app', nodeId: 'a', status: 'building', shownAt: 1000 },
];

test('notification text and coalescing key for building, running and failed', () => {
  assert.deepEqual(deploymentNotification(message, [], 1000), {
    title: 'Deploying app to Node A…',
    key: 'app',
  });
  assert.deepEqual(deploymentNotification({ ...message, status: 'running' }, history, 2000), {
    title: 'app is running on Node A',
    key: 'app',
  });
  assert.deepEqual(deploymentNotification({ ...message, status: 'failed' }, history, 2000), {
    title: 'app failed on Node A',
    key: 'app',
  });
});

test('building appears once until completion; completion allows a later deploy', () => {
  assert.equal(deploymentNotification(message, history, 40_000), null);
  const completed = [...history, { ...history[0], status: 'running' as const, shownAt: 2000 }];
  assert.ok(deploymentNotification(message, completed, 40_000));
  assert.ok(deploymentNotification({ ...message, nodeId: 'b' }, history, 2000));
  assert.ok(deploymentNotification({ ...message, name: 'other' }, history, 2000));
});

test('duplicate statuses are suppressed for ten seconds using local arrival time', () => {
  for (const status of ['running', 'failed'] as const) {
    const recent = [{ ...history[0], status }];
    assert.equal(deploymentNotification({ ...message, status, at: 9999999 }, recent, 10_999), null);
    assert.ok(deploymentNotification({ ...message, status }, recent, 11_000));
  }
});
