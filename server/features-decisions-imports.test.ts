import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { root } from './test-import-graph.ts';

const directory = join(root, 'server/features/decisions');
// Include types, re-exports, side effects, literal dynamic imports and CommonJS.
function imports(source: string) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bcreateRequire\([^)]*\)\s*\(\s*)['"`]([^'"`]+)['"`]/g,
    ),
  ].map((match) => match[1]);
}

// Exact exceptions retained by the pure move. An edge disappearing also requires review.
const workspaceOrigins = new Set([
  'control-continuation.ts',
  'question-continuation.ts',
  'question-lifecycle.ts',
  'questions.ts',
]);
const exceptions: Record<string, string> = {
  'inbox.ts -> server/v2/state-refresh.ts':
    'Existing product dependency retained from v2; preserve projection and evaluation order.',
  'inbox.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'inbox.ts -> shared/v2/contracts.ts':
    'Existing shared provider or public contract; preserve worker and client behavior.',
  'phone-preferences.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'question-lifecycle.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'questions.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
};

test('decisions preserve origin boundaries and allow only reviewed dependencies', () => {
  const actual = new Set<string>();
  function files(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const file = join(folder, entry.name);
      return entry.isDirectory()
        ? files(file)
        : /\.[cm]?[jt]sx?$/.test(file) && !file.includes('.test.')
          ? [file]
          : [];
    });
  }
  for (const file of files(directory)) {
    const name = relative(directory, file);
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('.')) {
        const edge = `${name} -> ${specifier}`;
        assert.ok(exceptions[edge], edge);
        actual.add(edge);
        continue;
      }
      let destination = resolve(dirname(file), specifier);
      // Follow compatibility forwards so a feature cannot conceal a forbidden import.
      const seen = new Set<string>();
      while (!seen.has(destination)) {
        seen.add(destination);
        const forward = readFileSync(destination, 'utf8')
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
          .trim()
          .match(/^export (?:\*|\{[^}]*\})\s+from ['"]([^'"]+)['"];\s*$/);
        if (!forward) break;
        destination = resolve(dirname(destination), forward[1]);
      }
      const target = relative(root, destination);
      for (const path of seen)
        assert.ok(
          !/^server\/(?:transports|api)(?:\/|\.ts$)/.test(relative(root, path)),
          `${name} -> ${relative(root, path)}`,
        );
      if (workspaceOrigins.has(name))
        for (const path of seen)
          assert.ok(!relative(root, path).startsWith('server/v2/'), `${name} -> ${path}`);
      // Existing dependency-free registration ports are an allowed boundary.
      const port = target.match(/^server\/workspace\/(.+)-port\.ts$/);
      if (port) {
        assert.deepEqual(imports(readFileSync(destination, 'utf8')), [
          `../contracts/${port[1]}.ts`,
        ]);
        continue;
      }
      if (/^server\/(?:kernel|contracts|features)\//.test(target)) continue;
      if (target === 'server/workspace/media-ports.ts') {
        assert.deepEqual(imports(readFileSync(destination, 'utf8')), [
          '../contracts/workspace-media.ts',
        ]);
        continue;
      }
      const edge = `${name} -> ${target}`;
      assert.ok(exceptions[edge], edge);
      actual.add(edge);
    }
  }
  assert.deepEqual([...actual].sort(), Object.keys(exceptions).sort());
});

test('decisions boundary scanner includes every supported import form', () => {
  assert.deepEqual(
    imports(`
    import type { A } from '../v2/a.ts';
    export * from '../transports/a.ts';
    import '../features/tasks/a.ts';
    const a = import('../v2/b.ts');
    const b = require('../transports/b.ts');
    const c = createRequire(import.meta.url)('../v2/c.ts');
  `),
    [
      '../v2/a.ts',
      '../transports/a.ts',
      '../features/tasks/a.ts',
      '../v2/b.ts',
      '../transports/b.ts',
      '../v2/c.ts',
    ],
  );
});
