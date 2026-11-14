import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { configureComputerNodes } from './kernel/computers/nodes.ts';
import { registerDatabase } from './kernel/db/named-store.ts';
import { openDatabase } from './kernel/db/sqlite.ts';
import {
  workerAvailable,
  workerRole,
  workerRoleEnabled,
  computerRole,
  deployRoleEnabled,
} from './kernel/computers/policy.ts';

function denied() {
  assert.equal(workerAvailable('owner', 'local'), false);
  for (const role of ['deploy', 'tasks', 'computer', 'browser'] as const)
    assert.equal(workerRoleEnabled('owner', 'local', role), false);
  for (const role of [
    'take-tasks',
    'run-apps',
    'use-screen',
    'serve-models',
    'coordinator',
  ] as const) {
    assert.equal(workerRole('owner', 'local', role), false);
    assert.equal(computerRole('owner', 'coordinator', role), false);
  }
  assert.equal(deployRoleEnabled('coordinator'), false);
}
test('no registration and either missing lookup fail closed', () => {
  denied();
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE records(kind TEXT,id TEXT,owner TEXT,data TEXT)');
  registerDatabase('workspace', db);
  denied(); // Workspace alone cannot grant a role without the engine lookup.
  configureComputerNodes({ node: () => null, preferences: () => ({}) });
  assert.equal(workerRole('owner', 'local', 'take-tasks'), true);
  db.close();
  denied(); // An unavailable workspace cannot grant a role either.
});

test('node registration alone cannot grant before workspace bootstrap', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { configureComputerNodes } = await import(${JSON.stringify(new URL('./kernel/computers/nodes.ts', import.meta.url).href)});
    const { workerRole, deployRoleEnabled } = await import(${JSON.stringify(new URL('./kernel/computers/policy.ts', import.meta.url).href)});
    configureComputerNodes({node: () => null, preferences: () => ({})});
    if (workerRole('owner', 'local', 'take-tasks') !== false || deployRoleEnabled('coordinator') !== false) process.exitCode = 1;
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
