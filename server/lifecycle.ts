import {
  getAllDeployments,
  updateDeploymentStatus,
  getDeploymentVolumes,
  saveDeployment,
} from './store.ts';
import {
  getContainerStatus,
  stopContainer,
  restartContainer,
  recreateContainer,
} from './docker.ts';
import { getVolumeDir } from './volumes.ts';
import { emit } from './events.ts';
import { startAllProxies, startProxies, stopAllProxies } from './tcp-proxy.ts';
import { readDeployConfig } from './deploy-config.ts';

/**
 * Sync deployment status from Docker on server startup
 * This ensures the database matches the actual Docker container state
 */
export function syncContainerStates() {
  console.log('Syncing container states...');
  const deployments = getAllDeployments();
  let synced = 0;

  for (const deployment of deployments) {
    try {
      const dockerStatus = getContainerStatus(deployment.name);
      const dbStatus = deployment.status || 'stopped';

      // Update database if status diverged
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
  let started = 0;

  if (deployments.length === 0) {
    console.log('  No deployments found');
    return;
  }

  for (const deployment of deployments) {
    try {
      const status = getContainerStatus(deployment.name);
      console.log(`  ${deployment.name}: status=${status}`);

      if (status === 'exited' || status === 'created' || status === 'stopped') {
        console.log(`  Starting ${deployment.name}...`);

        // Emit "starting" status immediately
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
          // Save updated port mappings to DB
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
          if (extraPorts.length > 0) {
            startProxies(deployment.name, extraPorts);
          }
        } else {
          try {
            // Try a simple restart first
            restartContainer(deployment.name);
          } catch (restartErr: unknown) {
            // Restart failed (e.g. volume mounts invalid after Docker daemon restart)
            // Fall back to recreating the container from the existing image
            console.log(
              `  Restart failed for ${deployment.name}, recreating container...`,
              restartErr,
            );
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
            if (extraPorts.length > 0) {
              startProxies(deployment.name, extraPorts);
            }
          }
        }

        // Update to running after container starts
        updateDeploymentStatus(deployment.name, 'running');
        emit({
          type: 'deployment:status',
          deploymentName: deployment.name,
          data: { status: 'running' },
        });
        started++;
      } else if (status === 'running') {
        console.log(`  ${deployment.name} already running, skipping`);
      }
    } catch (err) {
      console.error(`  Error starting ${deployment.name}:`, err);
    }
  }

  if (started > 0) {
    console.log(`All containers started (${started} total)`);
  } else {
    console.log('No containers needed to be started');
  }

  // Start TCP proxies for all deployments with extra ports
  startAllProxies();
}

/**
 * Stop all running containers
 * Called when deploy.local shuts down
 */
export function stopAllContainers() {
  console.log('Stopping all containers...');
  stopAllProxies();
  const deployments = getAllDeployments();
  let stopped = 0;

  for (const deployment of deployments) {
    try {
      const status = getContainerStatus(deployment.name);

      if (status === 'running') {
        console.log(`  Stopping ${deployment.name}...`);
        stopContainer(deployment.name);
        updateDeploymentStatus(deployment.name, 'stopped');
        stopped++;
      }
    } catch (err) {
      console.error(`  Error stopping ${deployment.name}:`, err);
    }
  }

  console.log(`All containers stopped (${stopped} total)`);
}
