import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar } from './AgentAvatar.tsx';

test('first render already contains the complete themed avatar, without an async placeholder', () => {
  const first = renderToStaticMarkup(createElement(AgentAvatar, { id: 'first-agent', size: 30 }));
  assert.match(first, /<svg\b/);
  assert.match(first, /<path\b/);
  assert.match(first, /fill="var\(--ds-surface\)"/);
  assert.match(first, /width:30px;height:30px/);
  assert.equal(
    renderToStaticMarkup(createElement(AgentAvatar, { id: 'first-agent', size: 30 })),
    first,
  );
  assert.notEqual(
    renderToStaticMarkup(createElement(AgentAvatar, { id: 'second-agent', size: 30 })),
    first,
  );
});

test('avatars rendered together retain distinct SVG ids and their own references', () => {
  const html = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(AgentAvatar, { id: 'same' }),
      createElement(AgentAvatar, { id: 'same' }),
    ),
  );
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of html.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(match[1]));
});
