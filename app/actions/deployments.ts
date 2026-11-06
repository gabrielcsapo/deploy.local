'use server';
import { assertWanderLegacyAllowed } from '../../server/wander-adoption-fence.ts';
import { assertLegacyMutationAllowed } from '../../server/legacy-docker-update.ts';
import { withApplicationMutation } from '../../server/ci-fence.ts';
import {
  authenticate,
  getDeployments as _getDeployments,
  getDeployment as _getDeployment,
  deleteDeployment as _deleteDeployment,
  addDeployEvent,
  getDashboardAggregate as _getDashboardAggregate,
  getNode as _getNode,
  enqueueAgentJob as _enqueueAgentJob,
  getAgentJob as _getAgentJob,
  _invalidateDeploymentsCache,
} from '../../server/store.ts';
import {
  getAllContainerStatuses,
  removeContainer as _removeContainer,
} from '../../server/docker.ts';
import { deleteVolumes as _deleteVolumes } from '../../server/volumes.ts';
import { registerApplicationIdentity } from '../../server/multisite.ts';
import {
  applicationDeleteMutationFingerprint,
  assertFleetMutationReady,
} from '../../server/fleet-mutation-guard.ts';

function requireAuth(username: string, token: string) {
  if (!authenticate(username, token)) {
    throw new Error('Unauthorized');
  }
}

async function runRemoteCommand(
  nodeId: string,
  type: string,
  name: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 120_000,
  artifactPath?: string,
) {
  const node = _getNode(nodeId);
  if (!node?.online) throw new Error('Deployment node is offline');
  const queued = _enqueueAgentJob({
    nodeId,
    type,
    deploymentName: name,
    payload,
    artifactPath,
  });
  const deadline = Date.now() + timeoutMs;
  let job = _getAgentJob(queued.id);
  while (job && job.status !== 'complete' && job.status !== 'failed' && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    job = _getAgentJob(queued.id);
  }
  if (!job || (job.status !== 'complete' && job.status !== 'failed')) {
    throw new Error(`Timed out waiting for ${node.name}`);
  }
  if (job.status === 'failed') throw new Error(job.error || `Remote ${type} failed`);
  return job.result ? (JSON.parse(job.result) as Record<string, unknown>) : {};
}

const PRE_CONTAINER_STATES = new Set([
  'uploading',
  'backing-up',
  'building',
  'restoring',
  'starting',
]);

function resolveStatusBatched(
  d: {
    name: string;
    type?: string | null;
    status: string | null;
    activeNodeId?: string | null;
  },
  statusMap: Map<string, string>,
): string {
  if (d.type === 'application-graph') return d.status || 'unknown';
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    return _getNode(d.activeNodeId)?.online ? d.status || 'unknown' : 'node-offline';
  }
  if (d.status && PRE_CONTAINER_STATES.has(d.status)) return d.status;
  return statusMap.get(d.name.toLowerCase()) || 'stopped';
}

export async function fetchDeployments(username: string, token: string) {
  requireAuth(username, token);
  // The UI development server and production control plane are separate
  // processes sharing SQLite. Never let a UI-process cache outlive a control
  // plane status transition.
  _invalidateDeploymentsCache();
  const allDeps = _getDeployments(username);
  const statusMap = await getAllContainerStatuses();
  return allDeps.map((d) => ({
    ...d,
    status: resolveStatusBatched(d, statusMap),
  }));
}

export async function deleteDeployment(
  username: string,
  token: string,
  name: string,
  opts?: { deleteVolumes?: boolean },
) {
  requireAuth(username, token);
  return withApplicationMutation(name, async () => {
    assertWanderLegacyAllowed(name);
    assertLegacyMutationAllowed(name);
    requireAuth(username, token);
    const d = _getDeployment(name);
    if (!d || d.username !== username) throw new Error('Not found');
    const applicationId = d.appId || registerApplicationIdentity(name);
    assertFleetMutationReady({
      appId: applicationId,
      applicationName: name,
      kind: 'application-delete',
      mutationFingerprint: applicationDeleteMutationFingerprint(applicationId),
      consequence:
        'Deleting this application removes its Home runtime, graph record, and managed data. It cannot proceed while a selected suitcase may still hold an unreceived branch.',
      actor: username,
    });
    if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
      await runRemoteCommand(d.activeNodeId, 'delete', name, {
        deleteVolumes: opts?.deleteVolumes === true,
      });
    } else {
      await _removeContainer(name);
    }
    addDeployEvent(name, { action: 'delete', username });
    _deleteDeployment(name);
    if (opts?.deleteVolumes) _deleteVolumes(name);
    return { message: `Deleted ${name}` };
  });
}

export async function fetchDashboardAggregate(username: string, token: string) {
  requireAuth(username, token);
  return _getDashboardAggregate();
}
