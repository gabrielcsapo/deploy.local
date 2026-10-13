import { resolve } from 'node:path';
import { LegacyDockerUpdate, legacyRecoveryRoot } from './legacy-docker-update.ts';
import { deployDataPath } from './data-directory.ts';
import { buildImage } from './docker.ts';
import { dockerRequest } from './docker-api.ts';
import {
  getDeployment,
  getSqlite,
  isAdmin,
  saveDeployment,
  updateDeploymentStatus,
  updateDeploymentArtifactDigests,
} from './store.ts';

export function legacyUpdateService(
  name: string,
  username: string,
  sourceDirectory?: string,
  sourceDigest = '',
  buildOptions: { noCache?: boolean } = {},
) {
  const deployment = getDeployment(name);
  if (!deployment || deployment.username !== username)
    throw Object.assign(new Error('Not found'), { status: 404 });
  if (!isAdmin(username))
    throw Object.assign(new Error('Legacy host control requires administrator access'), {
      status: 403,
    });
  if (
    name !== 'groffee' ||
    deployment.containerName !== 'deploy-sh-groffee' ||
    deployment.activeSpecDigest ||
    !deployment.port ||
    (deployment.activeNodeId && deployment.activeNodeId !== 'coordinator') ||
    (deployment.desiredNodeId && deployment.desiredNodeId !== 'coordinator')
  )
    throw Object.assign(
      new Error('Only the existing same-host Groffee legacy runtime is supported'),
      { status: 409 },
    );
  const assertNoSuitcases = () => {
    if (
      deployment.appId &&
      getSqlite()!
        .prepare(
          "SELECT 1 FROM app_replicas r JOIN sites s ON s.id=r.site_id WHERE r.app_id=? AND r.removed_at IS NULL AND s.kind='suitcase' LIMIT 1",
        )
        .get(deployment.appId)
    )
      throw Object.assign(
        new Error(
          'Legacy compatibility cannot update an application with selected suitcase replicas',
        ),
        { status: 409 },
      );
  };
  assertNoSuitcases();
  const metadata = { ...deployment };
  return new LegacyDockerUpdate({
    containerName: deployment.containerName,
    volumeDirectory: deployDataPath('volumes', name),
    recoveryRoot: legacyRecoveryRoot(name),
    httpPort: deployment.port,
    publicSshPort: 2223,
    administrator: true,
    owner: true,
    nodeId: 'coordinator',
    activeGraphDigest: null,
    metadata,
    sourceDigest,
    guard: () => {
      assertNoSuitcases();
      const current = getDeployment(name);
      if (
        !current ||
        current.username !== username ||
        current.appId !== deployment.appId ||
        current.activeNodeId !== deployment.activeNodeId ||
        current.desiredNodeId !== deployment.desiredNodeId ||
        current.activeSpecDigest ||
        current.desiredSpecDigest !== deployment.desiredSpecDigest ||
        current.containerId !== deployment.containerId ||
        current.extraPorts !== deployment.extraPorts ||
        current.port !== deployment.port
      )
        throw new Error('Controller state changed during legacy update');
    },
    build: async () => {
      if (!sourceDirectory) throw new Error('A validated source upload is required');
      const result = await buildImage(name, resolve(sourceDirectory), undefined, buildOptions);
      if (!result.success) throw new Error('Legacy code build failed; existing writer untouched');
      const image = await dockerRequest<{ Id: string }>({
        method: 'GET',
        path: `/images/${encodeURIComponent(result.tag)}/json`,
      });
      return image.Id;
    },
    commit: async (containerId) => {
      saveDeployment({
        ...deployment,
        type: deployment.type ?? undefined,
        port: deployment.port ?? undefined,
        containerName: deployment.containerName ?? undefined,
        directory: sourceDirectory || deployment.directory || undefined,
        createdAt: deployment.createdAt ?? undefined,
        containerId,
      });
      updateDeploymentArtifactDigests(name, {
        sourceArtifactDigest: sourceDigest || deployment.sourceArtifactDigest,
      });
      updateDeploymentStatus(name, 'running');
    },
    restoreMetadata: async (old, containerId) => {
      // Private controller-authored journal; use ordinary store methods, never SQL patches.
      saveDeployment({
        name,
        username,
        type: old.type as string,
        port: old.port as number,
        containerName: 'deploy-sh-groffee',
        directory: old.directory as string,
        extraPorts: old.extraPorts as string | null,
        desiredNodeId: old.desiredNodeId as string | null,
        activeNodeId: old.activeNodeId as string | null,
        createdAt: old.createdAt as string,
        containerId,
      });
      updateDeploymentArtifactDigests(name, {
        sourceArtifactDigest: old.sourceArtifactDigest as string | null,
      });
      updateDeploymentStatus(name, 'running');
    },
  });
}
