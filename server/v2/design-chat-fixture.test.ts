import assert from 'node:assert/strict';
import test from 'node:test';
import { fixturePreview } from '../../docs/evidence/design-chat-build/fixture-preview.ts';
import type { DesignReviewScreen } from '../../shared/v2/contracts.ts';

test('capture fixture keeps the approved phone grid context and native height', () => {
  const board = {
    file: 'AgentInfoPhone.html',
    w: 390,
    h: 844,
    added: false,
    removed: false,
  } as DesignReviewScreen;
  const rect = { x: 117, y: 250, w: 156, h: 240 };
  const preview = fixturePreview(board, 390, 3, rect, rect);
  assert.deepEqual(preview.crop, { x: 0, y: 92, w: 390, h: 440 });
  assert.deepEqual(preview.areas[0].after, { x: 20, y: 140, w: 350, h: 250 });
  assert.equal(preview.height, 844);
});
