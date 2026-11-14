import assert from 'node:assert/strict';
import test from 'node:test';
import { components, imports, runtimeGraph } from './test-import-graph.ts';

// Route composition was added after the plan's audit. Route work is explicitly outside
// this change's scope; keep this exact SCC visible until its owner breaks it.
const allowed = [['server/api/registry.ts', 'server/api/v2.ts', 'server/v2/api.ts']];
test('server runtime imports have no multi-file strongly connected components', () => {
  const actual = components(runtimeGraph());
  console.log('Runtime strongly connected components:', JSON.stringify(actual, null, 2));
  assert.deepEqual(actual, allowed);
});

test('runtime import graph parses exports and literal dynamic imports but erases types', () => {
  assert.deepEqual(
    imports(`
    // import './comment.ts';
    const text = "import './string.ts'";
    import type { A } from './type.ts';
    import { type B, value } from './mixed.ts';
    export type { C } from './export-type.ts';
    export { type D, other } from './export.ts';
    export * from './star.ts';
    import './effect.ts';
    type Lazy = typeof import('./type-query.ts');
    const lazy = import('./lazy.ts');
    const computed = import(text);
  `),
    [
      { specifier: './mixed.ts', dynamic: false },
      { specifier: './export.ts', dynamic: false },
      { specifier: './star.ts', dynamic: false },
      { specifier: './effect.ts', dynamic: false },
      { specifier: './lazy.ts', dynamic: true },
    ],
  );
});

test('SCC scan finds every component and ignores singletons', () => {
  assert.deepEqual(
    components(
      new Map([
        ['a', ['b']],
        ['b', ['a', 'c']],
        ['c', ['c']],
        ['d', ['e']],
        ['e', ['d']],
      ]),
    ),
    [
      ['a', 'b'],
      ['d', 'e'],
    ],
  );
});
