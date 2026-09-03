import { getApplicationGraphState, getApplicationSpecRevision, getDeployment } from './store.ts';

export interface ApplicationInstanceSelector {
  siteId?: string;
  component?: string;
  instanceId?: string;
}

export interface ApplicationInstanceTarget {
  deploymentName: string;
  siteId: string;
  nodeId: string;
  component: string;
  instanceId: string;
  slot: string;
  containerName: string;
  graph: boolean;
}

/** Resolve an operator action to one durable graph instance, never a guessed Docker name. */
export function resolveApplicationInstanceTarget(
  deploymentName: string,
  selector: ApplicationInstanceSelector = {},
): ApplicationInstanceTarget {
  const deployment = getDeployment(deploymentName);
  if (!deployment) throw new Error('Deployment not found');
  const deployedSiteId = deployment.activeNodeId || deployment.desiredNodeId || 'coordinator';
  const siteId = selector.siteId || deployedSiteId;
  const revision = deployment.activeSpecDigest
    ? getApplicationSpecRevision(deployment.name, deployment.activeSpecDigest)
    : null;
  if (!revision || revision.manifestFormat !== 'deploy.yaml' || !deployment.appId) {
    if (selector.component || selector.instanceId) {
      throw new Error('Component and instance selectors require an application graph');
    }
    if (selector.siteId && selector.siteId !== deployedSiteId) {
      throw new Error(`Legacy deployment is not materialized on site ${selector.siteId}`);
    }
    return {
      deploymentName: deployment.name,
      siteId,
      nodeId: deployedSiteId,
      component: 'main',
      instanceId: 'legacy',
      slot: 'main',
      containerName: deployment.containerName || `deploy-sh-${deployment.name.toLowerCase()}`,
      graph: false,
    };
  }

  const state = getApplicationGraphState(deployment.name, deployment.appId, siteId);
  const candidates = state.instances
    .filter((instance) => instance.status !== 'removed' && instance.status !== 'failed')
    .filter((instance) => !selector.component || instance.componentKey === selector.component)
    .filter((instance) => !selector.instanceId || instance.id === selector.instanceId)
    .sort((left, right) =>
      `${left.componentKey}/${left.slotKey}/${left.id}`.localeCompare(
        `${right.componentKey}/${right.slotKey}/${right.id}`,
      ),
    );
  const selected =
    candidates.find((instance) => instance.containerName === deployment.containerName) ||
    candidates.find((instance) => instance.status === 'ready') ||
    candidates[0];
  if (!selected) {
    const detail = selector.instanceId
      ? `instance ${selector.instanceId}`
      : selector.component
        ? `component ${selector.component}`
        : 'active graph instance';
    throw new Error(`No ${detail} is materialized on site ${siteId}`);
  }
  return {
    deploymentName: deployment.name,
    siteId,
    nodeId: selected.nodeId || siteId,
    component: selected.componentKey,
    instanceId: selected.id,
    slot: selected.slotKey,
    containerName: selected.containerName,
    graph: true,
  };
}
