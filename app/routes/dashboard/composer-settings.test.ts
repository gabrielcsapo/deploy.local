import assert from 'node:assert/strict';
import test from 'node:test';
import { latestRunSettings, supportedEffort } from './composer-settings.ts';

const run = { id: 'r1', adapter: 'codex', model: 'gpt-6.1-sol', effort: 'high' };

test('opening a task adopts its latest run settings', () => {
  assert.deepEqual(latestRunSettings('t1', [{ ...run, id: 'r0', model: null }, run], ''), {
    settings: { adapter: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    adopted: 't1:r1',
  });
});

test('a run finishing or a poll does not reset the composer once adopted', () => {
  assert.equal(
    latestRunSettings('t1', [{ ...run, status: 'succeeded' } as typeof run], 't1:r1'),
    null,
  );
});

test('a new run, from this or another device, becomes the default', () => {
  const next = { id: 'r2', adapter: 'claude', model: 'opus', effort: null };
  assert.deepEqual(latestRunSettings('t1', [run, next], 't1:r1')?.settings, {
    adapter: 'claude',
    model: 'opus',
    effort: '',
  });
});

test('a task without runs keeps the composer as it is', () => {
  assert.equal(latestRunSettings('t1', [], ''), null);
  assert.equal(latestRunSettings('t1', undefined, 't0:r9'), null);
});

test('effort is cleared only when the computer lists efforts that exclude it', () => {
  assert.equal(supportedEffort('high', []), 'high');
  assert.equal(supportedEffort('high', ['low', 'high']), 'high');
  assert.equal(supportedEffort('xhigh', ['low', 'high']), '');
});
