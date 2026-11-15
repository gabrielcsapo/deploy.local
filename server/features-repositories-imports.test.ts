import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { root } from './test-import-graph.ts';

const directory = join(root, 'server/features/repositories');
// Include types, re-exports, side effects, literal dynamic imports and CommonJS.
function imports(source: string) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bcreateRequire\([^)]*\)\s*\(\s*)['"`]([^'"`]+)['"`]/g,
    ),
  ].map((match) => match[1]);
}

// Exact exceptions retained by the pure move. An edge disappearing also requires review.
const exceptions: Record<string, string> = {
  'git-http.ts -> server/git-changes.ts':
    'Dependency-free shared repository-change notifier; preserve its singleton.',
  'git-http.ts -> server/workspace/pipeline-triggers.ts':
    'Existing push-to-pipeline trigger/acknowledgment coupling; needs a later release port.',
  'git-ssh.ts -> server/git-changes.ts':
    'Dependency-free shared repository-change notifier; preserve its singleton.',
  'git-ssh.ts -> server/workspace/pipeline-triggers.ts':
    'Existing push-to-pipeline trigger/acknowledgment coupling; needs a later release port.',
  'git-ssh.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'project-collaboration.ts -> server/application-spec.ts':
    'Existing release manifest compiler/decoder; preserve validation and error text.',
  'project-collaboration.ts -> server/features/tasks/checkpoint-retention.ts':
    'Existing cleanup of task checkpoint refs when closing merged work.',
  'project-collaboration.ts -> server/features/tasks/follow-up.ts':
    'Existing task baseline adoption/refresh after pull merges.',
  'project-collaboration.ts -> server/workspace/pipeline-triggers.ts':
    'Existing push-to-pipeline trigger/acknowledgment coupling; needs a later release port.',
  'project-collaboration.ts -> server/workspace/question-lifecycle.ts':
    'Existing cancellation of task questions after collaboration closes work.',
  'project-collaboration.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'project-collaboration.ts -> server/features/tasks/task-workspace.ts':
    'Existing task creation from issues and pulls; needs a later task-command port.',
  'project-collaboration.ts -> server/features/tasks/workspace-checks.ts':
    'Existing pull check projection used for collaboration admission.',
  'project-tools.ts -> server/workspace/coordination.ts':
    'Type-only AgentScope contract; moving the contract is outside this pure move.',
  'project-tools.ts -> server/workspace/pipelines.ts':
    'Existing project tool pipeline commands; needs a later release-command port.',
  'project-tools.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'projects.ts -> server/application-spec.ts':
    'Existing release manifest compiler/decoder; preserve validation and error text.',
  'projects.ts -> server/secrets.ts':
    'Existing encrypted project configuration transfer; retain its scoped addresses.',
  'projects.ts -> server/store.ts':
    'Existing engine database and deployment membership reads; preserve bootstrap order.',
  'projects.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'repositories.ts -> server/application-spec.ts':
    'Existing release manifest compiler/decoder; preserve validation and error text.',
  'repositories.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'repository-creation-worker.ts -> server/features/tasks/checkpoint.ts':
    'Existing task snapshot/base restoration during repository creation and recovery.',
  'repository-creation.ts -> server/workspace/coordination.ts':
    'Type-only AgentScope contract; moving the contract is outside this pure move.',
  'repository-creation.ts -> server/workspace/pipeline-triggers.ts':
    'Existing push-to-pipeline trigger/acknowledgment coupling; needs a later release port.',
  'repository-creation.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'repository-lfs.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'repository-runner.ts -> server/features/tasks/checkpoint.ts':
    'Existing task snapshot/base restoration during repository creation and recovery.',
  'repository-runner.ts -> server/workspace/pipeline-triggers.ts':
    'Existing push-to-pipeline trigger/acknowledgment coupling; needs a later release port.',
  'repository-runner.ts -> server/features/tasks/scratch.ts':
    'Existing task scratch-workspace initialization during repository operations.',
  'repository-runner.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'repository-setup.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'repository-views.ts -> server/git-changes.ts':
    'Dependency-free shared repository-change notifier; preserve its singleton.',
  'repository-views.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
  'ssh-keys.ts -> server/workspace/store.ts':
    'Existing workspace schema, record adapters and bootstrap; splitting it changes behavior.',
};

test('repositories cannot import v2, transports or unreviewed feature implementations', () => {
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
      if (!specifier.startsWith('.')) continue;
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
      assert.ok(!/^server\/(?:v2|transports|api)\//.test(target), `${name} -> ${target}`);
      if (!target.startsWith('server/')) continue;
      // Existing dependency-free registration ports are an allowed boundary.
      const port = target.match(
        /^server\/workspace\/(collaboration-preferences|merge-permission)-port\.ts$/,
      );
      if (port) {
        assert.deepEqual(imports(readFileSync(destination, 'utf8')), [
          `../contracts/${port[1]}.ts`,
        ]);
        continue;
      }
      if (/^server\/(?:kernel|contracts|features\/repositories)\//.test(target)) continue;
      const edge = `${name} -> ${target}`;
      assert.ok(exceptions[edge], edge);
      actual.add(edge);
    }
  }
  assert.deepEqual([...actual].sort(), Object.keys(exceptions).sort());
});

test('repository boundary scanner includes every supported import form', () => {
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
