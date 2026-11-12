import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Skeleton } from './Skeleton.tsx';

test('row and block skeletons expose a busy status and keep the label out of visible content', () => {
  for (const block of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(Skeleton, { block, rows: 4, label: 'Loading the design' }),
    );
    assert.match(html, /role="status"/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /aria-label="Loading the design"/);
    assert.match(html, /aria-hidden="true"/);
    assert.equal((html.match(/class="dl-item"/g) ?? []).length, block ? 0 : 4);
    assert.equal((html.match(/class="dl-skel"/g) ?? []).length, block ? 1 : 12);
    assert.equal(html.replace(/<[^>]*>/g, ''), '');
    assert.doesNotMatch(html, /dl-notice/);
    if (block) assert.match(html, /class="dl-skeleton-block"/);
  }
});
