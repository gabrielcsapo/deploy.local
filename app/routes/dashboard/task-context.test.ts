import assert from 'node:assert/strict';
import test from 'node:test';
import { taskComputerLabel, taskComputerNotice, taskProjectLabel } from './task-context.ts';

const mac = { id: 'mac', name: 'MacBook Pro', status: 'online', capabilities: ['codex'] };

test('an inventory that has not arrived leaves the repository unnamed, not absent', () => {
  assert.equal(taskProjectLabel(false, undefined, 'project-1'), '');
  assert.equal(taskProjectLabel(true, undefined, 'project-1'), 'No project');
  assert.equal(taskProjectLabel(false, undefined, null), 'No project');
  assert.equal(taskProjectLabel(false, { name: 'Pilot' }, 'project-1'), 'Pilot');
});

test('an unknown computer is reconnecting, and only a known one can be unavailable', () => {
  assert.equal(taskComputerLabel(false, undefined, null), 'Reconnecting…');
  assert.equal(taskComputerLabel(true, undefined, null), 'Computer unavailable');
  assert.equal(taskComputerLabel(false, undefined, 'mac'), 'mac');
  assert.equal(taskComputerLabel(true, mac, 'mac'), 'MacBook Pro');
});

test('offline is only claimed once the computer has had a chance to report', () => {
  // The inventory is still loading: an online computer must not be reported offline.
  assert.equal(taskComputerNotice(false, undefined, 'codex'), 'reconnecting');
  assert.equal(taskComputerNotice(false, mac, 'codex'), 'reconnecting');
  // The coordinator restarted and the computer has not registered again yet.
  assert.equal(
    taskComputerNotice(true, { ...mac, status: 'offline', reconnecting: true }, 'codex'),
    'reconnecting',
  );
  // Known and silent past the reconnect window really is offline.
  assert.equal(
    taskComputerNotice(true, { ...mac, status: 'offline', reconnecting: false }, 'codex'),
    'offline',
  );
  assert.equal(taskComputerNotice(true, undefined, 'codex'), 'offline');
  // Online, but without the chosen agent installed.
  assert.equal(taskComputerNotice(true, mac, 'claude'), 'provider');
  assert.equal(taskComputerNotice(true, mac, 'codex'), '');
  assert.equal(taskComputerNotice(true, { id: 'local', status: 'online' }, 'claude'), '');
});
