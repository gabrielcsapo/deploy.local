import test from 'node:test';
import assert from 'node:assert/strict';
import { logStreamStatus } from './logs.ts';

test('a new read connects until its first stream opens', () => {
  assert.deepEqual(logStreamStatus({ openStreams: 0, hasOpened: false, finished: false }), {
    label: 'Connecting',
    kind: 'inactive',
    reconnect: false,
  });
  assert.deepEqual(logStreamStatus({ openStreams: 1, hasOpened: true, finished: false }), {
    label: 'Live',
    kind: 'active',
    reconnect: false,
  });
});

test('multiple streams remain live until the last open stream ends', () => {
  for (const openStreams of [3, 2, 1]) {
    assert.equal(logStreamStatus({ openStreams, hasOpened: true, finished: false }).label, 'Live');
  }
  // Another source may still be opening, but none can currently deliver lines.
  for (const finished of [false, true]) {
    assert.deepEqual(logStreamStatus({ openStreams: 0, hasOpened: true, finished }), {
      label: 'Disconnected',
      kind: 'inactive',
      reconnect: true,
    });
  }
});

test('no sources disconnects, and failures leave recovery to the banner', () => {
  assert.deepEqual(logStreamStatus({ openStreams: 0, hasOpened: false, finished: true }), {
    label: 'Disconnected',
    kind: 'inactive',
    reconnect: true,
  });
  for (const openStreams of [0, 1, 2]) {
    assert.deepEqual(
      logStreamStatus({ openStreams, hasOpened: openStreams > 0, finished: false }, true),
      {
        label: 'Disconnected',
        kind: 'inactive',
        reconnect: false,
      },
    );
  }
});
