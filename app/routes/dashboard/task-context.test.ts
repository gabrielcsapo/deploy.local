import assert from 'node:assert/strict';
import test from 'node:test';
import { taskComputerLabel, taskComputerNotice, taskProjectLabel } from './task-context.ts';

const mac = { id: 'mac', name: 'MacBook Pro', status: 'online', capabilities: ['codex'] };
/** The task's detail has arrived; only `/state` is still out, or in. */
const waiting = { task: true, inventory: false };
const loaded = { task: true, inventory: true };
/** A deep link on first paint: neither read has answered. */
const cold = { task: false, inventory: false };
/** `/state` won the race, so the inventory is known but the open task is not. */
const inventoryFirst = { task: false, inventory: true };

test('a task whose own detail has not arrived says nothing about its project or computer', () => {
  for (const known of [cold, inventoryFirst]) {
    assert.equal(taskProjectLabel(known, undefined, undefined), '');
    assert.equal(taskComputerLabel(known, undefined, undefined), '');
    assert.equal(taskComputerNotice(known, undefined, 'codex'), '');
    // Not even a stale computer from the inventory may be dressed up as the task's own.
    assert.equal(taskComputerLabel(known, mac, 'mac'), '');
  }
});

test('an inventory that has not arrived leaves the repository unnamed, not absent', () => {
  assert.equal(taskProjectLabel(waiting, undefined, 'project-1'), '');
  assert.equal(taskProjectLabel(loaded, undefined, 'project-1'), 'No project');
  assert.equal(taskProjectLabel(waiting, undefined, null), 'No project');
  assert.equal(taskProjectLabel(waiting, { name: 'Pilot' }, 'project-1'), 'Pilot');
});

test('an unknown computer is reconnecting, and only a known one can be unavailable', () => {
  assert.equal(taskComputerLabel(waiting, undefined, null), 'Reconnecting…');
  assert.equal(taskComputerLabel(loaded, undefined, null), 'Computer unavailable');
  assert.equal(taskComputerLabel(waiting, undefined, 'mac'), 'mac');
  assert.equal(taskComputerLabel(loaded, mac, 'mac'), 'MacBook Pro');
});

test('offline is only claimed once the computer has had a chance to report', () => {
  // The inventory is still loading: an online computer must not be reported offline.
  assert.equal(taskComputerNotice(waiting, undefined, 'codex'), 'reconnecting');
  assert.equal(taskComputerNotice(waiting, mac, 'codex'), 'reconnecting');
  // The coordinator restarted and the computer has not registered again yet.
  assert.equal(
    taskComputerNotice(loaded, { ...mac, status: 'offline', reconnecting: true }, 'codex'),
    'reconnecting',
  );
  // Known and silent past the reconnect window really is offline.
  assert.equal(
    taskComputerNotice(loaded, { ...mac, status: 'offline', reconnecting: false }, 'codex'),
    'offline',
  );
  assert.equal(taskComputerNotice(loaded, undefined, 'codex'), 'offline');
  // Online, but without the chosen agent installed.
  assert.equal(taskComputerNotice(loaded, mac, 'claude'), 'provider');
  assert.equal(taskComputerNotice(loaded, mac, 'codex'), '');
  assert.equal(taskComputerNotice(loaded, { id: 'local', status: 'online' }, 'claude'), '');
});
