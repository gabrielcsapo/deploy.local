import test from 'node:test';
import assert from 'node:assert/strict';
import { setupNavigation, trustedSetupOrigin, redactLogs } from './setup-policy.ts';
const origin = 'https://deploy.local';
const local = 'file:///app/setup.html';
test('setup admits only its coordinator embed pages or exact local fallback; workspace links leave the app', () => {
  assert.equal(setupNavigation(local, origin, local), true);
  assert.equal(
    setupNavigation(origin + '/dashboard/embed/computers/worker#permission-screen', origin, local),
    true,
  );
  for (const target of [
    'https://other.local/dashboard/embed/computers',
    'https://deploy.local.evil.test/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    origin + '/dashboard/tasks',
    'https://user:secret@deploy.local/dashboard/embed/computers',
  ])
    assert.equal(setupNavigation(target, origin, local), false);
  assert.equal(
    trustedSetupOrigin('http://deploy.local/dashboard/embed/computers', origin, local),
    false,
  );
  assert.equal(setupNavigation(origin + '/custom', origin, local, '/custom'), true);
});
test('diagnostic logs redact credentials and authorization lines', () => {
  const result = redactLogs(
    'worker private-key\nnode_secret_123\nx-deploy-token: api-key\nAuthorization: Basic password\nserver started',
    ['private-key'],
  );
  assert.doesNotMatch(result, /private-key|node_secret_|api-key|Basic password/);
  assert.match(result, /server started/);
});
