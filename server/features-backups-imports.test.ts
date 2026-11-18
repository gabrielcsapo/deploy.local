import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { root } from './test-import-graph.ts';

const directory = join(root, 'server/features/backups');
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
  'backups.ts -> server/application-backups.ts':
    'Existing application backup operations; preserve coordinator backup contents.',
  'backups.ts -> server/application-graph-executor.ts':
    'Existing graph execution and recovery; preserve restore activation barriers.',
  'backups.ts -> server/application-runtime.ts':
    'Existing graph runtime builder; preserve restore execution plans.',
  'backups.ts -> server/application-spec.ts':
    'Existing manifest types; preserve canonical digests and validation.',
  'backups.ts -> server/backups/port.ts':
    'Existing backup access registration port filled by server/main/backups.ts; preserve wiring order.',
  'backups.ts -> server/certs.ts':
    'Existing certificate coverage; preserve restored copy hostnames.',
  'backups.ts -> server/content-store.ts':
    'Existing content-addressed artifacts; preserve backup bundle lookup.',
  'backups.ts -> server/edge/copies.ts':
    'Existing copy hostnames; preserve restored copy addresses.',
  'backups.ts -> server/graph-docker-adapter.ts':
    'Existing graph Docker adapter and types; preserve container and volume identities.',
  'backups.ts -> server/graph-runtime-store.ts':
    'Existing durable graph state; preserve restored instance records.',
  'backups.ts -> server/ipc.ts':
    'Existing certificate reload notification; preserve edge reload timing.',
  'backups.ts -> server/maintenance.ts':
    'Existing maintenance runner; preserve scheduled backup execution.',
  'backups.ts -> server/operations-handler.ts':
    'Existing operations requests; preserve backup and restore admission.',
  'backups.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
  'backups.ts -> server/v2/releases.ts':
    'Existing product dependency retained from v2; preserve release policy and evaluation order.',
  'backups.ts -> server/volumes.ts':
    'Existing backup directory and volume paths; preserve retained data locations.',
  'backups.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'backups.ts -> shared/v2/contracts.ts':
    'Existing public backup and restore types; preserve client contracts.',
};

test('backups preserve origin boundaries and allow only reviewed dependencies', () => {
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

test('backups boundary scanner includes every supported import form', () => {
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
