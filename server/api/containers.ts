import { assertReleaseAdmission } from './release-admission.ts';
import { dispatch, routes } from '../kernel/routes.ts';
import {
  requireAuth,
  error,
  json,
  localGraphSiteFor,
  dispatchAgentCommand,
  PRE_CONTAINER_STATES,
  MIGRATION_STATES,
  CONFIGURATION_REQUIRED_STATUS,
  waitForRemotePort,
} from './shared.ts';
import {
  getDeployment,
  getApplicationSpecRevision,
  getDeploymentVolumes,
  saveDeployment,
  recordContainerStart,
  addDeployEvent,
  updateDeploymentStatus,
  updateDeploymentConfigurationDigest,
  getNode,
  getDeployHistory,
} from '../store.ts';
import {
  getContainerInspectAsync,
  getContainerStats,
  restartContainer,
  recreateContainer,
} from '../docker.ts';
import {
  resolveApplicationGraphRuntime,
  resolveDeploymentRuntime,
} from '../application-runtime.ts';
import { ApplicationGraphExecutor } from '../application-graph-executor.ts';
import { applicationWriterSiteId } from '../application-authority.ts';
import { emit } from '../events.ts';
import { acquireDeploySlot } from '../deploy-admission.ts';
import { getVolumeDir } from '../volumes.ts';
import { RequestBodyTooLargeError } from '../kernel/http.ts';
import { type ApiRouteContext } from './context.ts';

const route = routes<ApiRouteContext>();
const table = [
  route({
    method: 'GET',
    path: '/api/deployments/:part1/inspect',
    handler: async ({ context: ctx, params }) => {
      const { req, res } = ctx;
      try {
        const auth = requireAuth(req, res);
        if (!auth) return;
        assertReleaseAdmission(req);
        const name = params.part1;
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        const info = await getContainerInspectAsync(name);
        if (!info) return error(res, 'Container not found', 404);
        info.started = d.containerStartedAt ?? null;
        return json(res, info);
      } catch (err: unknown) {
        console.error(err);
        error(
          res,
          (err as Error).message || 'Internal server error',
          err instanceof RequestBodyTooLargeError
            ? 413
            : (err as Error & { status?: number }).status || 500,
        );
      }
    },
  }),
  route({
    method: 'GET',
    path: '/api/deployments/:part1/stats',
    handler: async ({ context: ctx, params }) => {
      const { req, res } = ctx;
      try {
        const auth = requireAuth(req, res);
        if (!auth) return;
        assertReleaseAdmission(req);
        const name = params.part1;
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        const stats = await getContainerStats(name);
        if (!stats) return error(res, 'Container not running', 404);
        return json(res, stats);
      } catch (err: unknown) {
        console.error(err);
        error(
          res,
          (err as Error).message || 'Internal server error',
          err instanceof RequestBodyTooLargeError
            ? 413
            : (err as Error & { status?: number }).status || 500,
        );
      }
    },
  }),
  route({
    method: 'POST',
    path: '/api/deployments/:part1/restart',
    handler: async ({ context: ctx, params }) => {
      const { req, res } = ctx;
      try {
        const auth = requireAuth(req, res);
        if (!auth) return;
        assertReleaseAdmission(req);
        const name = params.part1;
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        const activeRevision = d.activeSpecDigest
          ? getApplicationSpecRevision(name, d.activeSpecDigest)
          : null;
        if (activeRevision?.manifestFormat === 'deploy.yaml') {
          const siteId = localGraphSiteFor(d);
          if (!siteId)
            return error(res, 'Graph restart requires the target-local site control surface', 409);
          if (!d.directory) return error(res, 'Application graph source directory is missing', 409);
          const runtime = resolveApplicationGraphRuntime(d);
          if (!runtime.ready) {
            return error(
              res,
              `Required application configuration is missing: ${runtime.missing.join(', ')}`,
              428,
            );
          }
          const executor = new ApplicationGraphExecutor();
          await executor.stop({ applicationId: d.appId || name, siteId });
          const result = await executor.converge({
            deploymentName: name,
            applicationId: d.appId || name,
            siteId,
            nodeId: siteId,
            projectDirectory: d.directory,
            runtime,
            writerSiteId: applicationWriterSiteId(d.appId || name, siteId),
            memoryLimit: d.memoryLimit || '4g',
            cpuLimit: d.cpuLimit || undefined,
            runtimeVolumes: getDeploymentVolumes(name),
          });
          saveDeployment({
            name,
            type: d.type || undefined,
            username: d.username,
            port: result.primaryPort ?? undefined,
            containerId: result.primaryContainerId ?? undefined,
            containerName: result.primaryContainerName ?? undefined,
            directory: d.directory,
            desiredNodeId: d.desiredNodeId,
            activeNodeId: d.activeNodeId,
            createdAt: d.createdAt || undefined,
          });
        } else if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
          await dispatchAgentCommand(d.activeNodeId, 'restart', name);
        } else {
          await restartContainer(name);
        }
        recordContainerStart(name);
        addDeployEvent(name, { action: 'restart', username: auth.username, source: 'ui' });
        updateDeploymentStatus(name, 'running');
        emit({
          type: 'deployment:status',
          deploymentName: name,
          data: { status: 'running', username: auth.username, source: 'restart' },
        });
        return json(res, { message: `Restarted ${name}` });
      } catch (err: unknown) {
        console.error(err);
        error(
          res,
          (err as Error).message || 'Internal server error',
          err instanceof RequestBodyTooLargeError
            ? 413
            : (err as Error & { status?: number }).status || 500,
        );
      }
    },
  }),
  route({
    method: 'POST',
    path: '/api/deployments/:part1/recreate',
    handler: async ({ context: ctx, params }) => {
      const { req, res } = ctx;
      try {
        const auth = requireAuth(req, res);
        if (!auth) return;
        assertReleaseAdmission(req);
        const name = params.part1.toLowerCase();
        const initialDeployment = getDeployment(name);
        if (!initialDeployment || initialDeployment.username !== auth.username) {
          return error(res, 'Not found', 404);
        }

        const lease = await acquireDeploySlot(name, auth.username);
        try {
          // Resolve every mutable pointer only after admission. A deploy that
          // was ahead of this request may have activated a different release.
          const d = getDeployment(name);
          if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
          if (d.status && (PRE_CONTAINER_STATES.has(d.status) || MIGRATION_STATES.has(d.status))) {
            return error(res, 'Application runtime is already changing', 409);
          }

          const activeRevision = d.activeSpecDigest
            ? getApplicationSpecRevision(name, d.activeSpecDigest)
            : null;
          if (activeRevision?.manifestFormat === 'deploy.yaml') {
            const siteId = localGraphSiteFor(d);
            if (!siteId)
              return error(
                res,
                'Graph recreate requires the target-local site control surface',
                409,
              );
            if (!d.directory) {
              return error(res, 'Application graph source directory is missing', 409);
            }
            const runtime = resolveApplicationGraphRuntime(d);
            if (!runtime.ready) {
              updateDeploymentStatus(name, CONFIGURATION_REQUIRED_STATUS);
              return error(
                res,
                `Required application configuration is missing: ${runtime.missing.join(', ')}`,
                428,
              );
            }
            const previousStatus = d.status || 'unknown';
            updateDeploymentStatus(name, 'recreating');
            try {
              const result = await new ApplicationGraphExecutor().converge({
                deploymentName: name,
                applicationId: d.appId || name,
                siteId,
                nodeId: siteId,
                projectDirectory: d.directory,
                runtime,
                writerSiteId: applicationWriterSiteId(d.appId || name, siteId),
                memoryLimit: d.memoryLimit || '4g',
                cpuLimit: d.cpuLimit || undefined,
                runtimeVolumes: getDeploymentVolumes(name),
                forceReplace: true,
              });
              saveDeployment({
                name,
                type: d.type || undefined,
                username: d.username,
                port: result.primaryPort ?? undefined,
                containerId: result.primaryContainerId ?? undefined,
                containerName: result.primaryContainerName ?? undefined,
                directory: d.directory,
                desiredNodeId: d.desiredNodeId,
                activeNodeId: d.activeNodeId,
                createdAt: d.createdAt || undefined,
              });
              updateDeploymentConfigurationDigest(name, runtime.configurationDigest);
              addDeployEvent(name, {
                action: 'recreate',
                username: auth.username,
                source: 'ui',
              });
              updateDeploymentStatus(name, 'running');
              emit({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'running', username: auth.username, source: 'recreate' },
              });
              return json(res, { message: `Recreated ${name}` });
            } catch (graphRecreateError) {
              updateDeploymentStatus(name, previousStatus);
              throw graphRecreateError;
            }
          }

          if (!d.port) return error(res, 'Deployment has no port assigned', 400);

          const previousStatus = d.status || 'unknown';
          updateDeploymentStatus(name, 'recreating');
          const runtime = resolveDeploymentRuntime(d);
          if (!runtime.ready) {
            updateDeploymentStatus(name, CONFIGURATION_REQUIRED_STATUS);
            return error(
              res,
              `Required application configuration is missing: ${runtime.missing.join(', ')}`,
              428,
            );
          }

          try {
            let extraPortsConfig = runtime.config.ports;
            if (runtime.format === 'legacy' && d.extraPorts) {
              extraPortsConfig = JSON.parse(d.extraPorts);
            }
            let recreated: {
              id: string;
              containerName: string;
              extraPorts: unknown[];
              port: number;
            };
            if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
              const result = await dispatchAgentCommand(
                d.activeNodeId,
                'recreate',
                name,
                {
                  envVars: runtime.environment,
                  memoryLimit: d.memoryLimit || undefined,
                  volumes: runtime.volumes,
                  gpuEnabled: runtime.gpuEnabled,
                  privilegedDocker: runtime.privilegedDocker,
                  cpuLimit: d.cpuLimit || undefined,
                  relayPort: d.port,
                  ports: extraPortsConfig,
                  deployConfig: { ...runtime.config, ports: extraPortsConfig },
                },
                120_000,
                undefined,
                true,
              );
              const port = Number(result.port);
              const containerId = String(result.containerId || '');
              const containerName = String(result.containerName || '');
              if (
                !Number.isInteger(port) ||
                port < 1 ||
                port > 65535 ||
                !containerId ||
                !containerName
              ) {
                throw new Error('Remote recreate returned invalid container metadata');
              }
              const node = getNode(d.activeNodeId);
              if (!node?.address || !(await waitForRemotePort(node.address, port))) {
                throw new Error(
                  `Recreated application is not reachable through ${node?.name || d.activeNodeId}`,
                );
              }
              recreated = {
                id: containerId,
                containerName,
                extraPorts: Array.isArray(result.extraPorts) ? result.extraPorts : [],
                port,
              };
            } else {
              const volumeDir = getVolumeDir(name);
              const { id, containerName, extraPorts } = await recreateContainer(
                name,
                d.port,
                volumeDir,
                d.directory || null,
                runtime.environment,
                d.memoryLimit || undefined,
                runtime.volumes,
                runtime.gpuEnabled,
                extraPortsConfig,
                runtime.privilegedDocker,
                d.cpuLimit || undefined,
                runtime.config,
              );
              recreated = { id, containerName, extraPorts, port: d.port };
            }
            saveDeployment({
              name,
              username: auth.username,
              port: recreated.port,
              containerId: recreated.id,
              containerName: recreated.containerName,
              directory: d.directory || undefined,
              extraPorts:
                recreated.extraPorts.length > 0 ? JSON.stringify(recreated.extraPorts) : null,
              desiredNodeId: d.desiredNodeId,
              activeNodeId: d.activeNodeId,
            });
            if (runtime.format === 'deploy.yaml' && runtime.configurationDigest) {
              updateDeploymentConfigurationDigest(name, runtime.configurationDigest);
            }
            addDeployEvent(name, {
              action: 'recreate',
              username: auth.username,
              source: 'ui',
            });
            updateDeploymentStatus(name, 'running');
            emit({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: 'running', username: auth.username, source: 'recreate' },
            });
            return json(res, { message: `Recreated ${name}` });
          } catch (recreateError) {
            updateDeploymentStatus(name, previousStatus);
            throw recreateError;
          }
        } finally {
          lease.release();
        }
      } catch (err: unknown) {
        console.error(err);
        error(
          res,
          (err as Error).message || 'Internal server error',
          err instanceof RequestBodyTooLargeError
            ? 413
            : (err as Error & { status?: number }).status || 500,
        );
      }
    },
  }),
  route({
    method: 'GET',
    path: '/api/deployments/:part1/history',
    handler: async ({ context: ctx, params }) => {
      const { req, res } = ctx;
      try {
        const auth = requireAuth(req, res);
        if (!auth) return;
        assertReleaseAdmission(req);
        const name = params.part1;
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        return json(res, getDeployHistory(name));
      } catch (err: unknown) {
        console.error(err);
        error(
          res,
          (err as Error).message || 'Internal server error',
          err instanceof RequestBodyTooLargeError
            ? 413
            : (err as Error & { status?: number }).status || 500,
        );
      }
    },
  }),
];

export async function containersRoutes(ctx: ApiRouteContext): Promise<boolean> {
  return dispatch(table, { path: () => ctx.path, method: () => ctx.method })(ctx.req, ctx.res, ctx);
}
