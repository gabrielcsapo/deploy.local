import assert from 'node:assert/strict';
import test from 'node:test';
import { computerRoles } from '../../../server/computer-roles.ts';
import { computerCredentials, removeComputer } from './computer-actions.ts';

const computer = computerRoles(
  [
    {
      id: 'desktop',
      name: 'Desktop',
      platform: 'linux',
      kind: 'agent',
      online: true,
      capabilities: '{}',
    },
  ],
  [{ id: 'node-worker-desktop', name: 'Desktop', platform: 'linux', status: 'online' }],
)[0];

test('removal names and revokes both credentials when a computer has both', async () => {
  assert.equal(
    computerCredentials(computer),
    'execution agent credential and task worker credential',
  );
  const calls: [string, string, unknown][] = [];
  await removeComputer(computer, async (url, method, body) => {
    calls.push([url, method, body]);
  });
  assert.deepEqual(
    calls.map(([url, method]) => [url, method]),
    [
      ['/api/nodes/desktop', 'DELETE'],
      ['/api/workspace/computers/node-worker-desktop/revoke', 'POST'],
    ],
  );
  assert.ok((calls[1][2] as { operationId: string }).operationId);
});

test('worker-only and node-only removals call only their existing endpoint', async () => {
  for (const target of [
    { ...computer, nodeId: undefined },
    { ...computer, workerIds: [] },
  ]) {
    const calls: string[] = [];
    await removeComputer(target, async (url) => {
      calls.push(url);
    });
    assert.equal(calls.length, 1);
    assert.equal(
      computerCredentials(target),
      target.nodeId ? 'execution agent credential' : 'task worker credential',
    );
  }
});

test('one failure still attempts the other credential and reports the failure; coordinator is protected', async () => {
  const calls: string[] = [];
  await assert.rejects(
    removeComputer(computer, async (url) => {
      calls.push(url);
      if (url.startsWith('/api/nodes')) throw new Error('Node unavailable');
    }),
    /Node unavailable/,
  );
  assert.equal(calls.length, 2);
  await assert.rejects(
    removeComputer(
      { ...computer, roles: { ...computer.roles, coordinator: { state: 'ready', reason: '' } } },
      async () => {
        assert.fail('Coordinator must not call a removal endpoint');
      },
    ),
    /coordinator cannot be removed/,
  );
});
