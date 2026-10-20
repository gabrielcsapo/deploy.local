import assert from 'node:assert/strict';
import test from 'node:test';
import { endedControlReason } from './control-session.ts';

test('ended control reasons use plain language and the recorded target label', () => {
  const cases = [
    ['stopped', 'Stopped by agent', 'The agent finished with SER desktop'],
    ['stopped', 'Stopped by user', 'You stopped this session'],
    [
      'suspended',
      'Worker, target, or capture/input permission changed',
      'The connection to SER desktop timed out',
    ],
    [
      'stopped',
      'Control connection expired. Inspect the target',
      'The connection to SER desktop timed out',
    ],
    [
      'suspended',
      'Interaction outcome uncertain: lost response',
      'The session stopped after an uncertain action',
    ],
    ['stopped', 'Unknown technical reason', 'This session ended'],
    ['stopped', null, 'This session ended'],
  ] as const;
  for (const [status, reason, expected] of cases)
    assert.equal(endedControlReason({ status, reason, targetLabel: 'SER desktop' }), expected);
  assert.equal(
    endedControlReason({
      status: 'stopped',
      reason: 'Stopped by agent',
      targetLabel: 'Task browser',
    }),
    'The agent finished with Task browser',
  );
});
