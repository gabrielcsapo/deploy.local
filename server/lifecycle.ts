import {
  getAllDeployments,
  updateDeploymentStatus,
  saveDeployment,
  recordContainerStart,
  updateDeploymentConfigurationDigest,
  getApplicationSpecRevision,
} from './store.ts';
import {
  getAllContainerStatuses,
  stopContainer,
  restartContainer,
  recreateContainer,
  sweepOrphanedPrevContainers,
} from './docker.ts';
import { getVolumeDir } from './volumes.ts';
import { emit } from './events.ts';
import { stopAllProxies } from './tcp-proxy.ts';
import { resolveApplicationGraphRuntime, resolveDeploymentRuntime } from './application-runtime.ts';
import { ApplicationGraphExecutor } from './application-graph-executor.ts';
import { applicationWriterSiteId } from './application-authority.ts';

const CONFIGURATION_REQUIRED_STATUS = 'configuration-required';

/**
 * Sync deployment status from Docker on server startup
 * This ensures the database matches the actual Docker container state
 */
export async function syncContainerStates() {
  console.log('Syncing container states...');

  // Clean up blue/green leftovers from a crash mid-drain before reading
  // statuses, so the swept containers don't pollute the status map.
  await sweepOrphanedPrevContainers();

  const deployments = getAllDeployments();
  let synced = 0;

  // Old version did one `docker inspect` per deployment (sequential execSync).
  // For 50 apps that was ~2-5s of blocked event loop. One `docker ps` returns
  // all states in a single call.
  const statusMap = await getAllContainerStatuses();

  for (const deployment of deployments) {
    try {
      if (isGraphDeployment(deployment)) continue;
      const dockerStatus = statusMap.get(deployment.name.toLowerCase()) || 'stopped';
      const dbStatus = deployment.status || 'stopped';
      const transitional = [
        'uploading',
        'backing-up',
        'restoring',
        'building',
        'starting',
        CONFIGURATION_REQUIRED_STATUS,
      ].includes(dbStatus);
      const runsOnCoordinator =
        !deployment.activeNodeId || deployment.activeNodeId === 'coordinator';

      if (dockerStatus !== dbStatus && !transitional && runsOnCoordinator) {
        console.log(`  ${deployment.name}: ${dbStatus} -> ${dockerStatus}`);
        updateDeploymentStatus(deployment.name, dockerStatus);
        emit({
          type: 'deployment:status',
          deploymentName: deployment.name,
          data: { status: dockerStatus },
        });
        synced++;
      }
    } catch (err) {
      console.error(`  Error syncing ${deployment.name}:`, err);
    }
  }

  if (synced > 0) {
    console.log(`Container states synced (${synced} updated)`);
  }
}

/**
 * Start all stopped containers
 * Called when deploy.local starts up
 */
export async function startAllContainers() {
  console.log('Starting all containers...');
  const deployments = getAllDeployments();

  if (deployments.length === 0) {
    console.log('  No deployments found');
    return;
  }

  // Resolve all container statuses with one `docker ps` instead of N `docker
  // inspect` calls. Then start each container with bounded concurrency so we
  // don't spawn N parallel `docker run` invocations on a fresh boot.
  const statusMap = await getAllContainerStatuses();
  const CONCURRENCY = 4;

  let cursor = 0;
  const startContainer = async (deployment: (typeof deployments)[number]) => {
    if (deployment.activeNodeId && deployment.activeNodeId !== 'coordinator') {
      console.log(`  ${deployment.name}: assigned to remote node, skipping local start`);
      return false;
    }
    if (isGraphDeployment(deployment)) {
      if (!deployment.directory) throw new Error('Application graph source directory is missing');
      const runtime = resolveApplicationGraphRuntime(deployment);
      if (!runtime.ready) {
        console.log(`  ${deployment.name}: missing configuration (${runtime.missing.join(', ')})`);
        updateDeploymentStatus(deployment.name, CONFIGURATION_REQUIRED_STATUS);
        return false;
      }
      console.log(`  Starting application graph ${deployment.name}...`);
      updateDeploymentStatus(deployment.name, 'starting');
      const result = await new ApplicationGraphExecutor().converge({
        deploymentName: deployment.name,
        applicationId: deployment.appId || deployment.name,
        siteId: deployment.activeNodeId || deployment.desiredNodeId || 'coordinator',
        nodeId: deployment.activeNodeId || deployment.desiredNodeId || 'coordinator',
        projectDirectory: deployment.directory,
        runtime,
        writerSiteId: applicationWriterSiteId(deployment.appId || deployment.name),
        memoryLimit: deployment.memoryLimit || '4g',
        cpuLimit: deployment.cpuLimit || undefined,
      });
      saveDeployment({
        name: deployment.name,
        type: deployment.type || undefined,
        username: deployment.username,
        port: result.primaryPort ?? undefined,
        containerId: result.primaryContainerId ?? undefined,
        containerName: result.primaryContainerName ?? undefined,
        directory: deployment.directory,
        desiredNodeId: deployment.desiredNodeId,
        activeNodeId: deployment.activeNodeId,
        createdAt: deployment.createdAt || undefined,
      });
      recordContainerStart(deployment.name);
      updateDeploymentStatus(deployment.name, 'running');
      emit({
        type: 'deployment:status',
        deploymentName: deployment.name,
        data: { status: 'running' },
      });
      return true;
    }

    const status = statusMap.get(deployment.name.toLowerCase()) || 'stopped';
    console.log(`  ${deployment.name}: status=${status}`);

    if (status === 'running') {
      console.log(`  ${deployment.name} already running, skipping`);
      return false;
    }
    if (status !== 'exited' && status !== 'created' && status !== 'stopped') {
      return false;
    }

    console.log(`  Starting ${deployment.name}...`);

    const runtime = resolveDeploymentRuntime(deployment);
    if (!runtime.ready) {
      console.log(`  ${deployment.name}: missing configuration (${runtime.missing.join(', ')})`);
      updateDeploymentStatus(deployment.name, CONFIGURATION_REQUIRED_STATUS);
      emit({
        type: 'deployment:status',
        deploymentName: deployment.name,
        data: { status: CONFIGURATION_REQUIRED_STATUS, missing: runtime.missing },
      });
      return false;
    }

    updateDeploymentStatus(deployment.name, 'starting');
    emit({
      type: 'deployment:status',
      deploymentName: deployment.name,
      data: { status: 'starting' },
    });

    // Check if this deployment has extra published ports.
    // Containers with extra ports must be recreated (not restarted) so Docker
    // gets random host ports and the TCP proxy can bind to the container ports.
    let extraPortsConfig: Array<{ container: number; protocol?: string }> | undefined =
      runtime.config.ports;
    if (runtime.format === 'legacy' && deployment.extraPorts) {
      try {
        const parsed = JSON.parse(deployment.extraPorts) as Array<{
          container: number;
          protocol: string;
        }>;
        extraPortsConfig = parsed.map((p) => ({
          container: p.container,
          protocol: p.protocol,
        }));
      } catch {
        // invalid JSON, fall through
      }
    }
    const configurationChanged =
      runtime.format === 'deploy.yaml' &&
      runtime.configurationDigest !== deployment.configurationDigest;
    if ((extraPortsConfig || configurationChanged) && deployment.port) {
      console.log(
        `  Recreating ${deployment.name} (${configurationChanged ? 'configuration changed' : 'has extra ports'})...`,
      );
      const volumeDir = getVolumeDir(deployment.name);
      const memLimit = deployment.memoryLimit || '4g';
      const { id, containerName, extraPorts } = await recreateContainer(
        deployment.name,
        deployment.port,
        volumeDir,
        deployment.directory,
        runtime.environment,
        memLimit,
        runtime.volumes,
        runtime.gpuEnabled,
        extraPortsConfig,
        runtime.privilegedDocker,
        deployment.cpuLimit || undefined,
        runtime.config,
      );
      const extraPortsJson = extraPorts.length > 0 ? JSON.stringify(extraPorts) : null;
      saveDeployment({
        name: deployment.name,
        username: deployment.username,
        port: deployment.port,
        containerId: id,
        containerName,
        directory: deployment.directory || undefined,
        extraPorts: extraPortsJson,
      });
      recordContainerStart(deployment.name);
      if (runtime.format === 'deploy.yaml' && runtime.configurationDigest) {
        updateDeploymentConfigurationDigest(deployment.name, runtime.configurationDigest);
      }
      // TCP proxies for extraPorts: saveDeployment() above emitted
      // route:changed; the edge reconciler starts them with the new mappings.
    } else {
      try {
        await restartContainer(deployment.name);
        recordContainerStart(deployment.name);
      } catch (restartErr: unknown) {
        console.log(`  Restart failed for ${deployment.name}, recreating container...`, restartErr);
        if (!deployment.port) {
          throw new Error(`Cannot recreate ${deployment.name}: no port assigned`, {
            cause: restartErr,
          });
        }
        const volumeDir = getVolumeDir(deployment.name);
        const memLimit = deployment.memoryLimit || '4g';
        const { extraPorts } = await recreateContainer(
          deployment.name,
          deployment.port,
          volumeDir,
          deployment.directory,
          runtime.environment,
          memLimit,
          runtime.volumes,
          runtime.gpuEnabled,
          undefined,
          runtime.privilegedDocker,
          deployment.cpuLimit || undefined,
          runtime.config,
        );
        recordContainerStart(deployment.name);
        if (runtime.format === 'deploy.yaml' && runtime.configurationDigest) {
          updateDeploymentConfigurationDigest(deployment.name, runtime.configurationDigest);
        }
        void extraPorts; // route:changed reconciler manages TCP proxies
      }
    }

    updateDeploymentStatus(deployment.name, 'running');
    emit({
      type: 'deployment:status',
      deploymentName: deployment.name,
      data: { status: 'running' },
    });
    return true;
  };

  let started = 0;
  const worker = async () => {
    while (cursor < deployments.length) {
      const idx = cursor++;
      const deployment = deployments[idx];
      try {
        const didStart = await startContainer(deployment);
        if (didStart) started++;
      } catch (err) {
        console.error(`  Error starting ${deployment.name}:`, err);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, deployments.length) }, () => worker()),
  );

  if (started > 0) {
    console.log(`All containers started (${started} total)`);
  } else {
    console.log('No containers needed to be started');
  }
}

/**
 * Stop all running containers
 * Called when deploy.local shuts down
 */
export async function stopAllContainers() {
  console.log('Stopping all containers...');
  stopAllProxies();
  const deployments = getAllDeployments();
  let stopped = 0;

  // Resolve all statuses with a single docker ps, then stop sequentially —
  // shutdown is one-shot and ordering doesn't matter.
  const statusMap = await getAllContainerStatuses();

  for (const deployment of deployments) {
    try {
      if (deployment.activeNodeId && deployment.activeNodeId !== 'coordinator') continue;
      if (isGraphDeployment(deployment)) {
        await new ApplicationGraphExecutor().stop({
          applicationId: deployment.appId || deployment.name,
          siteId: deployment.activeNodeId || deployment.desiredNodeId || 'coordinator',
        });
        updateDeploymentStatus(deployment.name, 'stopped');
        stopped++;
        continue;
      }
      const status = statusMap.get(deployment.name.toLowerCase()) || 'stopped';
      if (status === 'running') {
        console.log(`  Stopping ${deployment.name}...`);
        await stopContainer(deployment.name);
        updateDeploymentStatus(deployment.name, 'stopped');
        stopped++;
      }
    } catch (err) {
      console.error(`  Error stopping ${deployment.name}:`, err);
    }
  }

  console.log(`All containers stopped (${stopped} total)`);
}

function isGraphDeployment(deployment: {
  name: string;
  activeSpecDigest?: string | null;
}): boolean {
  if (!deployment.activeSpecDigest) return false;
  return (
    getApplicationSpecRevision(deployment.name, deployment.activeSpecDigest)?.manifestFormat ===
    'deploy.yaml'
  );
}
