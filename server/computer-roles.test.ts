import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computerRoles,
  parseWantedRoles,
  type RoleNode,
  type RoleWorker,
} from './computer-roles.ts';

const node: RoleNode = {
  id: 'coordinator',
  name: 'SER',
  platform: 'linux',
  kind: 'coordinator',
  online: true,
  capabilities: '{"docker":true}',
};
const worker: RoleWorker = {
  id: 'managed-ser',
  managed: true,
  name: 'SER worker',
  platform: 'linux',
  status: 'online',
  connections: [{ available: true }],
  permissions: [
    { id: 'screen', label: 'Screen', state: 'on', summary: 'Capture ready' },
    { id: 'browser', label: 'Browser', state: 'on', summary: 'Browser ready' },
  ],
};

test('joins managed and node-app workers, preserves independent worker identities', () => {
  const computers = computerRoles(
    [node, { ...node, kind: 'agent', id: 'bazzite', name: 'Bazzite' }],
    [
      worker,
      { ...worker, managed: false, id: 'node-worker-bazzite' },
      { ...worker, managed: false, id: 'mac', platform: 'darwin' },
    ],
  );
  assert.deepEqual(
    computers.map((c) => [c.id, c.workerIds]),
    [
      ['coordinator', ['managed-ser']],
      ['bazzite', ['node-worker-bazzite']],
      ['mac', ['mac']],
    ],
  );
  assert.equal(computers[0].roles.coordinator?.state, 'ready');
  assert.equal(computers[2].roles.deploy.state, 'off');
  for (const role of ['deploy', 'tasks', 'computer', 'browser'] as const)
    assert.equal(computers[0].roles[role].state, 'ready');
});

test('roles default from existing evidence, stay independent, and missing requirements explain setup', () => {
  const computer = computerRoles(
    [{ ...node, online: false, capabilities: '{}' }],
    [{ ...worker, status: 'offline', connections: [] }],
    { coordinator: { deploy: true, tasks: true, computer: false, browser: true } },
  )[0];
  assert.equal(computer.online, false);
  assert.equal(computer.roles.deploy.state, 'needs-setup');
  assert.match(computer.roles.deploy.reason, /offline/);
  assert.equal(computer.roles.tasks.state, 'needs-setup');
  assert.equal(computer.roles.computer.state, 'off');
  assert.equal(computer.roles.browser.state, 'needs-setup');
  const signedOut = computerRoles([node], [{ ...worker, connections: [{ available: false }] }])[0];
  assert.match(signedOut.roles.tasks.reason, /Sign in/);
  assert.equal(
    computerRoles(
      [{ ...node, capabilities: '{"docker":false,"dockerError":"Socket unavailable"}' }],
      [],
    )[0].roles.deploy.reason,
    'Socket unavailable',
  );
  assert.equal(
    computerRoles([], [{ ...worker, permissions: [], managed: false }])[0].roles.computer.state,
    'off',
  );
});

test('pause affects screen and browser independently of tasks and explicit off wins', () => {
  const paused: RoleWorker = {
    ...worker,
    permissions: [
      ...worker.permissions!,
      { id: 'controlPaused', label: 'Control', state: 'off', summary: 'Paused' },
    ],
  };
  const roles = computerRoles([node], [paused], { coordinator: { browser: false } })[0].roles;
  assert.equal(roles.computer.state, 'paused');
  assert.equal(roles.browser.state, 'off');
  assert.equal(roles.tasks.state, 'ready');
});

test('role patches reject unknown roles and nonboolean values including coordinator', () => {
  for (const value of [null, [], { coordinator: false }, { tasks: 'true' }, { deploy: null }])
    assert.throws(() => parseWantedRoles(value));
  assert.deepEqual(parseWantedRoles({ tasks: false, computer: true }), {
    tasks: false,
    computer: true,
  });
});

test('offline inventory preserves wanted control roles and reports setup instead of switching them off', () => {
  const offline: RoleWorker = {
    ...worker,
    managed: false,
    status: 'offline',
    controlKinds: ['computer', 'browser'],
    permissions: worker.permissions!.map((p) => ({ ...p, state: 'unknown' })),
  };
  const roles = computerRoles([], [offline])[0].roles;
  assert.equal(roles.computer.state, 'needs-setup');
  assert.equal(roles.browser.state, 'needs-setup');
  assert.match(roles.browser.reason, /offline/);
});
