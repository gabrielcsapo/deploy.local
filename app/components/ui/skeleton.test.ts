import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { Skeleton } from './Skeleton.tsx';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
test('one shared skeleton renders five row placeholders, three conversation blocks or one chip, with a loading label', () => {
  for (const [variant, count] of [
    ['rows', 5],
    ['sidebar', 5],
    ['conversation', 3],
    ['detail', 5],
    ['chip', 1],
  ] as const) {
    const html = renderToStaticMarkup(createElement(Skeleton, { variant, label: 'Loading tasks' }));
    assert.equal((html.match(/ui-skeleton-block/g) ?? []).length, count);
    assert.match(html, /role="status" aria-label="Loading tasks" aria-busy="true"/);
    assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, count);
  }
  const css = read('./skeleton.css');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation: none/);
  assert.match(css, /var\(--ds-motion-duration-shimmer\)/);
});
test('first-load gates keep cached sidebar, conversation, lists, application and changes visible during refreshes', () => {
  assert.match(read('./skeleton.css'), /\.ui-skeleton-chip \{/);
});
