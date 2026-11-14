import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerRoleId } from './computer-roles.ts';
import type { Role } from '../shared/v2/contracts.ts';

const root = mkdtempSync(join(tmpdir(), 'computer-policy-matrix-'));
process.env.DEPLOY_DATA_DIR = root;
const nodes = await import('./store/nodes.ts');
const engine = await import('./store.ts');
const records = await import('./workspace/store.ts');
// Intentionally the compatibility paths: this test is run before and after the move.
const policy = await import('./workspace/computer-role-policy.ts');
const alias = await import('./workspace/computer-roles.ts');
after(() => {
  engine._resetDb();
  records.db.close();
  rmSync(root, { recursive: true, force: true });
});
const engineRoles: ComputerRoleId[] = ['tasks', 'computer', 'browser', 'deploy'];
const productRoles: Role[] = [
  'take-tasks',
  'use-screen',
  'run-apps',
  'serve-models',
  'coordinator',
];

test('old-path role matrix: identity, both switches, removal, reservation and worker kinds', () => {
  const node = nodes.redeemNodeEnrollment({
    code: nodes.createNodeEnrollment('Matrix node', 'owner').code,
  }).nodeId!;
  const kinds = [
    { id: 'local', computer: 'coordinator' },
    { id: 'managed', computer: 'coordinator', managed: true },
    { id: `node-worker-${node}`, computer: node },
    { id: 'node-worker-missing', computer: 'node-worker-missing' },
    { id: 'remote-linked', computer: node, nodeId: node },
    { id: 'remote-missing', computer: 'remote-missing', nodeId: 'missing' },
    { id: 'remote', computer: 'remote' },
  ];
  let cases = 0;
  for (const worker of kinds) {
    for (const role of [...engineRoles, ...productRoles]) {
      for (const preference of [undefined, false, true]) {
        for (const record of ['absent', 'listed', 'omitted', 'removed', 'unrelated']) {
          for (const reserved of [false, true]) {
            const owner = `matrix-${cases++}`;
            records.save('worker', owner, { id: worker.id, nodeId: worker.nodeId });
            if (worker.managed) records.save('managed-worker', owner, { id: worker.id });
            // Each computer gets a fresh complete preference object, including the unset case.
            engine
              .getSqlite()!
              .prepare('DELETE FROM computer_role_preferences WHERE id=?')
              .run(worker.computer);
            nodes.setComputerRolePreferences(
              worker.computer,
              preference === undefined
                ? {}
                : {
                    tasks: preference,
                    computer: preference,
                    browser: preference,
                    deploy: preference,
                  },
            );
            if (record !== 'absent')
              records.save('v2-computer-roles', owner, {
                id: worker.computer,
                workerIds: record === 'unrelated' ? ['someone-else'] : [worker.id],
                roles: record === 'omitted' ? [] : productRoles,
                removed: record === 'removed',
              });
            if (reserved)
              records.save('v2-update-reservation', 'system', {
                id: 'reservation',
                workers: [{ owner, id: worker.id }],
              });
            else records.remove('v2-update-reservation', 'system', 'reservation');
            assert.equal(policy.workerComputerId(owner, worker.id), worker.computer);
            const recorded = !reserved && !['omitted', 'removed'].includes(record);
            const mapped = ['tasks', 'computer', 'take-tasks', 'use-screen'].includes(role);
            const legacy = engineRoles.includes(role as ComputerRoleId)
              ? preference !== false && (!mapped || recorded)
              : recorded && (!mapped || preference !== false);
            const actual = engineRoles.includes(role as ComputerRoleId)
              ? policy.workerRoleEnabled(owner, worker.id, role as ComputerRoleId)
              : policy.workerRole(owner, worker.id, role as Role);
            const label = JSON.stringify({ worker, role, preference, record, reserved });
            // The only permitted worker-policy tightening is the previously unmapped
            // deploy/browser reservation hole. Dedicated removal tests require it after the move.
            if (reserved && ['browser', 'deploy'].includes(role)) {
              assert.ok(!actual || legacy, label);
            } else assert.equal(actual, legacy, label);
          }
        }
      }
    }
  }
  assert.equal(cases, 1890);
  assert.equal(alias.workerRole, policy.workerRole);
});
