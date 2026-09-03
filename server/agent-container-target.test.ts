import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAgentContainerName } from './agent-container-target.ts';

test('agent jobs accept an exact graph container and preserve the legacy fallback', () => {
  assert.equal(resolveAgentContainerName('Notes'), 'deploy-sh-notes');
  assert.equal(
    resolveAgentContainerName('Notes', 'deploy-sh-notes-worker-2-a1b2c3d4-instance'),
    'deploy-sh-notes-worker-2-a1b2c3d4-instance',
  );
  assert.throws(() => resolveAgentContainerName('Notes', 'postgres'), /override is invalid/);
  assert.throws(
    () => resolveAgentContainerName('Notes', 'deploy-sh-notes;rm-everything'),
    /override is invalid/,
  );
});
