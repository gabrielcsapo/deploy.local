import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskActivity } from './task-activity.client.tsx';

test('queued turns never claim to be working or accrue worked time', () => {
  const html = renderToStaticMarkup(
    createElement(TaskActivity, {
      activity: { id: 'run', status: 'queued', summary: '', items: [] },
      run: { status: 'queued', createdAt: '2026-10-26T00:00:00Z' },
    }),
  );
  assert.match(html, /Queued/);
  assert.doesNotMatch(html, /Working|Worked| for /);
});
