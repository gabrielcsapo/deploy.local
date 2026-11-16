import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { root } from './test-import-graph.ts';

const directory = join(root, 'server/features/tasks');
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
  'interactive-runtime.ts -> playwright':
    'Existing optional browser runtime and types; preserve lazy browser startup.',
  'screenshot-runtime.ts -> playwright':
    'Existing optional screenshot browser runtime; preserve lazy browser startup.',
  'terminal-relay.ts -> ws':
    'Existing WebSocket implementation; preserve terminal transport behavior.',
  'attachment-input.ts -> shared/v2/contracts.ts':
    'Existing public task/media types; preserve the shared contract.',
  'read-state.ts -> shared/v2/contracts.ts':
    'Existing public task/media types; preserve the shared contract.',
  'screenshot-runtime.ts -> shared/v2/contracts.ts':
    'Existing public task/media types; preserve the shared contract.',
  'task-workspace.ts -> shared/v2/contracts.ts':
    'Existing public task/media types; preserve the shared contract.',
  'checkpoint-publish.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'checkpoint-retention.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'checks.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'follow-up.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'interactive.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'job-artifacts.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'publish.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'queued-message.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'read-state.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'run-recovery.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'task-delete.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'task-files.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'task-presentation.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'task-workspace.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'terminal-service.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'update-base.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'workspace-checks.ts -> server/workspace/store.ts':
    'Existing workspace records, events and bootstrap; preserve schema and evaluation order.',
  'follow-up.ts -> server/workspace/review.ts':
    'Existing patch/digest implementation retained to satisfy the runtime port order guard.',
  'publish.ts -> server/workspace/review.ts':
    'Existing patch/digest implementation retained to satisfy the runtime port order guard.',
  'turn-checkpoint.ts -> server/workspace/review.ts':
    'Existing patch/digest implementation retained to satisfy the runtime port order guard.',
  'interactive-runtime.ts -> server/workspace/node-control.ts':
    'Existing worker pause policy; moving computer control is outside this task move.',
  'interactive-runtime.ts -> server/workspace/node-permissions.ts':
    'Existing worker capability policy; preserve interactive admission.',
  'interactive.ts -> server/workspace/node-permissions.ts':
    'Existing worker capability policy; preserve interactive admission.',
  'interactive-runtime.ts -> server/workspace/linux-desktop.ts':
    'Existing Linux desktop adapter; preserve computer-control execution.',
  'interactive.ts -> server/workspace/computer-role-policy.ts':
    'Existing effective worker-role checks; preserve refusals and placement.',
  'task-workspace.ts -> server/workspace/computer-role-policy.ts':
    'Existing effective worker-role checks; preserve refusals and placement.',
  'interactive.ts -> server/workspace/attachments.ts':
    'Existing media storage retained to satisfy the runtime port order guard.',
  'job-artifacts.ts -> server/workspace/attachments.ts':
    'Existing media storage retained to satisfy the runtime port order guard.',
  'queued-message.ts -> server/workspace/attachments.ts':
    'Existing media storage retained to satisfy the runtime port order guard.',
  'task-delete.ts -> server/workspace/attachments.ts':
    'Existing media storage retained to satisfy the runtime port order guard.',
  'interactive.ts -> server/features/agents/coordination.ts':
    'Existing worker projection and AgentScope type; preserve admission and placement.',
  'job-artifacts.ts -> server/features/agents/coordination.ts':
    'Existing worker projection and AgentScope type; preserve admission and placement.',
  'task-workspace.ts -> server/features/agents/coordination.ts':
    'Existing worker projection and AgentScope type; preserve admission and placement.',
  'job-artifacts.ts -> server/features/releases/application-deployment.ts':
    'Existing deployment log redaction; preserve artifact secret filtering.',
  'job-runner.ts -> server/workspace/git-url-migration.ts':
    'Existing managed Git URL compatibility; preserve job checkout behavior.',
  'job-runner.ts -> server/features/packages/package-publish.ts':
    'Existing package-job completion; preserve publication acknowledgments.',
  'job-runner.ts -> shared/package-install.mjs':
    'Existing package install and secret-output handling shared with workers.',
  'job-runner.ts -> server/workspace/shell-environment.ts':
    'Existing job shell environment; preserve executable lookup.',
  'media-files.ts -> app/routes/dashboard/task-file-link.ts':
    'Existing dependency-free file-reference parser; preserve media link interpretation.',
  'publish.ts -> server/workspace/checkpoint-commit.ts':
    'Existing checkpoint commit code retained to satisfy the product port order guard.',
  'update-base.ts -> server/workspace/checkpoint-commit.ts':
    'Existing checkpoint commit code retained to satisfy the product port order guard.',
  'publish.ts -> server/workspace/service.ts':
    'Existing task/run service retained to satisfy the runtime port order guard.',
  'read-state.ts -> server/workspace/service.ts':
    'Existing task/run service retained to satisfy the runtime port order guard.',
  'task-presentation.ts -> server/workspace/service.ts':
    'Existing task/run service retained to satisfy the runtime port order guard.',
  'task-workspace.ts -> server/workspace/service.ts':
    'Existing task/run service retained to satisfy the runtime port order guard.',
  'update-base.ts -> server/workspace/service.ts':
    'Existing task/run service retained to satisfy the runtime port order guard.',
  'publish.ts -> server/features/releases/pipeline-triggers.ts':
    'Existing push-to-pipeline trigger; preserve publication event ordering.',
  'publish.ts -> shared/task-title.ts':
    'Existing shared task title formatting; preserve visible text.',
  'task-presentation.ts -> shared/task-title.ts':
    'Existing shared task title formatting; preserve visible text.',
  'task-workspace.ts -> shared/task-title.ts':
    'Existing shared task title formatting; preserve visible text.',
  'update-base.ts -> shared/task-title.ts':
    'Existing shared task title formatting; preserve visible text.',
  'queued-message.ts -> server/features/decisions/question-lifecycle.ts':
    'Existing cancellation of task questions when a queued message is sent.',
  'read-state.ts -> server/features/decisions/questions.ts':
    'Existing waiting-for-answer projection; preserve task read state.',
  'read-state.ts -> server/workspace/run-queue.ts':
    'Existing run queue retained to satisfy the runtime port order guard.',
  'run-recovery.ts -> server/workspace/run-queue.ts':
    'Existing run queue retained to satisfy the runtime port order guard.',
  'task-workspace.ts -> server/workspace/run-queue.ts':
    'Existing run queue retained to satisfy the runtime port order guard.',
  'task-files.ts -> server/workspace/managed-worker.ts':
    'Existing managed-worker root lookup; preserve task file scope.',
  'task-presentation.ts -> shared/check-label.ts':
    'Existing shared check labels; preserve visible verification text.',
  'workspace-checks.ts -> shared/check-label.ts':
    'Existing shared check labels; preserve visible verification text.',
  'task-presentation.ts -> shared/check-attempts.ts':
    'Existing shared check-attempt projection; preserve task presentation.',
  'task-workspace.ts -> server/workspace/tool-probes.ts':
    'Existing tool probes retained to satisfy the product port order guard.',
  'task-workspace.ts -> server/workspace/worker-capabilities.ts':
    'Existing executable validation and worker capability probes.',
  'terminal-service.ts -> server/workspace/shell-commands.ts':
    'Existing shell audit persistence retained to satisfy the runtime port order guard.',
  'update-base.ts -> server/workspace/protocol.ts':
    'Existing worker protocol retained to satisfy the product port order guard.',
  'update-base.ts -> server/workspace/update-base-worker.ts':
    'Existing worker-side base-update journal; keep the worker module at its old path.',
};

test('tasks cannot import v2, API, transports or unreviewed feature implementations', () => {
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
      assert.ok(!/^server\/(?:v2|transports|api)\//.test(target), `${name} -> ${target}`);
      // Existing dependency-free registration ports are an allowed boundary.
      const port = target.match(
        /^server\/workspace\/(task-run-starter|question-answer-resumer)-port\.ts$/,
      );
      if (port) {
        assert.deepEqual(imports(readFileSync(destination, 'utf8')), [
          `../contracts/${port[1]}.ts`,
        ]);
        continue;
      }
      if (/^server\/(?:kernel|contracts|features\/(?:tasks|repositories))\//.test(target)) continue;
      const edge = `${name} -> ${target}`;
      assert.ok(exceptions[edge], edge);
      actual.add(edge);
    }
  }
  assert.deepEqual([...actual].sort(), Object.keys(exceptions).sort());
});

test('task boundary scanner includes every supported import form', () => {
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
