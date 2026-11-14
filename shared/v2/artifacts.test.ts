import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactSlug,
  blocksMarkdown,
  changedBlocks,
  changedWhen,
  documentBlocks,
  documentBody,
  documentTitle,
} from './artifacts.ts';

test('a name becomes its folder', () => {
  assert.equal(artifactSlug('Onboarding flow'), 'onboarding-flow');
  assert.equal(artifactSlug('  Café — Plan!  '), 'cafe-plan');
  assert.equal(artifactSlug('!!!'), '');
  assert.ok(artifactSlug('x'.repeat(80)).length <= 48);
});

test('a document reads as a title and blocks, and writes back the same', () => {
  const text = [
    '# One server plan',
    '',
    'deploy.local runs as one server process.',
    '',
    '## What moves',
    '',
    '- The event service moves.',
    '- Timers start when the server boots.',
    '',
    '1. First',
    '2. Second',
    '',
    '```',
    'pnpm test',
    '```',
    '',
  ].join('\n');
  assert.equal(documentTitle(text), 'One server plan');
  const blocks = documentBlocks(documentBody(text));
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['paragraph', 'heading', 'bullet', 'bullet', 'number', 'number', 'code'],
  );
  assert.equal(blocksMarkdown('One server plan', blocks), text);
});

test('changed blocks are the ones main does not have', () => {
  const before = documentBlocks('A\n\n- one\n- two\n');
  const after = documentBlocks('A\n\n- one\n- two\n- three\n\nB changed\n');
  assert.deepEqual(changedBlocks(before, after), [false, false, false, true, true]);
});

test('when an artifact changed, in words', () => {
  const now = new Date(2026, 10, 14, 12);
  const at = (days: number) => new Date(2026, 10, 14 - days, 9).toISOString();
  assert.equal(changedWhen(at(0), now), 'today');
  assert.equal(changedWhen(at(1), now), 'yesterday');
  assert.equal(changedWhen(at(3), now), '3 days ago');
  assert.equal(changedWhen(at(5), now), 'Monday');
  assert.equal(changedWhen(new Date(2026, 9, 12, 9).toISOString(), now), '12 October');
  assert.equal(changedWhen(null, now), '');
});
