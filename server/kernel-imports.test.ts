import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const server = fileURLToPath(new URL('./', import.meta.url));
const kernel = join(server, 'kernel');

// Include type imports, re-exports, side-effect imports, literal dynamic imports and requires.
// This is deliberately conservative: even a commented-out feature import needs review.
function imports(source: string) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bcreateRequire\([^)]*\)\s*\(\s*)['"`]([^'"`]+)['"`]/g,
    ),
  ].map((match) => match[1]);
}

test('kernel imports cannot reach features, including through compatibility re-exports', () => {
  const visited = new Set<string>();
  const violations: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      if (isBuiltin(specifier) || specifier === 'better-sqlite3') continue;
      const target = resolve(dirname(file), specifier);
      const name = relative(server, target);
      // Git notifications are an existing dependency-free primitive with shared listeners.
      // Leave its singleton in place in this step; every other server dependency stays local.
      if (
        !specifier.startsWith('.') ||
        (!name.startsWith('kernel/') && name !== 'git-changes.ts')
      ) {
        violations.push(`${relative(server, file)} -> ${specifier}`);
        continue;
      }
      visit(target);
    }
  }
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.[cm]?[jt]sx?$/.test(file)) visit(file);
    }
  }
  walk(kernel);
  assert.ok(visited.size > 0);
  assert.deepEqual(violations, []);
});

test('the boundary scan includes type, export, dynamic and CommonJS dependencies', () => {
  assert.deepEqual(
    imports(`
    import type { Feature } from '../v2/api.ts';
    export * from '../workspace/store.ts';
    import '../packages/hooks.ts';
    const feature = import('../design/boards.ts');
    const store = require('../store/connection.ts');
    const api = createRequire(import.meta.url)('../api.ts');
  `),
    [
      '../v2/api.ts',
      '../workspace/store.ts',
      '../packages/hooks.ts',
      '../design/boards.ts',
      '../store/connection.ts',
      '../api.ts',
    ],
  );
});

test('compatibility paths expose the same kernel functions and classes, including Git default', async () => {
  const moves = [
    ...['http', 'errors', 'routes', 'process', 'git', 'materialized'].map((name) => [
      `${name}.ts`,
      `kernel/${name}.ts`,
    ]),
    ['data-directory.ts', 'kernel/files/data-directory.ts'],
    ['packages/worker-file.ts', 'kernel/files/worker-file.ts'],
    ['sqlite.ts', 'kernel/db/sqlite.ts'],
    ['store/migration-lock.ts', 'kernel/db/migration-lock.ts'],
    ['workspace/database-open.ts', 'kernel/db/database-open.ts'],
  ];
  for (const [oldPath, newPath] of moves) {
    const oldModule = await import(pathToFileURL(join(server, oldPath)).href);
    const newModule = await import(pathToFileURL(join(server, newPath)).href);
    assert.deepEqual(Object.keys(oldModule), Object.keys(newModule), oldPath);
    for (const name of Object.keys(newModule))
      assert.equal(oldModule[name], newModule[name], `${oldPath}: ${name}`);
  }
});
