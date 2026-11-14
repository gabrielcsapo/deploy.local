import test from 'node:test';
import assert from 'node:assert/strict';
import { returnPath } from './return-path.ts';

test('sign-in returns to dashboard or an opaque npm login page only', () => {
  const path = '/packages/npm-login/' + 'a'.repeat(43);
  assert.equal(returnPath(path), path);
  assert.equal(returnPath('/dashboard/packages?tab=setup'), '/dashboard/packages?tab=setup');
  for (const value of [
    '//elsewhere.test' + path,
    'https://elsewhere.test' + path,
    '/packages/npm-login/short',
    path + '/extra',
    '/packages/npm-login/' + '%61'.repeat(43),
    '/packages/other',
    '/dashboard-elsewhere',
    '/dashboard\\elsewhere',
    '/dashboard\n',
    '/dashboard/../packages/other',
  ])
    assert.equal(returnPath(value), '/dashboard');
});
