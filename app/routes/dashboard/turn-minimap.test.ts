import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { indexTranscript } from './transcript-index.ts';
import { jumpToTurn, minimapKey, showTurnMinimap } from './turn-minimap.ts';

test('the minimap counts only visible user turns, keeps first-line excerpts and requires overflow', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'First line\nSecond line' },
    { id: 'a1', role: 'assistant', content: 'Reply' },
    { id: 'p1', role: 'assistant', isProgress: true },
    { id: 'u2', role: 'user', content: 'x'.repeat(80) },
    { id: 'u3', role: 'user', content: 'Third prompt' },
  ];
  const { turns } = indexTranscript(messages, []);
  assert.deepEqual(
    turns.map((turn) => turn.id),
    ['u1', 'u2', 'u3'],
  );
  assert.equal(turns[0].excerpt, 'First line');
  assert.equal(turns[1].excerpt.length, 60);
  assert.equal(showTurnMinimap(turns.slice(0, 2), true), false);
  assert.equal(showTurnMinimap(turns, false), false);
  assert.equal(showTurnMinimap(turns, true), true);
});
test('keyboard moves one roving tab stop and jumping respects reduced motion', () => {
  assert.equal(minimapKey('ArrowDown', 0, 3), 1);
  assert.equal(minimapKey('ArrowUp', 0, 3), 2);
  assert.equal(minimapKey('Home', 2, 3), 0);
  assert.equal(minimapKey('End', 0, 3), 2);
  assert.equal(minimapKey('Tab', 0, 3), undefined);
  const calls: unknown[] = [],
    element = {
      scrollIntoView: (options: unknown) => {
        calls.push(options);
      },
    };
  jumpToTurn(element, false);
  jumpToTurn(element, true);
  assert.deepEqual(calls, [
    { block: 'start', behavior: 'smooth' },
    { block: 'start', behavior: 'instant' },
  ]);
  const source = readFileSync(new URL('./turn-minimap.client.tsx', import.meta.url), 'utf8');
  // Native buttons activate their onClick on Enter; the container only intercepts navigation keys.
  assert.match(source, /<button/);
  assert.match(source, /tabIndex=\{index === active \? 0 : -1\}/);
  assert.match(source, /onClick=\{\(\) =>\s*jumpToTurn/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /ResizeObserver/);
  assert.doesNotMatch(source, /onScroll|addEventListener\(['"]scroll/);
});
