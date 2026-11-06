import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
