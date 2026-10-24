import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runDuration } from './task-activity-summary.ts';
import { TaskCard } from './task-card.client.tsx';
import { TaskActivity } from './task-activity.client.tsx';
import { ReplyActions } from './reply-actions.client.tsx';

test('elapsed turn time uses run completion, remains live only while active, and omits missing dates', () => {
  const run = {
    createdAt: '2026-10-21T10:00:00Z',
    updatedAt: '2026-10-21T10:02:08Z',
    status: 'succeeded',
  };
  assert.equal(runDuration(run, Date.parse('2026-10-22T10:00:00Z')), '2m 8s');
  assert.equal(
    runDuration({ ...run, status: 'running' }, Date.parse('2026-10-21T10:03:01Z')),
    '3m 1s',
  );
  assert.equal(runDuration({ ...run, updatedAt: '2026-10-21T09:00:00Z' }), '');
  assert.equal(runDuration({ ...run, createdAt: '' }), '');
  assert.equal(runDuration(), '');
});
const cardProps = {
  detail: { jobs: [], activity: [], messages: [] },
  patch: null,
  workers: [],
  changes() {},
  activity() {},
  sources() {},
};
test('task card distinguishes unavailable changes from a measured zero and hides empty optional rows', () => {
  const html = renderToStaticMarkup(createElement(TaskCard, cardProps));
  assert.match(html, /Changes.*Unavailable/);
  assert.doesNotMatch(html, /Running now|Sources|Deployed|\+0/);
});
test('task card counts patch hunks and limits running work to three real jobs', () => {
  const jobs = Array.from({ length: 4 }, (_, i) => ({
    id: String(i),
    name: `job-${i}`,
    command: `command-${i}`,
    status: 'running',
    workerId: 'mac',
  }));
  const html = renderToStaticMarkup(
    createElement(TaskCard, {
      ...cardProps,
      detail: { ...cardProps.detail, jobs },
      workers: [{ id: 'mac', name: 'MacBook' }],
      patch: {
        truncated: true,
        patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n',
      },
    }),
  );
  assert.match(html, /\+1/);
  assert.match(html, /−1/);
  assert.match(html, /truncated patch/);
  assert.match(html, /job-2/);
  assert.doesNotMatch(html, /job-3/);
  assert.match(html, /MacBook/);
});
test('task card lists sources by name like Codex, with View all and the deployed host', () => {
  const items = ['web/server.mjs', 'https://example.com/docs/a', 'README.md', 'web/app.js'].map(
    (source) => ({ source, kind: 'read' }),
  );
  const html = renderToStaticMarkup(
    createElement(TaskCard, {
      ...cardProps,
      project: 'Tally',
      detail: {
        jobs: [],
        activity: [{ id: 'run', items }],
        messages: [{ deployment: { status: 'running', url: 'https://tally.local/' } }],
      },
    }),
  );
  assert.match(html, /<span>Tally<\/span>/);
  assert.match(html, /aria-label="Task card options"/);
  assert.match(html, /<h3>Sources<\/h3>.*server\.mjs.*example\.com\/docs\/a.*README\.md/);
  assert.doesNotMatch(html, /app\.js/);
  assert.match(html, /View all.*>4</);
  assert.match(html, /<h3>Deployed<\/h3>.*tally\.local</);
});
test('turn header retains elapsed time without tools and moves command detail inside disclosure', () => {
  const html = renderToStaticMarkup(
    createElement(TaskActivity, {
      activity: { status: 'succeeded', summary: 'Read source', items: [] },
      run: {
        status: 'succeeded',
        createdAt: '2026-10-21T10:00:00Z',
        updatedAt: '2026-10-21T10:00:23Z',
      },
    }),
  );
  assert.match(html, /Worked.*23s/);
  assert.match(html, /<\/summary>.*Read source/);
  assert.doesNotMatch(html.split('</summary>')[0]!, /<a|<button/);
});
test('reply utilities work for historical messages without recorded agent context', () => {
  const html = renderToStaticMarkup(
    createElement(ReplyActions, {
      message: { id: 'm', taskId: 't', content: 'Reply', createdAt: '2026-10-21T10:00:00Z' },
    }),
  );
  assert.match(html, /Copy reply/);
  assert.match(html, /Copy link to message/);
  assert.doesNotMatch(html, /What the agent was told/);
});

test('the task title keeps the bar’s room: the status badge gives way to its dot first', async () => {
  const { readFileSync } = await import('node:fs');
  const { StatusBadge } = await import('../../components/ui/StatusBadge.tsx');
  const css = readFileSync(new URL('./conversation-chrome.css', import.meta.url), 'utf8');
  // A zero flex basis let the badge and icons keep their width while the title shrank to "Bui…".
  assert.match(css, /\.workspace-title-bar \.pw-heading \{\s*flex: 1 1 auto;/);
  assert.match(css, /\.workspace-title-bar > \.pw-header-status \{\s*flex: 0 1000 auto;/);
  assert.match(
    css,
    /\.workspace-title-bar > :is\(\.task-history-actions, \.pw-title-project, \.ui-action-cluster\) \{\s*flex: none;/,
  );
  assert.match(css, /\.pw-header-status \.ui-status-label \{[^}]*text-overflow: ellipsis;/);
  assert.match(
    renderToStaticMarkup(
      createElement(StatusBadge, { tone: 'attention', label: 'ready to review' }),
    ),
    /<span class="ui-status-label">Ready to review<\/span>/,
  );
});
