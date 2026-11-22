import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { root } from './test-import-graph.ts';

const directory = join(root, 'server/features/observability');
// Include types, re-exports, side effects, literal dynamic imports and CommonJS.
function imports(source: string) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bcreateRequire\([^)]*\)\s*\(\s*)['"`]([^'"`]+)['"`]/g,
    ),
  ].map((match) => match[1]);
}

// Exact exceptions retained by the pure move. An edge disappearing also requires review.
const workspaceOrigins = new Set<string>(['event-clip.ts', 'health-event-retention.ts']);
const exceptions: Record<string, string> = {
  'interaction-traces.ts -> packages/trace/interaction.js':
    'Type-only dependency on the public client interaction contract used by the ingestion validator.',
  'health.ts -> shared/v2/contracts.ts':
    'Existing public health and Live types; preserve client contracts.',
  'live.ts -> server/ci-releases.ts':
    'Existing CI credential authentication; preserve worker report admission.',
  'live.ts -> server/crash-tracker.ts':
    'Existing in-memory restart counts; preserve Live health state.',
  'live.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
  'live.ts -> server/v2/releases.ts':
    'Existing product dependency retained from v2; preserve Live presentation and evaluation order.',
  'live.ts -> server/v2/state-refresh.ts':
    'Existing product dependency retained from v2; preserve Live presentation and evaluation order.',
  'live.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'live.ts -> shared/v2/contracts.ts':
    'Existing public health and Live types; preserve client contracts.',
  'measurements.ts -> server/requests-db.ts':
    'Existing request log database; preserve traffic measurements.',
  'measurements.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
};

test('observability preserve origin boundaries and allow only reviewed dependencies', () => {
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

test('observability boundary scanner includes every supported import form', () => {
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
