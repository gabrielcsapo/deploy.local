import { readFile } from 'node:fs/promises';
import { deployDataPath } from '../kernel/files/data-directory.ts';
import { computerPackageKey } from './keys.ts';
import { getDeployment, getSqlite, getAgentJob, deployRoleEnabled } from '../store.ts';
import { packageHooks } from '../workspace/package-hooks.ts';
import { list } from '../workspace/store.ts';
import { workerComputerId } from '../workspace/computer-role-policy.ts';
export function projectPackagesEnabled(owner: string, projectId?: string) {
  return (
    !projectId ||
    list('v2-project-policy', owner).find((row) => row.id === projectId)?.installThroughDeploy !==
      false
  );
}
export async function computerInstallConfig(owner: string, computerId: string, projectId?: string) {
  if (!projectPackagesEnabled(owner, projectId))
    return { registry: 'https://registry.npmjs.org/', key: '', ca: '' };
  const ca = await readFile(deployDataPath('certs', 'ca.crt'), 'utf8').catch(() => '');
  const enrolledComputer = workerComputerId(owner, computerId);
  return {
    registry: 'https://deploy.local/npm/',
    key: computerPackageKey(owner, enrolledComputer),
    ca,
    ...(enrolledComputer === 'coordinator' ? { address: 'host-gateway' } : {}),
  };
}

/** Resolve scope from coordinator records, never from a worker-supplied owner or project. */
export function applicationPackageScope(application: string) {
  const deployment =
    getDeployment(application) ||
    (() => {
      const row = getSqlite()!
        .prepare('SELECT name FROM deployments WHERE app_id=?')
        .get(application) as { name: string } | undefined;
      return row ? getDeployment(row.name) : undefined;
    })();
  if (!deployment) return null;
  const owner = deployment.username;
  const link = getSqlite()!
    .prepare(
      'SELECT project_id AS projectId FROM project_applications WHERE owner=? AND application=?',
    )
    .get(owner, deployment.name) as { projectId: string } | undefined;
  const projectId =
    link?.projectId ||
    list('application-origin', owner).find((row) => row.id === deployment.name)?.projectId;
  return { owner, projectId };
}
export async function applicationInstallConfig(application: string, computerId: string) {
  const scope = applicationPackageScope(application);
  return scope ? computerInstallConfig(scope.owner, computerId, scope.projectId) : null;
}
export async function agentBuildInstallConfig(nodeId: string, jobId: string) {
  const job = getAgentJob(jobId);
  if (
    !job ||
    job.nodeId !== nodeId ||
    job.status !== 'running' ||
    !['deploy', 'project-release'].includes(job.type) ||
    !deployRoleEnabled(nodeId)
  )
    return null;
  const scope = applicationPackageScope(job.deploymentName);
  return scope ? packageHooks.installConfig(scope.owner, nodeId, scope.projectId) : null;
}
