import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('a collapsed project whose tasks are all closed still shows that it has tasks', () => {
  const css = readFileSync(new URL('./task-tree.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /\.task-tree-toggle > \.pw-icon:is\(\.is-expanded, \.is-shown\) \{\s*opacity: 1;/,
  );
});
