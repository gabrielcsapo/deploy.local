import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = (file: string) => readFileSync(resolve(root, file), 'utf8');
const ports = [
  'agent-instructions',
  'repository-project',
  'collaboration-preferences',
  'merge-permission',
  'design-tool',
];
const compositions = [
  'server-workspace-ports',
  'repository-workspace-imports',
  'local-worker-instructions',
  'local-worker-tools',
  'preview-workspace-tools',
  'preview-workspace-projects',
  'workspace-agent-instructions',
  'workspace-repository-project',
  'workspace-collaboration-preferences',
  'workspace-lazy-tools',
].map((name) => `server/main/${name}.ts`);
const inert = new Set([
  ...compositions,
  ...ports.flatMap((name) => [`server/workspace/${name}-port.ts`, `server/contracts/${name}.ts`]),
]);
// Reconstruct the five original imports, not a baseline generated from the modified graph.
const originalImports: Record<string, string> = {
  'server/workspace/agent-instructions-port.ts': 'server/v2/agent-instructions.ts',
  'server/workspace/repository-project-port.ts': 'server/v2/projects.ts',
  'server/workspace/collaboration-preferences-port.ts': 'server/v2/auth-store.ts',
};
function evaluationOrder(entry: string, original: boolean) {
  const visited = new Set<string>();
  const order: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    for (const match of source(file).matchAll(
      /^\s*(?:import|export)\s+(?!type\b)(?:[^;'"`]*?\s+from\s*)?['"]([^'"]+)['"]/gm,
    )) {
      if (!match[1].startsWith('.')) continue;
      let target = relative(root, resolve(root, dirname(file), match[1]));
      if (original) {
        if (compositions.includes(target)) continue;
        target = originalImports[target] ?? target;
      }
      if (existsSync(resolve(root, target))) visit(target);
    }
    if (!inert.has(file)) order.push(file);
  }
  visit(entry);
  return { order, visited };
}

const processPorts = [
  {
    entry: 'server/boot.ts',
    wires: ['wireServerWorkspacePorts();'],
    before: [
      'startTerminalRelay();',
      'startAgentExecExpiry();',
      'startRemovedProjectCleanup();',
      'startPush();',
      'installCrashGuard(',
      'startSupervisorHeartbeat(',
      'start(options)',
    ],
    providers: [
      'agent-instructions',
      'repository-project',
      'collaboration-preferences',
      'lazy-tools',
    ],
  },
  {
    entry: 'server/workspace/repository-worker.ts',
    wires: [],
    before: [],
    providers: [],
  },
  {
    entry: 'server/workspace/pipeline-worker.ts',
    wires: [],
    before: [],
    providers: [],
  },
  {
    entry: 'server/workspace/worker.ts',
    wires: ['wireAgentInstructionsSource();', 'wireLocalWorkerTools();'],
    before: ["claimWorker('local')", 'recoverChecks();', 'createServer(', 'setInterval('],
    providers: ['agent-instructions', 'collaboration-preferences', 'lazy-tools'],
  },
  {
    entry: 'server/workspace/preview.ts',
    wires: ['wirePreviewWorkspaceTools();', 'wireRepositoryProjectCreator();'],
    before: ['registerUser(username', 'startTerminalRelay();', 'createServer(', 'spawn('],
    providers: [
      'agent-instructions',
      'repository-project',
      'collaboration-preferences',
      'lazy-tools',
    ],
  },
  { entry: 'server/workspace/remote-worker.ts', wires: [], before: [], providers: [] },
  { entry: 'bin/deploy.js', wires: [], before: [], providers: [] },
];

for (const { entry, wires, before, providers } of processPorts) {
  test(`${entry} preserves every eager module and its evaluation order`, () => {
    const actual = evaluationOrder(entry, false);
    assert.deepEqual(actual.order, evaluationOrder(entry, true).order);
    for (const name of [
      'agent-instructions',
      'repository-project',
      'collaboration-preferences',
      'lazy-tools',
    ])
      assert.equal(
        actual.visited.has(`server/main/workspace-${name}.ts`),
        providers.includes(name),
        name,
      );
  });
  test(`${entry} wires its ports before starting work`, () => {
    const text =
      entry === 'server/boot.ts'
        ? source(entry).slice(source(entry).indexOf('export function bootServer'))
        : source(entry);
    for (const wire of wires) {
      const position = text.indexOf(wire);
      assert.ok(position >= 0, wire);
      for (const call of before)
        assert.ok(position < text.indexOf(call) && text.indexOf(call) >= 0, call);
    }
  });
}

test('repository entry retains auth bootstrap without wiring or reading preferences', () => {
  const graph = evaluationOrder('server/workspace/repository-worker.ts', false);
  assert.ok(graph.visited.has('server/v2/auth-store.ts'));
  assert.ok(graph.visited.has('server/main/repository-workspace-imports.ts'));
  assert.ok(!graph.visited.has('server/main/workspace-collaboration-preferences.ts'));
  const collaboration = source('server/workspace/project-collaboration.ts');
  const presentation = collaboration.slice(
    collaboration.indexOf('async function presentPull'),
    collaboration.indexOf('async function presentPull') + 4000,
  );
  assert.equal(
    (collaboration.match(/requireCollaborationPreferencesSource\('workspace'\)/g) ?? []).length,
    3,
  );
  assert.equal(
    (presentation.match(/requireCollaborationPreferencesSource\('workspace'\)/g) ?? []).length,
    3,
  );
});

for (const port of ports)
  test(`${port} contract is dependency-free and contains only types`, () => {
    const text = source(`server/contracts/${port}.ts`);
    assert.doesNotMatch(text, /\b(?:import|from|function|const|let|class|enum)\b/);
  });
