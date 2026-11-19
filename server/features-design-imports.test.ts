import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { root } from './test-import-graph.ts';

const directory = join(root, 'server/features/design');
// Include types, re-exports, side effects, literal dynamic imports and CommonJS.
function imports(source: string) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bcreateRequire\([^)]*\)\s*\(\s*)['"`]([^'"`]+)['"`]/g,
    ),
  ].map((match) => match[1]);
}

// Exact exceptions retained by the pure move. An edge disappearing also requires review.
const workspaceOrigins = new Set<string>([]);
const exceptions: Record<string, string> = {
  'board-check.ts -> server/design/board-html.ts':
    'The board check reads layers with the existing board HTML reader; moved from scripts/design-check.mjs.',
  'board-check.ts -> shared/v2/design-overflow.ts':
    'The cut-off rule, shared with the page deploy design dev serves so both measure the same way.',
  'board-check.ts -> shared/v2/design-review.ts':
    'Existing shared design review model; the check names screens and widths as review does.',
  'board-check.ts -> shared/v2/design.ts':
    'Existing shared canvas model; the check labels layers as review does.',
  'design.ts -> server/design/canvas-edit.ts':
    'Canvas edits, shared with the folder deploy design dev serves so both write the same canvas.',
  'design-check.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'design-check.ts -> shared/v2/contracts.ts':
    'Existing public design check and inbox types; preserve client contracts.',
  'design.ts ->  on top of ':
    'Not an import: the scanner matches the doc comment "`from` on top of `target`"; the moved source is unchanged.',
  'design.ts -> playwright':
    'Existing optional board-rendering browser runtime and types; preserve lazy browser startup.',
  'design.ts -> server/design/board-html.ts':
    'Existing board HTML reader; preserve board rendering and layer identities.',
  'design.ts -> server/design/board-merge.ts': 'Existing board merge; preserve merged board bytes.',
  'design.ts -> server/design/review-evidence.ts':
    'Existing review evidence reader; preserve Before and After evidence.',
  'design.ts -> server/v2/attachments.ts':
    'Existing product dependency retained from v2; preserve design review and evaluation order.',
  'design.ts -> server/v2/task-computer.ts':
    'Existing product dependency retained from v2; preserve design review and evaluation order.',
  'design.ts -> server/workspace/computer-role-policy.ts':
    'Existing effective worker-role checks; preserve refusals and placement.',
  'design.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'design.ts -> server/workspace/tool-probes.ts':
    'Existing tool probes; preserve design build checks.',
  'design.ts -> shared/v2/artifacts.ts':
    'Shared artifact names with no imports of their own; a document review is named the same on server and clients.',
  'design.ts -> shared/v2/contracts.ts':
    'Existing public design, task and inbox types; preserve client contracts.',
  'design.ts -> shared/v2/design-review.ts':
    'Existing shared design review model; preserve review areas on server and clients.',
  'design.ts -> shared/v2/design.ts':
    'Existing shared canvas model; preserve canvas parsing on server and clients.',
};

test('design preserve origin boundaries and allow only reviewed dependencies', () => {
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

test('design boundary scanner includes every supported import form', () => {
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
