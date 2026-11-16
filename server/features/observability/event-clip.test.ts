import test from 'node:test';
import assert from 'node:assert/strict';
import { clipEvent } from './event-clip.ts';

test('an oversized run event is shortened to fit one request and keeps its shape', () => {
  const small = { sequence: 1, type: 'item.completed', payload: { text: 'done' } };
  assert.equal(clipEvent(small), small);
  const image = 'A'.repeat(1_200_000);
  const big = {
    sequence: 2,
    type: 'item.completed',
    payload: { item: { type: 'tool_result', content: [{ type: 'image', data: image }], id: 'x' } },
  };
  const clipped = clipEvent(big);
  assert.ok(JSON.stringify(clipped).length < 256_000);
  assert.equal(clipped.sequence, 2);
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.payload.item.id, 'x');
  assert.match(clipped.payload.item.content[0].data, /characters omitted\]$/);
});
