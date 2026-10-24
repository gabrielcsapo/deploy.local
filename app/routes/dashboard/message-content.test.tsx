import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from './message-content.client';

const render = (content: string) =>
  renderToStaticMarkup(createElement(MessageContent, { content }));

test('conversation documents retain tables, nested lists, tasks, quotes and code structure', () => {
  const html = render(`## Results

| Computer | Result |
| --- | --- |
| Mac | **Passed** |

1. Review
   - Source
   - Tests

- [x] Complete

> Keep the conversation together.

\`\`\`javascript
const result = "passed";
\`\`\`
`);
  assert.match(html, /<h2>Results<\/h2>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>Computer<\/th>/);
  assert.match(html, /<td><strong>Passed<\/strong><\/td>/);
  assert.match(html, /<ol>[\s\S]*<ul>/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /aria-label="Copy code"/);
  assert.match(html, /language-javascript/);
  assert.match(html, /hljs-keyword/);
});

test('untrusted messages cannot execute raw HTML or executable URL schemes', () => {
  const html = render(
    '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert%281%29)\n\n[safe](https://example.com)',
  );
  assert.doesNotMatch(html, /<script|onerror=|href="javascript:/);
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
});

test('workspace file links stay in the app; external links open a new tab', () => {
  const opened: unknown[] = [];
  const html = renderToStaticMarkup(
    createElement(MessageContent, {
      content:
        '[format-time.mjs](/home/me/.local/share/deploy.local/task-workers/w/tasks/t1/web/format-time.mjs:1) and [docs](https://example.com)',
      fileLinks: { task: { id: 't1' }, open: (reference) => opened.push(reference) },
    }),
  );
  assert.match(
    html,
    /class="pw-file-link"[^>]*title="Show web\/format-time.mjs line 1 in Changes"/,
  );
  assert.match(html, /href="https:\/\/example.com" target="_blank"/);
  assert.equal(html.match(/target="_blank"/g)?.length, 1);
});

test('report links into the task workspace open in the app; other disk paths render as code', () => {
  const html = renderToStaticMarkup(
    createElement(MessageContent, {
      content:
        '[verification.md](</var/home/bazzite/.config/deploy.local Node/worker/tasks/8a0e/docs/verification.md>), ' +
        '[hosts](/etc/hosts), [notes](file:///Users/me/notes.md) and [task](/dashboard?task=8a0e)',
      fileLinks: {
        task: {
          id: '8a0e',
          remoteWorkspacePath: '/home/bazzite/.config/deploy.local Node/worker/tasks/8a0e',
        },
        open: () => {},
      },
    }),
  );
  assert.match(html, /class="pw-file-link"[^>]*title="Show docs\/verification.md in Changes"/);
  assert.match(html, /<code title="\/etc\/hosts">hosts<\/code>/);
  assert.match(html, /<code title="\/Users\/me\/notes.md">notes<\/code>/);
  assert.match(html, /href="\/dashboard\?task=8a0e"/);
  assert.doesNotMatch(html, /href="\/etc|href="file:/);
});

test('without a task, worker paths are shown as code rather than dead links', () => {
  const html = render('[verification.md](/home/w/tasks/t1/docs/verification.md)');
  assert.match(
    html,
    /<code title="\/home\/w\/tasks\/t1\/docs\/verification.md">verification.md<\/code>/,
  );
});
