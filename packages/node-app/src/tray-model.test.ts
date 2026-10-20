import test from 'node:test';
import assert from 'node:assert/strict';
import { readNodeStatus } from '../../../server/workspace/node-status.ts';
import { trayModel, coordinatorHealth } from './tray-model.ts';
import { desktopExec } from './linux-service.ts';
const absent = { present: false, connected: false };
test('tray shows enrollment/offline, unknown counts, permissions, pause and coordinator-only actions', async () => {
  const status = await readNodeStatus({ snapshot: null, paused: false, platform: 'linux' });
  const model = trayModel(status, absent);
  assert.match(model.items[0].label!, /Not enrolled/);
  assert.equal(model.color, 'red');
  assert.equal(
    model.items.some((item) => item.action === 'stop'),
    false,
  );
  assert.deepEqual(
    model.items.find((item) => item.submenu)?.submenu?.map((item) => item.action),
    ['screen', 'input', 'unlocked'],
  );
  const online = trayModel(
    { ...status, enrolled: true, online: true, runningTaskCount: 2 },
    absent,
  );
  assert.match(online.items[0].label!, /running 2 tasks/);
  assert.doesNotMatch(
    trayModel({ ...status, enrolled: true, online: true, runningTaskCount: null }, absent).items[0]
      .label!,
    /running/,
  );
  assert.match(trayModel({ ...status, enrolled: true }, absent).items[0].label!, /Offline/);
  const coordinator = trayModel(status, { present: true, connected: false });
  assert.equal(
    coordinator.items.some((item) => item.action === 'stop'),
    true,
  );
});
test('coordinator health matches existing tray semantics and drops stale fleet consumption', () => {
  const state = {
    present: true,
    connected: true,
    status: {
      children: [
        { name: 'edge', state: 'running' },
        { name: 'control', state: 'running' },
      ],
    },
    fleet: {
      dockerReachable: true,
      running: 2,
      total: 3,
      cpuCores: 2,
      cpuPercent: 8,
      memUsageBytes: 1024,
    },
    fleetAt: 1000,
  };
  assert.equal(coordinatorHealth(state, 1001).color, 'green');
  assert.equal(
    coordinatorHealth({ ...state, fleet: { ...state.fleet, dockerReachable: false } }, 1001).color,
    'orange',
  );
  assert.equal(
    coordinatorHealth(
      { ...state, status: { children: [{ name: 'edge', state: 'restarting' }] } },
      1001,
    ).color,
    'orange',
  );
  assert.equal(coordinatorHealth(state, 100000).fleet, undefined);
  assert.equal(coordinatorHealth({ ...state, connected: false }).color, 'red');
});
test('XDG Exec encoding protects literal paths and desktop field codes', () => {
  assert.equal(
    desktopExec(['/path with space/a%test', 'quote"$`\\']),
    '"/path with space/a%%test" "quote\\"\\$\\`\\\\"',
  );
  assert.throws(() => desktopExec(['newline\npath']));
});
