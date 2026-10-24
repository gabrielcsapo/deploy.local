import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskPublish } from './task-publish.client.tsx';

const checkpoint = {
  id: 'checkpoint',
  createdAt: '2026-10-23T12:05:00Z',
  fileCount: 43,
  fresh: true,
};
function render(extra: Record<string, any> = {}) {
  return renderToStaticMarkup(
    createElement(TaskPublish, {
      task: { id: 'task', title: 'Publish app', revision: 0 },
      pulls: [],
      diff: { patch: 'partial', truncated: true, hasUnpublishedChanges: false },
      busy: false,
      api: async () => ({}),
      published: () => {},
      latestCheckpoint: checkpoint,
      ...extra,
    }),
  );
}

test('incomplete changes offer a fresh checkpoint as the single enabled publish action', () => {
  for (const diff of [
    { truncated: true, patch: '' },
    { excluded: ['large.bin'], patch: 'partial' },
  ]) {
    const html = render({ diff });
    assert.match(html, /Publish latest checkpoint/);
    assert.match(html, /Captured .* · 43 files · the full change set/);
    assert.doesNotMatch(html, /disabled=""/);
    assert.doesNotMatch(html, /Publish as pull request/);
  }
  const linked = render({
    pulls: [{ id: 'pr', number: 1, status: 'open', sourceBranch: 'review' }],
  });
  assert.match(linked, /Publish latest checkpoint/);
  assert.doesNotMatch(linked, /disabled=""/);
});

test('stale checkpoints explain recovery and active runs block the offer', () => {
  const html = render({ latestCheckpoint: { ...checkpoint, fresh: false } });
  assert.match(
    html,
    /Commands or edits ran after this checkpoint; ask the agent to capture a new checkpoint as its last step/,
  );
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /Publish latest checkpoint/);
  assert.match(render({ busy: true }), /disabled=""/);
  assert.match(render({ busy: true }), /Wait for the active operation/);
});

test('complete diffs retain patch publishing and missing checkpoints explain recovery', () => {
  const html = render({ diff: { patch: 'complete', hasUnpublishedChanges: true } });
  assert.match(html, /Publish as pull request/);
  assert.doesNotMatch(html, /Publish latest checkpoint/);
  assert.match(render({ latestCheckpoint: null }), /Ask the agent to capture a new checkpoint/);
});

test('the suggested description renders as Markdown until edited', () => {
  const html = render({
    diff: { patch: 'complete', hasUnpublishedChanges: true },
    defaults: { title: 'Sync auth', body: '**Device keys** replace `syncToken`.' },
  });
  assert.match(html, /<strong>Device keys<\/strong> replace <code>syncToken<\/code>/);
  assert.doesNotMatch(html, /\*\*Device keys\*\*/);
  assert.match(html, /Edit description/);
  // With nothing suggested, the editor shows at once.
  assert.match(render({ defaults: { title: 'Sync auth', body: '' } }), /<textarea/);
});
