import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deletionText, unmergedText } from './DeleteTaskDialog.tsx';

test('the confirmation names what goes, with or without a branch', () => {
  assert.equal(
    deletionText('Cache Discover images on SER', 'scout/discover-cache'),
    '“Cache Discover images on SER” is removed for good: its conversation, its saved checkpoints and its branch, scout/discover-cache.',
  );
  assert.equal(
    deletionText('Fix bazzite startup', null),
    '“Fix bazzite startup” is removed for good: its conversation and its saved checkpoints.',
  );
  assert.equal(
    unmergedText(2),
    'The branch has 2 commits that are not on main. They are deleted with it.',
  );
  assert.equal(
    unmergedText(1),
    'The branch has 1 commit that is not on main. It is deleted with it.',
  );
});
