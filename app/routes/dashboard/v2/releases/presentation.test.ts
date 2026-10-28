import test from 'node:test';
import assert from 'node:assert/strict';
import { missingVariable } from './presentation.ts';
test('failure action carries the missing variable key without guessing for other failures', () => {
  assert.equal(
    missingVariable('Error: REST_SOUNDS_URL is not set\n  at loadConfig'),
    'REST_SOUNDS_URL',
  );
  assert.equal(missingVariable('Missing environment variable: API_KEY'), 'API_KEY');
  assert.equal(missingVariable('GET /healthz returned 500'), undefined);
});
