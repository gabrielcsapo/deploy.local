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
  assert.match(read('../../routes/dashboard/task-tree.client.tsx'), /!loaded && !error/);
  assert.match(
    read('../../routes/dashboard/apps.client.tsx'),
    /loading && deployments.length === 0/,
  );
  assert.match(read('../../routes/dashboard/nodes.client.tsx'), /computers === null/);
  assert.match(read('../../routes/dashboard/projects.client.tsx'), /selected && !detail/);
  assert.match(read('../../routes/dashboard/detail/layout.client.tsx'), /\) : !deployment \? \(/);
  assert.match(
    read('../../routes/dashboard/detail/ApplicationOverview.tsx'),
    /loading && !application/,
  );
  assert.match(
    read('../../routes/dashboard/repository-workbench.client.tsx'),
    /data\?\.key === requestKey && \(/,
  );
  assert.match(
    read('../../routes/dashboard/task-activity-panel.client.tsx'),
    /!detail && <Skeleton/,
  );
  // An unknown project or computer is a chip placeholder, never a claim that it is missing.
  const workspace = read('../../routes/dashboard/projects.client.tsx');
  for (const label of ['Loading project', 'Loading computer'])
    assert.match(workspace, new RegExp(`<Skeleton variant="chip" label="${label}" />`));
  assert.match(read('./skeleton.css'), /\.ui-skeleton-chip \{/);
});
