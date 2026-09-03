import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  reconcileLocalApplicationGraphs,
  type ApplicationGraphSupervisorDependencies,
  type SupervisedGraphDeployment,
} from './application-graph-supervisor.ts';

test('continuous graph reconciliation heals only active local graph deployments and isolates failures', async () => {
  const deployments: SupervisedGraphDeployment[] = [
    { name: 'healthy', status: 'running', activeSpecDigest: 'sha256:one' },
    { name: 'broken', status: 'degraded', activeSpecDigest: 'sha256:two' },
    { name: 'remote', status: 'running', activeSpecDigest: 'sha256:three' },
    { name: 'legacy', status: 'running', activeSpecDigest: 'sha256:four' },
    { name: 'stopped', status: 'stopped', activeSpecDigest: 'sha256:five' },
  ];
  const reconciled: string[] = [];
  const failures: string[] = [];
  const dependencies: ApplicationGraphSupervisorDependencies = {
    listDeployments: () => deployments,
    isGraph: (deployment) => deployment.name !== 'legacy',
    isLocal: (deployment) => deployment.name !== 'remote',
    async reconcile(deployment) {
      reconciled.push(deployment.name);
      if (deployment.name === 'broken') throw new Error('unhealthy container');
    },
    onError(deployment, error) {
      failures.push(`${deployment.name}:${(error as Error).message}`);
    },
  };

  await reconcileLocalApplicationGraphs(dependencies);

  assert.deepEqual(reconciled, ['healthy', 'broken']);
  assert.deepEqual(failures, ['broken:unhealthy container']);
});
