import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMediaDuration, uploadProgress } from './video-state.ts';
test('duration formats actual seconds, omits unknown and invalid durations', () => {
  assert.equal(formatMediaDuration(0), '0:00');
  assert.equal(formatMediaDuration(12.9), '0:12');
  assert.equal(formatMediaDuration(600), '10:00');
  assert.equal(formatMediaDuration(3601), '60:01');
  for (const seconds of [undefined, null, NaN, Infinity, -1])
    assert.equal(formatMediaDuration(seconds), null);
});
test('upload chip reflects byte progress, bounds completion and reports cancellation', () => {
  const state = { name: 'flow.mp4', loaded: 25, total: 100, cancelled: false };
  assert.equal(uploadProgress(state), '25%');
  assert.equal(uploadProgress({ ...state, loaded: 200 }), '100%');
  assert.equal(uploadProgress({ ...state, total: 0 }), 'Uploading…');
  assert.equal(uploadProgress({ ...state, cancelled: true }), 'Cancelled');
});
