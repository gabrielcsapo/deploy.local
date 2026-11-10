import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar } from './AgentAvatar.tsx';

// Captured with @dicebear/styles 10.6.0 before vendoring its Glyphs definition.
test('known avatars retain their exact rendered bytes', () => {
  for (const [id, digest] of [
    ['first-agent', '8cf734853680e7c78e97983972791f085daafd4db04b92d952648eeaaaa36b69'],
    ['second-agent', '135fba27304e716eef3770d82d5a0922f952285f1fccfeb20d8364938862c3aa'],
    ['agent-🧑‍🚀', 'b09cf4a3947510b9df89d40f4c1b943b0ef20dbf5ef2c77d16adeb43acb8c3a1'],
  ]) {
    const html = renderToStaticMarkup(createElement(AgentAvatar, { id, size: 30 }));
    assert.equal(createHash('sha256').update(html).digest('hex'), digest, id);
  }
});

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
