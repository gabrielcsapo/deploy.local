import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodePermissions, type PermissionInputs } from './node-permissions.ts';

process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-node-permissions-test-'));
const { save, list, id, now } = await import('./store.ts');
const { interactiveWorker, interactiveOperator } = await import('./interactive.ts');
const { computers, revokeWorker } = await import('./coordination.ts');
const { enrollWorker } = await import('./credentials.ts');

const linuxDesktop = (status: any = {}) => ({
  id: 'desktop',
  kind: 'computer',
  available: true,
  viewOnly: true,
  reason: 'Desktop capture is view-only.',
  desktopStatus: {
    available: true,
    sessionType: 'wayland',
    desktop: 'GNOME',
    grantStored: true,
    screenLock: { locks: true, idleSeconds: 300, changedByDeploy: false },
    ...status,
  },
});
const inputs = (extra: Partial<PermissionInputs> = {}): PermissionInputs => ({
  worker: { id: 'ser', name: 'ser', platform: 'linux', status: 'online' },
  managed: false,
  targets: [],
  fresh: true,
  browserProjects: [],
  ...extra,
});
const byId = (permissions: any[]) => Object.fromEntries(permissions.map((p) => [p.id, p]));

test('every desktop grant is a step on the computer; only revoking happens here', () => {
  const states = [
    [],
    [linuxDesktop({ grantStored: false })],
    [linuxDesktop({ inputAllowed: true })],
    [linuxDesktop({ screenLock: { locks: false, changedByDeploy: true } })],
    [
      {
        id: 'display-1',
        kind: 'computer',
        available: false,
        permissions: { screenRecording: false, accessibility: false, unlocked: true },
      },
    ],
  ];
  for (const targets of states)
    for (const platform of ['linux', 'darwin'])
      for (const permission of nodePermissions(
        inputs({ targets, worker: { id: 'w', name: 'w', platform, status: 'online' } }),
      )) {
        if (permission.step?.where !== 'here') continue;
        // Revoke takes access away; project settings only cover the headless task browser.
        assert.ok(
          (permission.id === 'tasks' && permission.step.action === 'revoke-worker') ||
            (permission.id === 'browser' && permission.step.action === 'project-settings'),
          `${permission.id} must not be granted from the coordinator`,
        );
      }
});

test('Linux desktop walks from not installed, to approval, to on', () => {
  let p = byId(nodePermissions(inputs()));
  assert.equal(p.screen.state, 'off');
  assert.equal(byId(nodePermissions(inputs({ fresh: false }))).screen.state, 'unknown');
  assert.equal(p.screen.step.command, 'deploy desktop-helper setup');
  assert.equal(p.input, undefined, 'no input row before the helper exists');

  p = byId(nodePermissions(inputs({ targets: [linuxDesktop({ grantStored: false })] })));
  assert.equal(p.screen.state, 'needs-approval');
  assert.equal(p.screen.step.command, 'deploy desktop-helper setup');

  p = byId(nodePermissions(inputs({ targets: [linuxDesktop()] })));
  assert.equal(p.screen.state, 'on');
  assert.equal(p.screen.step.command, 'deploy desktop-helper uninstall');
  assert.equal(p.input.state, 'off');
  assert.equal(p.input.step, undefined, 'a helper without input support gets no command');

  p = byId(nodePermissions(inputs({ targets: [linuxDesktop({ inputAllowed: false })] })));
  assert.equal(p.input.state, 'off');
  assert.equal(p.input.step.command, 'deploy desktop-helper install --allow-input');
  assert.match(p.input.step.instruction, /approve the remote-desktop dialog on ser/);

  p = byId(nodePermissions(inputs({ targets: [linuxDesktop({ inputAllowed: true })] })));
  assert.equal(p.input.state, 'on');
  assert.equal(p.input.step.command, 'deploy desktop-helper install');

  p = byId(nodePermissions(inputs({ targets: [linuxDesktop()], fresh: false })));
  assert.equal(p.screen.state, 'unknown', 'stale inventory is not reported as on');

  p = byId(
    nodePermissions(
      inputs({
        targets: [
          { ...linuxDesktop(), desktopStatus: { available: false, reason: 'Missing pipewiresrc' } },
        ],
      }),
    ),
  );
  assert.equal(p.screen.state, 'unavailable');
  assert.equal(p.screen.summary, 'Missing pipewiresrc');
});

test('staying unlocked warns, and restore uses the command only when deploy changed it', () => {
  let p = byId(nodePermissions(inputs({ targets: [linuxDesktop()] })));
  assert.equal(p.unlocked.state, 'off');
  assert.match(p.unlocked.summary, /Locks after 5 minutes idle/);
  assert.equal(p.unlocked.step.command, 'deploy desktop-helper screen-lock off');
  assert.match(p.unlocked.step.instruction, /without a password/);

  p = byId(
    nodePermissions(
      inputs({ targets: [linuxDesktop({ screenLock: { locks: false, changedByDeploy: true } })] }),
    ),
  );
  assert.equal(p.unlocked.state, 'on');
  assert.equal(p.unlocked.step.command, 'deploy desktop-helper screen-lock restore');

  p = byId(
    nodePermissions(
      inputs({ targets: [linuxDesktop({ screenLock: { locks: false, changedByDeploy: false } })] }),
    ),
  );
  assert.equal(p.unlocked.step.command, undefined);

  p = byId(nodePermissions(inputs({ targets: [linuxDesktop({ screenLock: { locks: null } })] })));
  assert.equal(p.unlocked.state, 'unknown');
});

test('macOS shows each privacy permission separately', () => {
  const mac = (permissions?: any) =>
    byId(
      nodePermissions(
        inputs({
          worker: { id: 'mac', name: 'MacBook', platform: 'darwin', status: 'online' },
          targets: permissions
            ? [{ id: 'display-1', kind: 'computer', available: false, permissions }]
            : [],
        }),
      ),
    );
  let p = mac();
  assert.equal(p.screen.state, 'off');
  assert.equal(
    byId(
      nodePermissions(inputs({ fresh: false, worker: { ...inputs().worker, platform: 'darwin' } })),
    ).screen.state,
    'unknown',
  );
  assert.match(p.screen.step.instruction, /Install Deploy\.app/);

  p = mac({ screenRecording: true, accessibility: false, unlocked: false });
  assert.equal(p.screen.state, 'on');
  assert.equal(p.input.state, 'off');
  assert.match(p.input.step.instruction, /Privacy & Security › Accessibility › Deploy/);
  assert.equal(p.unlocked.state, 'off');
  assert.match(p.unlocked.summary, /Locked now/);
});

test('task browser names the projects that skip approval; managed workers are not revoked here', () => {
  const p = byId(
    nodePermissions(
      inputs({
        managed: true,
        browserProjects: ['tally'],
        targets: [{ id: 'managed-browser', kind: 'browser', available: true }],
      }),
    ),
  );
  assert.equal(p.browser.state, 'on');
  assert.match(p.browser.summary, /Always allowed in tally/);
  assert.equal(p.tasks.step.where, 'computer');
  assert.match(p.tasks.step.instruction, /Settings/);
  assert.equal(
    byId(nodePermissions(inputs({ worker: { ...inputs().worker, id: 'local' } }))).tasks.step,
    undefined,
  );
});

test('a polled worker reports permissions; revoking removes it and ends its sessions', () => {
  const owner = id(),
    instanceId = id(),
    taskId = id();
  enrollWorker(owner, { workerId: 'ser' });
  save('worker', owner, {
    id: 'ser',
    instanceId,
    name: 'ser',
    platform: 'linux',
    architecture: 'x64',
    capabilities: ['git'],
    heartbeat: now(),
  });
  save('task', owner, { id: taskId });
  const browser = {
    id: 'managed-browser',
    kind: 'browser',
    label: 'Task browser',
    available: true,
  };
  const desktop = {
    ...linuxDesktop({
      // A token never leaves the computer, and unknown fields are dropped.
      restoreToken: 'secret',
      screenLock: { locks: true, idleSeconds: 300, extra: 'x' },
    }),
    label: 'ser desktop',
  };
  const poll = () =>
    interactiveWorker(owner, 'ser', 'poll', { instanceId, targets: [browser, desktop] });
  poll();
  const computer = computers(owner).find((w) => w.id === 'ser')!;
  assert.doesNotMatch(JSON.stringify(computer), /secret/);
  const p = byId(computer.permissions);
  assert.equal(p.screen.state, 'on');
  assert.match(p.unlocked.summary, /5 minutes/);
  assert.equal(p.tasks.step.action, 'revoke-worker');

  const session = interactiveOperator(owner, taskId, 'open', {
    operationId: id(),
    clientId: id(),
    workerId: 'ser',
    targetId: 'managed-browser',
  });
  revokeWorker(owner, 'ser');
  assert.equal(list('worker-credential', owner).length, 0);
  assert.ok(!computers(owner).some((w) => w.id === 'ser'));
  assert.equal(list('worker', owner)[0].name, 'ser', 'task history keeps the record');
  assert.equal(
    list('interactive-session', owner).find((s) => s.id === session.id).status,
    'suspended',
  );
  assert.throws(() => revokeWorker(owner, 'local'), /can’t be revoked/);
  save('managed-worker', owner, { id: 'managed-1' });
  save('worker', owner, { id: 'managed-1', name: 'coordinator', platform: 'linux' });
  assert.throws(() => revokeWorker(owner, 'managed-1'), /Settings/);
});
