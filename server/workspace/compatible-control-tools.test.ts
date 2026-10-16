import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compatibleControlTools, controlCall } from './compatible-control-tools.ts';

test('compatible control operations retain coordinator identity and exact input', () => {
  assert.deepEqual(controlCall('deploy_control_list', {}), { action: 'list' });
  assert.deepEqual(controlCall('deploy_control_read', { sessionId: 's' }), {
    action: 'read',
    sessionId: 's',
  });
  const args = {
    sessionId: 's',
    generation: 'g',
    operationId: 'op',
    input: { type: 'scroll', x: 0, y: -250 },
  };
  assert.deepEqual(controlCall('deploy_control_input', args), { ...args, action: 'input' });
  assert.equal(controlCall('deploy_list_computers', {}), null);
  for (const definition of compatibleControlTools) {
    assert.deepEqual(
      new Set(definition.parameters.required ?? []),
      new Set(Object.keys(definition.parameters.properties)),
    );
  }
});

test('incomplete or extra control arguments are rejected without inventing authority', () => {
  for (const args of [
    {},
    { sessionId: 's' },
    { sessionId: 's', generation: 'g', operationId: 'op', input: [] },
  ])
    assert.throws(() => controlCall('deploy_control_input', args), /requires/);
  assert.throws(() => controlCall('deploy_control_list', { action: 'open' }), /Unexpected action/);
  assert.throws(
    () => controlCall('deploy_control_read', { sessionId: 's', toString: 'unexpected' }),
    /Unexpected toString/,
  );
});
