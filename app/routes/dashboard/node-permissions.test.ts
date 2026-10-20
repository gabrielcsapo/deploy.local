import assert from 'node:assert/strict';
import test from 'node:test';
import { permissionBadge, permissionsHeadline } from './node-permissions.ts';

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
