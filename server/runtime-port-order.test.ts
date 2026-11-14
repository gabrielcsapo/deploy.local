import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { imports, root, target } from './test-import-graph.ts';

const compositions = [
  'state-refresh-sources',
  'task-run-starter',
  'agent-chat-source',
  'question-answer-resumer',
  'task-workspace-imports',
  'local-worker-task-runs',
  'repository-task-run-imports',
].map((name) => `server/main/${name}.ts`);
const ports = [
  'server/v2/state-refresh-sources-port.ts',
  'server/workspace/task-run-starter-port.ts',
  'server/v2/agent-chat-source-port.ts',
  'server/workspace/question-answer-resumer-port.ts',
];
const inert = new Set([...compositions, ...ports]);
const originalImports: Record<string, string> = {
  'server/workspace/task-run-starter-port.ts': 'server/workspace/service.ts',
  'server/workspace/question-answer-resumer-port.ts': 'server/workspace/questions.ts',
  'server/main/local-worker-task-runs.ts': 'server/workspace/questions.ts',
};
const source = (file: string) => readFileSync(join(root, file), 'utf8');

// Restore the removed edges at their original import slots. Do not derive a baseline from
// the new graph: in particular worker -> questions -> service was a different cycle entry.
function evaluationOrder(entry: string, original: boolean) {
  const visited = new Set<string>();
  const order: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    for (const dependency of imports(source(file), file)) {
      if (dependency.dynamic) continue;
      const path = target(file, dependency.specifier);
      if (!path) continue;
      let name = relative(root, path);
      if (original) {
        if (originalImports[name]) name = originalImports[name];
        else if (inert.has(name)) continue;
      }
      visit(name);
    }
    if (!inert.has(file)) order.push(file);
  }
  visit(entry);
  return { order, visited };
}

const processes = [
  {
    entry: 'server/boot.ts',
    wires: [
      'wireTaskRunStarter();',
      'wireQuestionAnswerResumer();',
      'wireStateRefreshSources();',
      'wireAgentChatSource();',
    ],
    before: 'startTerminalRelay();',
  },
  {
    entry: 'server/workspace/repository-worker.ts',
    wires: [],
    before: "claimWorker('repositories');",
  },
  { entry: 'server/workspace/pipeline-worker.ts', wires: [], before: "claimWorker('pipelines');" },
  {
    entry: 'server/workspace/worker.ts',
    wires: ['wireLocalWorkerTaskRuns();'],
    before: "claimWorker('local');",
  },
  { entry: 'server/workspace/remote-worker.ts', wires: [], before: '' },
  {
    entry: 'server/workspace/preview.ts',
    wires: ['wireTaskRunStarter();', 'wireQuestionAnswerResumer();'],
    before: 'registerUser(username',
  },
  { entry: 'bin/deploy.js', wires: [], before: '' },
];
for (const { entry, wires, before } of processes) {
  test(`${entry} preserves the original eager modules and evaluation order`, () => {
    assert.deepEqual(evaluationOrder(entry, false).order, evaluationOrder(entry, true).order);
  });
  test(`${entry} wires only callable runtime ports before work`, () => {
    const graph = evaluationOrder(entry, false);
    const text =
      entry === 'server/boot.ts'
        ? source(entry).split('export function bootServer')[1]
        : source(entry);
    for (const wire of wires)
      assert.ok(text.indexOf(wire) >= 0 && text.indexOf(wire) < text.indexOf(before), wire);
    const taskProcess = [
      'server/boot.ts',
      'server/workspace/worker.ts',
      'server/workspace/preview.ts',
    ].includes(entry);
    for (const name of ['task-run-starter', 'question-answer-resumer'])
      assert.equal(graph.visited.has(`server/main/${name}.ts`), taskProcess, name);
    for (const name of ['state-refresh-sources', 'agent-chat-source'])
      assert.equal(graph.visited.has(`server/main/${name}.ts`), entry === 'server/boot.ts', name);
  });
}

for (const name of [
  'state-refresh-sources',
  'task-run-starter',
  'agent-chat-source',
  'question-answer-resumer',
])
  test(`${name} contract is dependency-free`, () => {
    assert.doesNotMatch(
      source(`server/contracts/${name}.ts`),
      /\b(?:import|from|function|const|let|class|enum)\b/,
    );
  });
