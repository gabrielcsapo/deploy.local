import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  'native/Apple/Packages/DeployKit/Sources/DeployUI/V2/V2DesignReview.swift',
  'utf8',
);
const card = source.slice(source.indexOf('struct V2DesignCard: View'));

test('iPhone design chat delegates decisions to the full review', () => {
  assert.doesNotMatch(
    card,
    /store\.answer|Button\("Approve|Button\("Ask for changes|V2BoardComparison\(/,
  );
  assert.match(card, /Button\("Review"\)/);
  assert.match(card, /Before · main/);
  assert.match(card, /After · this task/);
  assert.match(card, /frame\(height: 120\)/);
});

test('iPhone decisions keep the record open and provide the approved onward destinations', () => {
  const answer = source.slice(
    source.indexOf('private func answer(_ action:'),
    source.indexOf('private struct V2DesignReviewPresentation'),
  );
  // Ask to update stays open too: the answered review links to the task that does the update.
  assert.doesNotMatch(answer, /dismiss\(\)/);
  assert.match(source, /V2ReviewModel\.outcome\(review(, now: context\.date)?\)/);
  assert.match(source, /Button\("Open the task"\)/);
  assert.match(source, /Button\("Open in Design"\)/);
  assert.match(source, /V2ReviewModel\.sentNotice\(review\)/);
});
