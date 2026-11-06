import { readFile } from 'node:fs/promises';
import { deployDataPath } from '../data-directory.ts';
import { computerPackageKey } from './keys.ts';
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
