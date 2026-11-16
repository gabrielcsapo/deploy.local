import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { imports, root, target } from './test-import-graph.ts';

const port = await import('./workspace/worker-entry-port.ts');
const { agentLaunch } = await import('./features/agents/agent-launch.ts');
const source = (file: string) => readFileSync(join(root, file), 'utf8');

test('an unwired worker entry names its port and process', () => {
  assert.throws(() => port.requireWorkerEntry('test process'), {
    message: 'WorkerEntry is not wired in test process',
  });
  for (const adapter of ['compatible', 'claude', 'codex'])
    assert.throws(() => agentLaunch({ adapter }), {
      message: 'WorkerEntry is not wired in agent launch',
    });
});

test('agent launch asks the registered worker entry for the same programs', () => {
  const calls: unknown[][] = [];
  port.registerWorkerEntry((...args: unknown[]) => {
    calls.push(args);
    return ['entry', String(args[0])];
  });
  assert.deepEqual(agentLaunch({ adapter: 'compatible' }).args, ['entry', 'compatible-agent']);
  assert.deepEqual(agentLaunch({ adapter: 'claude' }).args, ['entry', 'claude-agent']);
  const codex = agentLaunch({ adapter: 'codex' }).args;
  assert.ok(codex.includes(`mcp_servers.deploy.args=${JSON.stringify(['entry', 'mcp'])}`));
  assert.deepEqual(calls, [['compatible-agent'], ['claude-agent'], ['mcp']]);
});

test('wiring registers the original workerEntry function', async () => {
  const { wireWorkerEntry } = await import('./main/worker-entry.ts');
  const { workerEntry } = await import('./workspace/worker-entry.ts');
  wireWorkerEntry();
  assert.equal(port.requireWorkerEntry('test'), workerEntry);
});

test('worker entry contract is dependency-free', () => {
  assert.doesNotMatch(
    source('server/contracts/worker-entry.ts'),
    /\b(?:import|from|function|const|let|class|enum)\b/,
  );
  assert.deepEqual(
    imports(source('server/workspace/worker-entry-port.ts'), 'worker-entry-port.ts'),
    [],
  );
});

// Restore agent-launch's former worker-entry import at the port's slot, ignore the composition,
// and compare with the real graph. Do not derive the baseline from the composition itself.
const inert = new Set(['server/main/worker-entry.ts', 'server/workspace/worker-entry-port.ts']);
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
      if (original && name === 'server/workspace/worker-entry-port.ts')
        name = 'server/workspace/worker-entry.ts';
      else if (original && inert.has(name)) continue;
      visit(name);
    }
    if (!inert.has(file)) order.push(file);
  }
  visit(entry);
  return { order, visited };
}

for (const [entry, before] of [
  ['server/workspace/worker.ts', "claimWorker('local');"],
  ['server/workspace/remote-worker.ts', 'configureMacDesktopHelper();'],
] as const)
  test(`${entry} keeps its eager order and wires the worker entry before work`, () => {
    assert.deepEqual(evaluationOrder(entry, false).order, evaluationOrder(entry, true).order);
    const text = source(entry);
    assert.ok(
      text.includes(
        "import { wireWorkerEntry } from '../main/worker-entry.ts';\nimport { agentLaunch, agentModelEnvironment } from './agent-launch.ts';\n",
      ),
    );
    const wire = text.indexOf('\nwireWorkerEntry();');
    assert.ok(wire >= 0 && wire < text.indexOf(before), before);
    assert.ok(wire < text.indexOf('agentLaunch('));
  });

for (const entry of [
  'server/boot.ts',
  'server/workspace/repository-worker.ts',
  'server/workspace/pipeline-worker.ts',
  'server/workspace/preview.ts',
])
  test(`${entry} neither launches agents nor wires a worker entry`, () => {
    const { visited } = evaluationOrder(entry, false);
    assert.equal(visited.has('server/features/agents/agent-launch.ts'), false);
    assert.equal(visited.has('server/main/worker-entry.ts'), false);
  });
