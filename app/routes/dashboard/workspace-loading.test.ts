import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceLoadingFrame } from './workspace-loading.client.tsx';

test('the first paint is the workspace frame with sidebar and conversation placeholders', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceLoadingFrame));
  assert.match(html, /class="project-workspace is-loading"/);
  assert.match(html, /class="workspace-rail"/);
  assert.match(html, /<aside class="pw-sidebar task-navigation"[\s\S]*ui-skeleton-sidebar/);
  assert.match(html, /class="pw-chat"[\s\S]*ui-skeleton-conversation/);
  assert.match(html, /aria-label="Connecting to workspace"/);
  const source = readFileSync(new URL('./projects.client.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(authed === null\) return <WorkspaceLoadingFrame \/>;/);
  assert.doesNotMatch(source, /Connecting to workspace…/);
});
