import assert from 'node:assert/strict';
import test from 'node:test';
import { permissionBadge, permissionsHeadline, permissionLocalAction } from './node-permissions.ts';

test('badges never call an unknown or stale permission allowed', () => {
  assert.deepEqual(permissionBadge('on'), { tone: 'healthy', label: 'Allowed' });
  assert.equal(permissionBadge('needs-approval').tone, 'attention');
  assert.equal(permissionBadge('unknown').label, 'Unknown');
  assert.equal(permissionBadge('off').label, 'Off');
  assert.equal(permissionBadge('unavailable').tone, 'failed');
});

test('the computer row counts what is allowed and what waits on the owner', () => {
  const p = (state: any) => ({ id: state, label: state, state, summary: '' });
  assert.equal(permissionsHeadline([]), '');
  assert.equal(permissionsHeadline([p('on'), p('off'), p('unknown')]), '1 of 3 allowed');
  assert.equal(
    permissionsHeadline([p('on'), p('needs-approval')]),
    '1 of 2 allowed · 1 waiting for approval',
  );
});

test('each permission uses its own state words without hiding stale states', () => {
  for (const [id, on, off] of [
    ['screen', 'On', 'Off'],
    ['input', 'Allowed', 'View-only'],
    ['unlocked', 'Off (unattended)', 'On'],
    ['controlPaused', 'Allowed', 'Paused'],
    ['browser', 'Ready', 'Not installed'],
  ]) {
    assert.equal(permissionBadge('on', id).label, on);
    assert.equal(permissionBadge('off', id).label, off);
    assert.equal(permissionBadge('unknown', id).label, 'Unknown');
  }
  assert.equal(permissionBadge('unavailable', 'browser').label, 'Not installed');
});

test('local actions reverse allowed input/capture and install only a missing browser', () => {
  const permission = (id: string, state: any, summary = '') => ({ id, state, label: id, summary });
  assert.deepEqual(permissionLocalAction(permission('input', 'on')), {
    action: 'input-stop',
    label: 'Make view-only…',
  });
  assert.equal(permissionLocalAction(permission('input', 'off'))?.action, 'input');
  assert.equal(permissionLocalAction(permission('screen', 'on'))?.action, 'capture-stop');
  assert.equal(permissionLocalAction(permission('screen', 'off'))?.action, 'capture');
  assert.equal(permissionLocalAction(permission('unlocked', 'on'))?.action, 'lock-restore');
  assert.equal(permissionLocalAction(permission('unlocked', 'off'))?.action, 'lock-off');
  assert.equal(permissionLocalAction(permission('input', 'unknown')), undefined);
  assert.equal(permissionLocalAction(permission('browser', 'on')), undefined);
  assert.equal(
    permissionLocalAction(permission('browser', 'off', 'Browser control disabled')),
    undefined,
  );
  assert.deepEqual(
    permissionLocalAction(
      permission('browser', 'unavailable', 'Chromium isn’t installed for the task browser.'),
    ),
    { action: 'browser', label: 'Install Chromium (about 150 MB)' },
  );
});
