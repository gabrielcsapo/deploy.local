import { computerRole } from '../kernel/computers/policy.ts';
import type { Project } from '../../shared/v2/contracts.ts';
import { getComputers } from './computers.ts';
import { readDeploymentRecord } from '../store.ts';
import { readDeploymentDefinition } from '../deploy-config.ts';
import { fail } from '../kernel/errors.ts';

export type ShipChoices = {
  apps: {
    appId: string;
    computerId: string;
    address: string;
    visibility: 'private' | 'home';
    data: 'keep' | 'new';
  }[];
};
export type ShipPlan = ShipChoices & {
  computers: { id: string; name: string }[];
};

export function releaseChoices(owner: string, project: Project): ShipPlan {
  const computers = getComputers(owner)
    .filter(
      (computer) =>
        computer.nodeId &&
        computer.online &&
        computer.roles.includes('run-apps') &&
        computerRole(owner, computer.nodeId, 'run-apps'),
    )
    .map((computer) => ({ id: computer.nodeId!, name: computer.name }));
  return {
    computers,
    apps: project.apps.map((app) => {
      const deployment = readDeploymentRecord(app.name);
      if (!deployment || deployment.username !== owner) fail('App not found', 404);
      const spec = deployment.directory
        ? readDeploymentDefinition(deployment.directory).compiled.spec
        : undefined;
      return {
        appId: app.id,
        computerId: deployment.desiredNodeId || deployment.activeNodeId || 'coordinator',
        address: Object.values(spec?.routes || {})[0]?.hostname || `${app.name}.local`,
        visibility: deployment.discoverable ? 'home' : 'private',
        data: deployment.containerId ? 'keep' : 'new',
      };
    }),
  };
}

export function validateReleaseChoices(
  owner: string,
  project: Project,
  input: unknown,
): ShipChoices {
  const plan = releaseChoices(owner, project);
  const choices = input as ShipChoices;
  if (
    !choices ||
    !Array.isArray(choices.apps) ||
    choices.apps.length !== project.apps.length ||
    new Set(choices.apps.map((app) => app?.appId)).size !== project.apps.length
  )
    fail('Choose settings for every app exactly once');
  for (const app of choices.apps) {
    if (
      !project.apps.some((member) => member.id === app.appId) ||
      !plan.computers.some((computer) => computer.id === app.computerId)
    )
      fail('Choose an online computer with Run apps', 409);
    if (!['private', 'home'].includes(app.visibility) || !['keep', 'new'].includes(app.data))
      fail('Choose who can open the app and how to use its data');
    if (
      typeof app.address !== 'string' ||
      app.address.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/.test(app.address)
    )
      fail('Choose a local address, such as home-gym.local');
    const deployment = readDeploymentRecord(app.appId)!;
    if (deployment.containerId && app.data === 'new')
      fail(
        'Existing data is preserved during releases; restore a backup separately to replace it',
        409,
      );
    if (deployment.containerId && app.computerId !== (deployment.activeNodeId || 'coordinator'))
      fail('Move existing app data to that computer before releasing there', 409);
  }
  return {
    apps: choices.apps.map(({ appId, computerId, address, visibility, data }) => ({
      appId,
      computerId,
      address,
      visibility,
      data,
    })),
  };
}
