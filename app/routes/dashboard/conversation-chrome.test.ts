import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('the shared status badge keeps its readable label', async () => {
  const { StatusBadge } = await import('../../components/ui/StatusBadge.tsx');
  assert.match(
    renderToStaticMarkup(
      createElement(StatusBadge, { tone: 'attention', label: 'ready to review' }),
    ),
    /<span class="ui-status-label">Ready to review<\/span>/,
  );
});
