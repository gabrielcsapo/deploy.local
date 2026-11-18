import test from 'node:test';
import assert from 'node:assert/strict';
import { changesData } from './data.ts';

test('a running step’s progress ticks do not refresh page data; everything else does', () => {
  assert.equal(
    changesData({ type: 'conversation', event: { kind: 'worklog', live: true } }),
    false,
  );
  assert.equal(
    changesData({ type: 'conversation', event: { kind: 'worklog', live: false } }),
    true,
  );
  assert.equal(changesData({ type: 'conversation', event: { kind: 'reply' } }), true);
  assert.equal(changesData({ type: 'inbox' }), true);
  assert.equal(changesData({ type: 'release' }), true);
});
