import {
  getAllDeployments,
  updateDeploymentStatus,
  getDeploymentVolumes,
  saveDeployment,
  recordContainerStart,
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
import { readDeployConfig } from './deploy-config.ts';

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
      const dockerStatus = statusMap.get(deployment.name.toLowerCase()) || 'stopped';
      const dbStatus = deployment.status || 'stopped';

      if (dockerStatus !== dbStatus) {
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

    updateDeploymentStatus(deployment.name, 'starting');
    emit({
      type: 'deployment:status',
      deploymentName: deployment.name,
      data: { status: 'starting' },
    });

    // Check if this deployment has extra ports (from DB or deploy.json).
    // Containers with extra ports must be recreated (not restarted) so Docker
    // gets random host ports and the TCP proxy can bind to the container ports.
    let extraPortsConfig: Array<{ container: number; protocol?: string }> | undefined;
    if (deployment.extraPorts) {
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
    if (!extraPortsConfig && deployment.directory) {
      try {
        const config = readDeployConfig(deployment.directory);
        if (config.ports && config.ports.length > 0) {
          extraPortsConfig = config.ports;
        }
      } catch {
        // deploy.json not available (gitignored, temp dir cleaned up, etc.)
      }
    }

    if (extraPortsConfig && deployment.port) {
      console.log(`  Recreating ${deployment.name} (has extra ports)...`);
      const volumeDir = getVolumeDir(deployment.name);
      const envVars = deployment.envVars ? JSON.parse(deployment.envVars) : {};
      const memLimit = deployment.memoryLimit || '4g';
      const customVolumes = getDeploymentVolumes(deployment.name);
      const gpuFlag = deployment.gpuEnabled ?? false;
      const privilegedDockerFlag = deployment.privilegedDocker ?? false;
      const { id, containerName, extraPorts } = await recreateContainer(
        deployment.name,
        deployment.port,
        volumeDir,
        deployment.directory,
        envVars,
        memLimit,
        customVolumes,
        gpuFlag,
        extraPortsConfig,
        privilegedDockerFlag,
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
        const envVars = deployment.envVars ? JSON.parse(deployment.envVars) : {};
        const memLimit = deployment.memoryLimit || '4g';
        const customVolumes = getDeploymentVolumes(deployment.name);
        const privilegedDockerFlag = deployment.privilegedDocker ?? false;
        const { extraPorts } = await recreateContainer(
          deployment.name,
          deployment.port,
          volumeDir,
          deployment.directory,
          envVars,
          memLimit,
          customVolumes,
          false,
          undefined,
          privilegedDockerFlag,
        );
        recordContainerStart(deployment.name);
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
