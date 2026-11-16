import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { root } from './test-import-graph.ts';

const directory = join(root, 'server/features/agents');
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
  'agent-context.ts',
  'agent-launch.ts',
  'agent-media.ts',
  'agent-packages.ts',
  'claude-stream.ts',
  'compatible-control-tools.ts',
  'coordination.ts',
  'coordination-tools.ts',
  'design-tool-schema.ts',
  'model-options.ts',
  'provider-runtime.ts',
  'provider-usage.ts',
  'shipping-instructions.ts',
  'provider-connections.ts',
]);
const exceptions: Record<string, string> = {
  'agent-context.ts -> server/computer-roles.ts':
    'Existing effective computer-role contract; preserve worker capability policy.',
  'agent-foundation.ts -> croner': 'Existing schedule parser; preserve agent schedule timing.',
  'agent-foundation.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'agent-foundation.ts -> shared/v2/agents.ts':
    'Existing shared provider or public contract; preserve worker and client behavior.',
  'agent-foundation.ts -> shared/v2/contracts.ts':
    'Existing shared provider or public contract; preserve worker and client behavior.',
  'agent-instructions.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'agent-instructions.ts -> shared/v2/contracts.ts':
    'Existing shared provider or public contract; preserve worker and client behavior.',
  'agent-launch.ts -> server/workspace/node-runtime.ts':
    'Existing worker Node runtime environment; preserve child runtime selection.',
  'agent-launch.ts -> server/workspace/tls-trust.ts':
    'Existing worker TLS trust environment; preserve provider trust.',
  'agent-launch.ts -> server/workspace/worker-entry.ts':
    'Existing source and bundle entry lookup; preserve process paths.',
  'agent-packages.ts -> server/workspace/shell-environment.ts':
    'Existing shell environment policy; preserve executable lookup.',
  'agent-packages.ts -> shared/package-install.mjs':
    'Existing shared provider or public contract; preserve worker and client behavior.',
  'agents.ts -> server/v2/agent-runs.ts':
    'Existing product dependency retained from v2; preserve projection and evaluation order.',
  'agents.ts -> server/v2/attachments.ts':
    'Existing product dependency retained from v2; preserve projection and evaluation order.',
  'agents.ts -> server/v2/events.ts':
    'Existing product dependency retained from v2; preserve projection and evaluation order.',
  'agents.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'agents.ts -> shared/v2/agents.ts':
    'Existing shared provider or public contract; preserve worker and client behavior.',
  'agents.ts -> shared/v2/contracts.ts':
    'Existing shared provider or public contract; preserve worker and client behavior.',
  'coordination.ts -> server/computer-roles.ts':
    'Existing effective computer-role contract; preserve worker capability policy.',
  'coordination.ts -> server/metrics-collector.ts':
    'Existing coordinator Docker availability probe; preserve worker capability projection.',
  'coordination.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve node identity reads.',
  'coordination.ts -> server/workspace/computer-role-policy.ts':
    'Existing effective worker-role policy; preserve admission refusals.',
  'coordination.ts -> server/workspace/computer-view.ts':
    'Existing cached computer projection; preserve worker visibility.',
  'coordination.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'coordination.ts -> server/workspace/worker-capabilities.ts':
    'Existing worker capability validation; preserve job eligibility.',
  'provider-connections.ts -> server/secrets.ts':
    'Existing secret key and encryption; preserve encrypted provider credentials.',
  'provider-connections.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
};

test('agents preserve origin boundaries and allow only reviewed dependencies', () => {
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

test('agents boundary scanner includes every supported import form', () => {
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
