import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentContext } from './agent-context.client.tsx';

test('agent context is a collapsed read-only text disclosure with the captured timestamp', () => {
  const html = renderToStaticMarkup(
    createElement(AgentContext, {
      run: {
        agentContext: 'Exact <instructions>\nSituation',
        agentContextAt: '2026-10-21T10:00:00Z',
      },
    }),
  );
  assert.match(html, /What the agent was told/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /<pre[^>]*hidden=""/);
  assert.match(html, /Exact &lt;instructions&gt;\nSituation/);
  assert.match(html, /<time dateTime="2026-10-21T10:00:00Z"/);
  assert.doesNotMatch(html, /<textarea|<input/);
});
test('historical runs without a recorded context show no fabricated snapshot', () => {
  assert.equal(renderToStaticMarkup(createElement(AgentContext, { run: {} })), '');
  assert.equal(renderToStaticMarkup(createElement(AgentContext, {})), '');
});
