import { randomUUID } from 'node:crypto';
import { stopApp } from '../v2/project-removal.ts';
import {
  requireAuth,
  json,
  error,
  MIGRATION_STATES,
  PRE_CONTAINER_STATES,
  fleetMutationBlocked,
  localGraphSiteFor,
  requireAdmin,
  CONFIGURATION_REQUIRED_STATUS,
  migrationProgressByDeployment,
  dispatchAgentCommand,
} from './shared.ts';
import {
  getDeployments,
  getDeployment,
  getFleetPlacementState,
  deployRoleEnabled,
  getApplicationSpecRevision,
  saveDesiredApplicationSpec,
  getApplicationGraphState,
  getApplicationSpecRevisions,
  getApplicationSpecTransitions,
  listComponentSiteOverrides,
  isAdmin,
  getComponentSiteOverrides,
  assertDeployRole,
  getNode,
  updateDeploymentStatus,
  createBuildLog,
  updateCurrentBuildLogId,
  enqueueAgentJob,
  getDeploymentVolumes,
  getAgentJob,
  completeBuildLog,
  activateDesiredApplicationSpec,
  saveDeployment,
  updateDeploymentConfigurationDigest,
  addDeployEvent,
  getApplicationConfigurationValues,
  setDeploymentDesiredNode,
  setComponentSiteOverride,
  transitionProfileApplicationSpec,
  deleteDeployment,
  updateDeploymentSettings,
  getUploadsDir,
} from '../store.ts';
import {
  getAllContainerStatuses,
  removeContainer,
  parseMemoryLimit,
  validateVolumeMounts,
  recreateContainer,
  streamContainerLogs,
  getContainerStatusAsync,
} from '../docker.ts';
import { readBody, RequestBodyTooLargeError } from '../http.ts';
import {
  acquireDeploySlot,
  getDeployAdmissionState,
  cancelQueuedDeploy,
} from '../deploy-admission.ts';
import {
  compileDeployYaml,
  parseStoredApplicationSpec,
  renderDeployYaml,
  renderRepositoryDeployYaml,
} from '../application-spec.ts';
import { planApplicationChange } from '../application-plan.ts';
import {
  requiresFleetAcknowledgement,
  assertFleetMutationReady,
  destructiveGraphMutationFingerprint,
  FleetMutationBlockedError,
  applicationDeleteMutationFingerprint,
} from '../fleet-mutation-guard.ts';
import { registerApplicationIdentity } from '../multisite.ts';
import {
  carryForwardCompatibleConfiguration,
  resolveApplicationConfiguration,
  setDeclaredConfigurationValue,
} from '../application-configuration.ts';
import { inspectContainer as inspectDockerContainer } from '../docker-api.ts';
import { rebaseApplicationRevision } from '../application-revision.ts';
import { resolvePlacementTarget } from '../application-placement-target.ts';
import { planApplicationExecution } from '../application-execution.ts';
import {
  buildApplicationGraphRuntime,
  resolveApplicationGraphRuntime,
} from '../application-runtime.ts';
import { getArtifact } from '../content-store.ts';
import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { emit } from '../events.ts';
import { createAgentGraphPayload } from '../agent-graph-payload.ts';
import { applicationWriterSiteId } from '../application-authority.ts';
import { recordAgentGraphMaterialization } from '../agent-graph-recording.ts';
import { type AgentGraphExecutionResult } from '../agent-graph-runtime.ts';
import { publishActivatedApplicationRevision } from '../distributed-application-events.ts';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
} from '../application-graph-executor.ts';
import { projectApplicationConfigurationToReplicas } from '../site-configuration-envelope.ts';
import { publishComponentSiteCount } from '../component-site-overrides.ts';
import { deleteVolumes, getVolumeDir } from '../volumes.ts';
import { forgetApp as forgetCrashTracker } from '../crash-tracker.ts';
import { totalmem, cpus } from 'node:os';
import { resolveApplicationInstanceTarget } from '../application-instance-target.ts';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { type ApiRouteContext } from './context.ts';

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Async resolve status — avoids blocking the event loop during HTTP request handling. */
async function resolveStatusAsync(d: {
  name: string;
  type?: string | null;
  status: string | null;
  updatedAt?: string | null;
  activeNodeId?: string | null;
}): Promise<string> {
  if (d.status === CONFIGURATION_REQUIRED_STATUS) return d.status;
  if (d.type === 'application-graph') return d.status || 'unknown';
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    const node = getNode(d.activeNodeId);
    return node?.online ? d.status || 'unknown' : 'node-offline';
  }
  if (d.status && PRE_CONTAINER_STATES.has(d.status)) {
    if (d.updatedAt) {
      const elapsed = Date.now() - new Date(d.updatedAt).getTime();
      if (elapsed > STALE_THRESHOLD_MS) {
        updateDeploymentStatus(d.name, 'unknown');
        return getContainerStatusAsync(d.name);
      }
    }
    return d.status;
  }
  return getContainerStatusAsync(d.name);
}

/** Batch-resolve status using a pre-fetched status map (avoids N docker inspect calls) */
function resolveStatusBatched(
  d: {
    name: string;
    type?: string | null;
    status: string | null;
    updatedAt?: string | null;
    activeNodeId?: string | null;
  },
  statusMap: Map<string, string>,
): string {
  if (d.status === CONFIGURATION_REQUIRED_STATUS) return d.status;
  // Graph deployments own several containers, so the legacy single-container
  // status map has no entry under the application alias. The graph reconciler
  // persists its aggregate lifecycle state on the deployment row.
  if (d.type === 'application-graph') return d.status || 'unknown';
  if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
    const node = getNode(d.activeNodeId);
    return node?.online ? d.status || 'unknown' : 'node-offline';
  }
  if (d.status && PRE_CONTAINER_STATES.has(d.status)) {
    if (d.updatedAt) {
      const elapsed = Date.now() - new Date(d.updatedAt).getTime();
      if (elapsed > STALE_THRESHOLD_MS) {
        updateDeploymentStatus(d.name, 'unknown');
        return statusMap.get(d.name.toLowerCase()) || 'stopped';
      }
    }
    return d.status;
  }
  return statusMap.get(d.name.toLowerCase()) || 'stopped';
}

function latestRetainedArtifact(deploymentName: string): string | null {
  const artifactDir = resolve(getUploadsDir(), '..', 'artifacts', deploymentName);
  if (!existsSync(artifactDir)) return null;
  const latest = readdirSync(artifactDir)
    .filter((filename) => filename.endsWith('.tar.gz'))
    .map((filename) => {
      const path = resolve(artifactDir, filename);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
  return latest?.path || null;
}

function submitRetainedArtifact(
  artifactPath: string,
  deploymentName: string,
  auth: { username: string; token: string },
): Promise<Record<string, unknown>> {
  const boundary = `----deploy-local-relocate-${Date.now().toString(36)}`;
  const prefix = Buffer.from(
    [
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${deploymentName}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="detached"\r\n\r\n1\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.tar.gz"\r\n`,
      'Content-Type: application/gzip\r\n\r\n',
    ].join(''),
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = prefix.length + statSync(artifactPath).size + suffix.length;

  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 80),
        path: '/api/upload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': contentLength,
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
          'user-agent': 'deploy.local-relocation',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // retain the HTTP error below
          }
          if ((response.statusCode || 500) >= 400) {
            rejectPromise(
              new Error(String(body.error || raw || `Relocation failed (${response.statusCode})`)),
            );
            return;
          }
          resolvePromise(body);
        });
      },
    );
    request.on('error', rejectPromise);
    request.write(prefix);
    const artifact = createReadStream(artifactPath);
    artifact.on('error', rejectPromise);
    artifact.on('end', () => request.end(suffix));
    artifact.pipe(request, { end: false });
  });
}

export async function deploymentsRoutes(ctx: ApiRouteContext): Promise<boolean> {
  const { req, res, path, method, url, makeLegacyUpdate, makeWanderAdoption, wanderPreflight } =
    ctx;
  // Keep the original return boundary: returned promises bypass the catch,
  // while thrown errors and rejected awaits use the existing API error response.
  const result = await (async () => {
    try {
      // ── Deployment management ───────────────────────────────────────────

      if (path === '/api/deployments' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const allDeps = getDeployments(auth.username);
        const statusMap = await getAllContainerStatuses();
        const deps = allDeps.map((d) => ({
          ...d,
          status: resolveStatusBatched(d, statusMap),
        }));
        return json(res, deps);
      }

      const adoptionMatch = path.match(
        /^\/api\/deployments\/wander\/managed-adoption(?:\/(preflight|recover|cancel))?$/,
      );

      if (adoptionMatch) {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const service = makeWanderAdoption(auth.username);
        if (method === 'GET' && !adoptionMatch[1]) return json(res, service.status());
        if (method === 'GET' && adoptionMatch[1] === 'preflight')
          return json(res, await wanderPreflight(auth.username));
        if (method === 'POST' && ['recover', 'cancel'].includes(adoptionMatch[1])) {
          const body = JSON.parse((await readBody(req)).toString());
          if (
            body.confirmDowntime !== true ||
            typeof body.operationId !== 'string' ||
            Object.keys(body).some((k) => !['confirmDowntime', 'operationId'].includes(k))
          )
            return error(res, 'Exact operation and downtime acknowledgement required', 400);
          return json(res, await service.recover(body.operationId, adoptionMatch[1] === 'cancel'));
        }
        return error(res, 'Adoption route not found', 404);
      }

      const legacyMatch = path.match(
        /^\/api\/deployments\/(groffee)\/legacy-update(?:\/(recover|rollback))?$/,
      );

      if (legacyMatch) {
        try {
          const auth = requireAuth(req, res);
          if (!auth) return;
          const service = makeLegacyUpdate(legacyMatch[1], auth.username);
          if (method === 'GET' && !legacyMatch[2]) {
            const deployment = getDeployment('groffee')!;
            if (!service.status().locked) await service.preflight();
            return json(res, {
              ...service.status(),
              containerId: deployment.containerId,
              desiredDigest: deployment.desiredSpecDigest || 'none',
            });
          }
          if (method !== 'POST' || !legacyMatch[2])
            return error(res, 'Legacy route not found', 404);
          const body = JSON.parse((await readBody(req)).toString());
          if (
            body.confirmDowntime !== true ||
            (legacyMatch[2] === 'rollback' && body.confirmDataLoss !== true)
          )
            return error(
              res,
              'Explicit downtime and rollback data-loss acknowledgement required',
              409,
            );
          const lease = await acquireDeploySlot('groffee', auth.username);
          try {
            return json(res, await service.recover(legacyMatch[2] === 'rollback'));
          } finally {
            lease.release();
          }
        } catch (legacyError) {
          const typed = legacyError as Error & { status?: number };
          return error(
            res,
            typed.message,
            legacyError instanceof RequestBodyTooLargeError
              ? 413
              : [403, 404, 409].includes(typed.status || 0)
                ? typed.status
                : legacyError instanceof SyntaxError
                  ? 400
                  : 500,
          );
        }
      }

      if (path === '/api/deploy-admission' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const placement = getFleetPlacementState();
        return json(res, {
          ...getDeployAdmissionState(auth.username),
          placementReady: placement.ready,
          defaultNode: placement.defaultNode,
          nodes: placement.nodes.filter((node) => deployRoleEnabled(node.id)),
          setupUrl: '/dashboard/nodes',
        });
      }

      const admissionCancelMatch = path.match(/^\/api\/deploy-admission\/([^/]+)$/);

      if (admissionCancelMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = admissionCancelMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (deployment && deployment.username !== auth.username) {
          return error(res, 'Not found', 404);
        }
        const migrationActive = Boolean(
          deployment?.status && MIGRATION_STATES.has(deployment.status),
        );
        return json(res, {
          name,
          status: deployment?.status || null,
          migrationActive,
          dashboardUrl: `/dashboard/${encodeURIComponent(name)}/build`,
        });
      }

      if (admissionCancelMatch && method === 'DELETE') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = admissionCancelMatch[1].toLowerCase();
        if (!cancelQueuedDeploy(name, auth.username)) {
          return error(res, 'Queued deploy not found', 404);
        }
        return json(res, { message: `Cancelled queued deploy for ${name}` });
      }

      const applicationSpecMatch = path.match(/^\/api\/deployments\/([^/]+)\/application-spec$/);

      if (applicationSpecMatch && (method === 'GET' || method === 'PUT')) {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = applicationSpecMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username) {
          return error(res, 'Not found', 404);
        }
        if (
          method === 'PUT' &&
          deployment.status &&
          (PRE_CONTAINER_STATES.has(deployment.status) || MIGRATION_STATES.has(deployment.status))
        ) {
          return error(
            res,
            'Application revisions cannot change while a deploy or migration is switching runtime state',
            409,
          );
        }
        const desiredRevision = deployment.desiredSpecDigest
          ? getApplicationSpecRevision(name, deployment.desiredSpecDigest)
          : null;
        const activeRevision = deployment.activeSpecDigest
          ? getApplicationSpecRevision(name, deployment.activeSpecDigest)
          : null;
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)).toString() || '{}');
          if (typeof body.manifest !== 'string' || !body.manifest.trim()) {
            return error(res, 'A deploy.yaml manifest is required', 400);
          }
          const currentDigest = desiredRevision?.digest || activeRevision?.digest || null;
          if (body.expectedParentDigest !== currentDigest) {
            return json(
              res,
              {
                error: 'Application revision changed; preview against the latest parent',
                expectedParentDigest: currentDigest,
              },
              409,
            );
          }
          try {
            const candidate = compileDeployYaml(body.manifest, 'UI deploy.yaml');
            if (candidate.spec.metadata.name && candidate.spec.metadata.name !== name) {
              return error(
                res,
                `deploy.yaml metadata.name is "${candidate.spec.metadata.name}", but this application is named "${name}"`,
                400,
              );
            }
            const currentSpec = desiredRevision
              ? parseStoredApplicationSpec(desiredRevision.normalizedSpec)
              : activeRevision
                ? parseStoredApplicationSpec(activeRevision.normalizedSpec)
                : null;
            const plan = currentSpec
              ? planApplicationChange(currentSpec, candidate.spec, { source: 'ui' })
              : null;
            if (plan?.blocked) {
              return json(res, { error: 'Application change plan is blocked', plan }, 409);
            }
            if (plan?.destructive && body.confirmDestructive !== true) {
              return json(
                res,
                { error: 'Destructive application changes require confirmation', plan },
                409,
              );
            }
            if (requiresFleetAcknowledgement(plan, candidate.spec)) {
              const applicationId = deployment.appId || registerApplicationIdentity(name);
              assertFleetMutationReady({
                appId: applicationId,
                applicationName: name,
                kind: 'destructive-graph-change',
                mutationFingerprint: destructiveGraphMutationFingerprint(
                  applicationId,
                  candidate.digest,
                ),
                consequence:
                  'This revision removes or incompatibly changes application graph state. Every selected suitcase must sync and acknowledge this exact revision before the desired graph changes.',
                actor: auth.username,
              });
            }

            saveDesiredApplicationSpec({
              digest: candidate.digest,
              deploymentName: name,
              parentDigest: currentDigest,
              apiVersion: candidate.spec.apiVersion,
              source: 'ui',
              manifestFormat: 'deploy.yaml',
              normalizedSpec: candidate.canonicalJson,
              originalSource: body.manifest,
              createdBy: auth.username,
              rejectDeploymentStatuses: [...PRE_CONTAINER_STATES, ...MIGRATION_STATES],
            });
            if (currentSpec && currentDigest) {
              carryForwardCompatibleConfiguration({
                deploymentName: name,
                fromSpec: currentSpec,
                fromDigest: currentDigest,
                toSpec: candidate.spec,
                toDigest: candidate.digest,
                updatedBy: auth.username,
              });
            }
            return json(
              res,
              {
                desiredDigest: candidate.digest,
                parentDigest: currentDigest,
                activeDigest: deployment.activeSpecDigest,
                plan,
                manifest: renderDeployYaml(candidate.spec),
                applied: false,
              },
              201,
            );
          } catch (err) {
            if (err instanceof FleetMutationBlockedError) {
              return fleetMutationBlocked(res, err);
            }
            const message = (err as Error).message;
            return error(
              res,
              message,
              message.includes('parent does not match') ||
                message.includes('while a deploy or migration')
                ? 409
                : 400,
            );
          }
        }
        const localSiteId = localGraphSiteFor(deployment);
        const runningInstances = localSiteId
          ? getApplicationGraphState(name, deployment.appId || name, localSiteId).instances.filter(
              (instance) => instance.status === 'ready',
            )
          : [];
        const runningImages = await Promise.all(
          runningInstances.map(async (instance) => {
            const container = await inspectDockerContainer(instance.containerName).catch(
              () => null,
            );
            return container?.State.Status === 'running'
              ? {
                  component: instance.componentKey,
                  image: instance.image,
                  imageId: container.Image,
                }
              : null;
          }),
        );
        return json(res, {
          applicationId: deployment.appId,
          desiredDigest: deployment.desiredSpecDigest,
          activeDigest: deployment.activeSpecDigest,
          sourceArtifactDigest: deployment.sourceArtifactDigest,
          imageArtifactDigest: deployment.imageArtifactDigest,
          runningImages: runningImages.filter((image) => image !== null),
          runningImagesAvailable: Boolean(localSiteId),
          source: deployment.specSource,
          sourceAligned:
            deployment.specSource === 'repository' || deployment.specSource === 'legacy',
          notYetInSource:
            deployment.specSource !== 'repository' && deployment.specSource !== 'legacy',
          desired: desiredRevision
            ? parseStoredApplicationSpec(desiredRevision.normalizedSpec)
            : null,
          active: activeRevision ? parseStoredApplicationSpec(activeRevision.normalizedSpec) : null,
          revisions: getApplicationSpecRevisions(name).map((revision) => ({
            digest: revision.digest,
            parentDigest: revision.parentDigest,
            apiVersion: revision.apiVersion,
            source: revision.source,
            manifestFormat: revision.manifestFormat,
            createdBy: revision.createdBy,
            createdAt: revision.createdAt,
            active: activeRevision?.digest === revision.digest,
          })),
          transitions: getApplicationSpecTransitions(name),
          siteOverrides: deployment.appId
            ? listComponentSiteOverrides(deployment.appId).map((override) => ({
                siteId: override.siteId,
                componentKey: override.componentKey,
                instances: override.instances,
                updatedBy: override.updatedBy,
                updatedAt: override.updatedAt,
              }))
            : [],
        });
      }

      const applicationRebaseMatch = path.match(
        /^\/api\/deployments\/([^/]+)\/application-rebase$/,
      );

      if (applicationRebaseMatch && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = applicationRebaseMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username) {
          return error(res, 'Not found', 404);
        }
        const body = JSON.parse((await readBody(req)).toString() || '{}') as {
          manifest?: unknown;
          baseDigest?: unknown;
        };
        if (typeof body.manifest !== 'string' || !body.manifest.trim()) {
          return error(res, 'A repository deploy.yaml manifest is required', 400);
        }
        if (typeof body.baseDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.baseDigest)) {
          return error(res, 'A canonical repository base digest is required', 400);
        }
        const currentDigest = deployment.desiredSpecDigest || deployment.activeSpecDigest;
        const baseRevision = getApplicationSpecRevision(name, body.baseDigest);
        const currentRevision = currentDigest
          ? getApplicationSpecRevision(name, currentDigest)
          : null;
        if (!baseRevision) return error(res, 'Repository base revision is not retained', 409);
        if (!currentRevision || !currentDigest) {
          return error(res, 'Current desired application revision is unavailable', 409);
        }
        try {
          const repository = compileDeployYaml(body.manifest, 'repository deploy.yaml');
          if (repository.spec.metadata.name && repository.spec.metadata.name !== name) {
            return error(
              res,
              `deploy.yaml metadata.name is "${repository.spec.metadata.name}", but this application is named "${name}"`,
              400,
            );
          }
          const result = rebaseApplicationRevision({
            base: parseStoredApplicationSpec(baseRevision.normalizedSpec),
            current: parseStoredApplicationSpec(currentRevision.normalizedSpec),
            repository: repository.spec,
            currentDigest,
          });
          if (result.conflicts.length > 0) {
            return json(res, {
              ready: false,
              baseDigest: body.baseDigest,
              currentDigest,
              repositoryDigest: repository.digest,
              conflicts: result.conflicts,
              choices: ['replace', 'cancel'],
            });
          }
          return json(res, {
            ready: true,
            baseDigest: body.baseDigest,
            currentDigest,
            repositoryDigest: repository.digest,
            rebasedDigest: result.digest,
            manifest: result.manifest,
            plan: planApplicationChange(
              parseStoredApplicationSpec(currentRevision.normalizedSpec),
              result.spec!,
              { source: 'repository' },
            ),
          });
        } catch (rebaseError) {
          return error(res, (rebaseError as Error).message, 400);
        }
      }

      const applicationPlanMatch = path.match(/^\/api\/deployments\/([^/]+)\/application-plan$/);

      const applicationRuntimeMatch = path.match(
        /^\/api\/deployments\/([^/]+)\/application-runtime$/,
      );

      if (applicationRuntimeMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = applicationRuntimeMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username) {
          return error(res, 'Not found', 404);
        }
        if (!isAdmin(auth.username)) {
          return error(res, 'Application runtime plans require an administrator', 403);
        }
        const revisionTarget = url.searchParams.get('revision') || 'active';
        if (revisionTarget !== 'active' && revisionTarget !== 'desired') {
          return error(res, 'Runtime revision must be "active" or "desired"', 400);
        }
        const selectedDigest =
          revisionTarget === 'active'
            ? deployment.activeSpecDigest
            : deployment.desiredSpecDigest || deployment.activeSpecDigest;
        const revision = selectedDigest ? getApplicationSpecRevision(name, selectedDigest) : null;
        if (!revision) return error(res, 'Application manifest not found', 404);
        const spec = parseStoredApplicationSpec(revision.normalizedSpec);
        const siteId =
          url.searchParams.get('siteId') ||
          (revisionTarget === 'active'
            ? deployment.activeNodeId
            : deployment.desiredNodeId || deployment.activeNodeId) ||
          'coordinator';
        const placementTarget = resolvePlacementTarget(siteId);
        if (!placementTarget) return error(res, 'Site not found', 404);
        const configuration = resolveApplicationConfiguration({
          deploymentName: name,
          specDigest: revision.digest,
          declarations: spec.configuration,
          siteId,
        });
        const execution = planApplicationExecution(deployment.appId || name, spec, {
          specDigest: revision.digest,
          unresolvedConfiguration: new Set(configuration.missing),
          targetSiteId: siteId,
          siteInstanceOverrides: getComponentSiteOverrides(deployment.appId || name, siteId),
          placementTarget,
        });
        return json(res, {
          applicationId: deployment.appId || name,
          alias: name,
          siteId,
          revision: revisionTarget,
          specDigest: revision.digest,
          activeSpecDigest: deployment.activeSpecDigest,
          desiredSpecDigest: deployment.desiredSpecDigest,
          configuration: {
            digest: configuration.digest,
            missing: configuration.missing,
            valuesRedacted: true,
          },
          ready: !execution.blocked,
          execution,
          actual:
            revisionTarget === 'active'
              ? getApplicationGraphState(name, deployment.appId || name, siteId)
              : null,
        });
      }

      if (applicationPlanMatch && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = applicationPlanMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username) {
          return error(res, 'Not found', 404);
        }
        const currentDigest = deployment.desiredSpecDigest || deployment.activeSpecDigest;
        const currentRevision = currentDigest
          ? getApplicationSpecRevision(name, currentDigest)
          : null;
        if (!currentRevision) return error(res, 'Application manifest not found', 404);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (typeof body.manifest !== 'string' || !body.manifest.trim()) {
          return error(res, 'A deploy.yaml manifest is required', 400);
        }
        try {
          const candidate = compileDeployYaml(body.manifest, 'proposed deploy.yaml');
          if (candidate.spec.metadata.name && candidate.spec.metadata.name !== name) {
            return error(
              res,
              `deploy.yaml metadata.name is "${candidate.spec.metadata.name}", but this application is named "${name}"`,
              400,
            );
          }
          const current = parseStoredApplicationSpec(currentRevision.normalizedSpec);
          return json(res, {
            parentDigest: currentDigest,
            candidateDigest: candidate.digest,
            plan: planApplicationChange(current, candidate.spec, { source: 'ui' }),
            normalized: candidate.spec,
            manifest: renderDeployYaml(candidate.spec),
          });
        } catch (err) {
          return error(res, (err as Error).message, 400);
        }
      }

      const applicationApplyMatch = path.match(/^\/api\/deployments\/([^/]+)\/application-apply$/);

      if (applicationApplyMatch && method === 'POST') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const name = applicationApplyMatch[1].toLowerCase();
        const initial = getDeployment(name);
        if (!initial) return error(res, 'Not found', 404);
        const lease = await acquireDeploySlot(name, auth.username);
        try {
          const deployment = getDeployment(name);
          if (!deployment) return error(res, 'Not found', 404);
          const body = JSON.parse((await readBody(req)).toString() || '{}') as {
            expectedDesiredDigest?: unknown;
            confirmDestructive?: unknown;
          };
          const desiredDigest = deployment.desiredSpecDigest || deployment.activeSpecDigest;
          if (
            typeof body.expectedDesiredDigest !== 'string' ||
            body.expectedDesiredDigest !== desiredDigest
          ) {
            return json(
              res,
              {
                error: 'Desired application revision changed',
                expectedDesiredDigest: desiredDigest,
              },
              409,
            );
          }
          if (!desiredDigest) return error(res, 'Desired application graph is missing', 409);
          if (desiredDigest === deployment.activeSpecDigest) {
            return json(res, {
              applied: true,
              unchanged: true,
              activeDigest: desiredDigest,
            });
          }
          const desiredRevision = getApplicationSpecRevision(name, desiredDigest);
          if (!desiredRevision) return error(res, 'Desired application graph is missing', 409);
          const desired = parseStoredApplicationSpec(desiredRevision.normalizedSpec);
          const activeRevision = deployment.activeSpecDigest
            ? getApplicationSpecRevision(name, deployment.activeSpecDigest)
            : null;
          const plan = activeRevision
            ? planApplicationChange(
                parseStoredApplicationSpec(activeRevision.normalizedSpec),
                desired,
                { source: 'ui' },
              )
            : null;
          if (plan?.blocked)
            return json(res, { error: 'Application change plan is blocked', plan }, 409);
          if (plan?.destructive && body.confirmDestructive !== true) {
            return json(
              res,
              { error: 'Destructive application changes require confirmation', plan },
              409,
            );
          }
          if (requiresFleetAcknowledgement(plan, desired)) {
            const applicationId = deployment.appId || registerApplicationIdentity(name);
            assertFleetMutationReady({
              appId: applicationId,
              applicationName: name,
              kind: 'destructive-graph-change',
              mutationFingerprint: destructiveGraphMutationFingerprint(
                applicationId,
                desiredDigest,
              ),
              consequence:
                'Applying this revision removes or incompatibly changes application graph state. Every selected suitcase must sync and acknowledge this exact revision first.',
              actor: auth.username,
            });
          }
          const siteId =
            deployment.desiredNodeId || deployment.activeNodeId || localGraphSiteFor(deployment);
          if (!siteId) return error(res, 'Application placement is unavailable', 409);
          if (!deployment.directory) {
            return error(res, 'Application graph source directory is missing', 409);
          }
          const configuration = resolveApplicationConfiguration({
            deploymentName: name,
            specDigest: desiredDigest,
            declarations: desired.configuration,
            siteId,
          });
          const runtime = buildApplicationGraphRuntime({
            applicationId: deployment.appId || name,
            specDigest: desiredDigest,
            spec: desired,
            configuration,
            siteId,
          });
          assertDeployRole(siteId);
          const targetNode = getNode(siteId);
          if (targetNode?.kind === 'agent') {
            if (!targetNode.online)
              return error(res, `Deployment node "${targetNode.name}" is offline`, 503);
            if (!configuration.ready) {
              updateDeploymentStatus(name, CONFIGURATION_REQUIRED_STATUS);
              return json(
                res,
                {
                  error: `Required application configuration is missing: ${configuration.missing.join(', ')}`,
                  activationGated: true,
                  missingConfiguration: configuration.missing,
                },
                428,
              );
            }
            if (!runtime.ready) {
              return json(
                res,
                {
                  error: 'Application graph admission failed',
                  findings: runtime.execution.findings,
                },
                422,
              );
            }
            const sourceArtifact = deployment.sourceArtifactDigest
              ? getArtifact(deployment.sourceArtifactDigest)
              : null;
            if (!sourceArtifact?.localPath || !existsSync(sourceArtifact.localPath)) {
              return error(
                res,
                'Retained application source is unavailable; redeploy from the repository',
                409,
              );
            }

            const buildLogId = createBuildLog(name);
            updateCurrentBuildLogId(name, buildLogId);
            updateDeploymentStatus(name, 'starting');
            emit({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: 'starting', username: auth.username, nodeId: siteId },
            });
            const startedAt = Date.now();
            const job = enqueueAgentJob({
              nodeId: siteId,
              type: 'deploy',
              deploymentName: name,
              artifactPath: sourceArtifact.localPath,
              payload: {
                buildLogId,
                noCache: false,
                memoryLimit: deployment.memoryLimit || '4g',
                cpuLimit: deployment.cpuLimit || undefined,
                graph: createAgentGraphPayload({
                  deploymentName: name,
                  applicationId: deployment.appId || name,
                  siteId,
                  writerSiteId: applicationWriterSiteId(deployment.appId || name, siteId),
                  runtime,
                  runtimeVolumes: getDeploymentVolumes(name),
                }),
              },
            });
            const deadline = Date.now() + 20 * 60_000;
            let finishedJob = getAgentJob(job.id);
            while (
              finishedJob &&
              finishedJob.status !== 'complete' &&
              finishedJob.status !== 'failed' &&
              Date.now() < deadline
            ) {
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
              finishedJob = getAgentJob(job.id);
            }
            const duration = Date.now() - startedAt;
            if (!finishedJob || finishedJob.status !== 'complete') {
              const message = finishedJob?.error || `Timed out waiting for "${targetNode.name}"`;
              completeBuildLog(buildLogId, { success: false, duration });
              updateDeploymentStatus(name, 'failed');
              emit({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'failed', username: auth.username, nodeId: siteId },
              });
              return error(res, message, finishedJob ? 500 : 504);
            }

            const remoteResult = finishedJob.result ? JSON.parse(finishedJob.result) : {};
            recordAgentGraphMaterialization({
              deploymentName: name,
              applicationId: deployment.appId || name,
              siteId,
              nodeId: siteId,
              nodeAddress: targetNode.address || '127.0.0.1',
              relayPort: Number(remoteResult.port) || null,
              runtime,
              result: remoteResult as AgentGraphExecutionResult,
            });
            activateDesiredApplicationSpec(name, desiredDigest, configuration.digest);
            publishActivatedApplicationRevision(name, auth.username);
            saveDeployment({
              name,
              type: 'application-graph',
              username: deployment.username,
              port: Number(remoteResult.port) || undefined,
              containerId: String(remoteResult.containerId || ''),
              containerName: String(remoteResult.containerName || ''),
              directory: deployment.directory,
              desiredNodeId: siteId,
              activeNodeId: siteId,
              createdAt: deployment.createdAt || undefined,
            });
            updateDeploymentConfigurationDigest(name, configuration.digest);
            completeBuildLog(buildLogId, { success: true, duration });
            addDeployEvent(name, { action: 'graph-apply', username: auth.username, source: 'ui' });
            updateDeploymentStatus(name, 'running');
            emit({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: 'running', username: auth.username, nodeId: siteId },
            });
            return json(res, { applied: true, activeDigest: desiredDigest, remote: true });
          }
          if (!localGraphSiteFor(deployment)) {
            return error(
              res,
              'Applying a graph revision requires the target-local site control surface',
              409,
            );
          }
          if (!configuration.ready) {
            const prepared = await new ApplicationGraphExecutor().prepare({
              deploymentName: name,
              applicationId: deployment.appId || name,
              siteId,
              nodeId: siteId,
              projectDirectory: deployment.directory,
              runtime,
              writerSiteId: applicationWriterSiteId(deployment.appId || name, siteId),
              memoryLimit: deployment.memoryLimit || '4g',
              cpuLimit: deployment.cpuLimit || undefined,
            });
            updateDeploymentStatus(name, CONFIGURATION_REQUIRED_STATUS);
            return json(
              res,
              {
                error: `Required application configuration is missing: ${configuration.missing.join(', ')}`,
                buildCompleted: true,
                activationGated: true,
                missingConfiguration: configuration.missing,
                preparedComponents: prepared.components.map((component) => component.component),
              },
              428,
            );
          }
          if (!runtime.ready) {
            return json(
              res,
              {
                error: 'Application graph admission failed',
                findings: runtime.execution.findings,
              },
              422,
            );
          }
          const previousStatus = deployment.status || 'unknown';
          updateDeploymentStatus(name, 'recreating');
          try {
            const result = await new ApplicationGraphExecutor().converge({
              deploymentName: name,
              applicationId: deployment.appId || name,
              siteId,
              nodeId: siteId,
              projectDirectory: deployment.directory,
              runtime,
              writerSiteId: applicationWriterSiteId(deployment.appId || name, siteId),
              memoryLimit: deployment.memoryLimit || '4g',
              cpuLimit: deployment.cpuLimit || undefined,
            });
            activateDesiredApplicationSpec(name, desiredDigest, configuration.digest);
            publishActivatedApplicationRevision(name, auth.username);
            saveDeployment({
              name,
              type: deployment.type || 'application-graph',
              username: deployment.username,
              port: result.primaryPort ?? undefined,
              containerId: result.primaryContainerId ?? undefined,
              containerName: result.primaryContainerName ?? undefined,
              directory: deployment.directory,
              desiredNodeId: deployment.desiredNodeId,
              activeNodeId: deployment.activeNodeId,
              createdAt: deployment.createdAt || undefined,
            });
            updateDeploymentConfigurationDigest(name, configuration.digest);
            addDeployEvent(name, {
              action: 'graph-apply',
              username: auth.username,
              source: 'ui',
            });
            updateDeploymentStatus(name, 'running');
            emit({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: 'running', username: auth.username },
            });
            return json(res, {
              applied: true,
              activeDigest: desiredDigest,
              plan,
              instances: result.instances.length,
            });
          } catch (applyError) {
            updateDeploymentStatus(name, previousStatus);
            throw applyError;
          }
        } catch (applyError) {
          if (applyError instanceof FleetMutationBlockedError) {
            return fleetMutationBlocked(res, applyError);
          }
          return error(res, (applyError as Error).message, 400);
        } finally {
          lease.release();
        }
      }

      const deployYamlMatch = path.match(/^\/api\/deployments\/([^/]+)\/deploy\.yaml$/);

      if (deployYamlMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = deployYamlMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username) {
          return error(res, 'Not found', 404);
        }
        const digest = deployment.desiredSpecDigest || deployment.activeSpecDigest;
        const revision = digest ? getApplicationSpecRevision(name, digest) : null;
        if (!revision) return error(res, 'Application manifest not found', 404);
        const manifest = renderRepositoryDeployYaml(
          parseStoredApplicationSpec(revision.normalizedSpec),
          revision.digest,
        );
        res.writeHead(200, {
          'Content-Type': 'application/yaml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}-deploy.yaml"`,
          'Content-Length': Buffer.byteLength(manifest),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(manifest);
        return;
      }

      const applicationConfigurationMatch = path.match(
        /^\/api\/deployments\/([^/]+)\/configuration(?:\/([^/]+))?$/,
      );

      if (applicationConfigurationMatch && (method === 'GET' || method === 'PUT')) {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = applicationConfigurationMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username) {
          return error(res, 'Not found', 404);
        }
        const revisionTarget = url.searchParams.get('revision') || 'desired';
        if (revisionTarget !== 'desired' && revisionTarget !== 'active') {
          return error(res, 'Configuration revision must be "desired" or "active"', 400);
        }
        const selectedDigest =
          revisionTarget === 'active'
            ? deployment.activeSpecDigest
            : deployment.desiredSpecDigest || deployment.activeSpecDigest;
        const revision = selectedDigest ? getApplicationSpecRevision(name, selectedDigest) : null;
        if (!revision) return error(res, 'Application manifest not found', 404);
        const spec = parseStoredApplicationSpec(revision.normalizedSpec);
        const requestedSiteId = url.searchParams.get('siteId') || undefined;
        const siteId =
          requestedSiteId ||
          (revisionTarget === 'active'
            ? deployment.activeNodeId
            : deployment.desiredNodeId || deployment.activeNodeId) ||
          'coordinator';
        const site = getNode(siteId);
        if (!site || site.revokedAt) return error(res, 'Site not found', 404);

        if (method === 'PUT') {
          const key = applicationConfigurationMatch[2];
          if (!key) return error(res, 'Configuration key required', 400);
          const body = JSON.parse((await readBody(req)).toString() || '{}');
          try {
            const declaration = spec.configuration[key];
            if (body.siteId !== undefined && String(body.siteId) !== siteId) {
              return error(res, 'Configuration site does not match the requested site', 400);
            }
            const revisionNumber = setDeclaredConfigurationValue({
              deploymentName: name,
              specDigest: revision.digest,
              declarations: spec.configuration,
              key,
              value: body.value,
              updatedBy: auth.username,
              siteId: declaration?.scope === 'site' ? siteId : undefined,
            });
            const projectedReplicas =
              declaration?.scope === 'application' && deployment.appId
                ? projectApplicationConfigurationToReplicas(deployment.appId, auth.username)
                : 0;
            const resolved = resolveApplicationConfiguration({
              deploymentName: name,
              specDigest: revision.digest,
              declarations: spec.configuration,
              siteId,
            });
            const activeConfiguration = revision.digest === deployment.activeSpecDigest;
            let runtimeReconciled = false;
            let reconcileQueued = projectedReplicas > 0;
            if (
              activeConfiguration &&
              !resolved.ready &&
              (deployment.status === 'running' ||
                deployment.status === CONFIGURATION_REQUIRED_STATUS)
            ) {
              updateDeploymentStatus(name, CONFIGURATION_REQUIRED_STATUS);
            } else if (
              activeConfiguration &&
              resolved.ready &&
              deployment.directory &&
              (deployment.status === 'running' ||
                deployment.status === CONFIGURATION_REQUIRED_STATUS)
            ) {
              const localSiteId = localGraphSiteFor(deployment);
              if (localSiteId === siteId) {
                const runtime = buildApplicationGraphRuntime({
                  applicationId: deployment.appId || name,
                  specDigest: revision.digest,
                  spec,
                  configuration: resolved,
                  siteId,
                });
                if (!runtime.ready) {
                  return json(
                    res,
                    {
                      error: 'Application graph admission failed after configuration update',
                      findings: runtime.execution.findings,
                    },
                    422,
                  );
                }
                const previousStatus = deployment.status || CONFIGURATION_REQUIRED_STATUS;
                updateDeploymentStatus(name, 'reconfiguring');
                try {
                  await new ApplicationGraphExecutor().converge({
                    deploymentName: name,
                    applicationId: deployment.appId || name,
                    siteId,
                    nodeId: siteId,
                    projectDirectory: deployment.directory,
                    runtime,
                    writerSiteId: applicationWriterSiteId(deployment.appId || name, siteId),
                    memoryLimit: deployment.memoryLimit || '4g',
                    cpuLimit: deployment.cpuLimit || undefined,
                  });
                  updateDeploymentConfigurationDigest(name, resolved.digest);
                  updateDeploymentStatus(name, 'running');
                  addDeployEvent(name, {
                    action: 'configuration-reconcile',
                    username: auth.username,
                    source: 'ui',
                  });
                  runtimeReconciled = true;
                  reconcileQueued = false;
                } catch (reconcileError) {
                  updateDeploymentStatus(name, previousStatus);
                  throw reconcileError;
                }
              }
            }
            return json(res, {
              key,
              revision: revisionNumber,
              ready: resolved.ready,
              missing: resolved.missing,
              configurationDigest: resolved.digest,
              revisionTarget,
              specDigest: revision.digest,
              restartRequired:
                activeConfiguration && deployment.status === 'running' && !runtimeReconciled,
              activationRequired: !activeConfiguration,
              runtimeReconciled,
              reconcileQueued,
            });
          } catch (err) {
            return error(res, (err as Error).message, 400);
          }
        }

        const applicationValues = new Map(
          getApplicationConfigurationValues(name, revision.digest).map((value) => [
            value.key,
            value,
          ]),
        );
        const siteValues = new Map(
          getApplicationConfigurationValues(name, revision.digest, siteId).map((value) => [
            value.key,
            value,
          ]),
        );
        const resolved = resolveApplicationConfiguration({
          deploymentName: name,
          specDigest: revision.digest,
          declarations: spec.configuration,
          siteId,
        });
        return json(res, {
          siteId,
          revisionTarget,
          specDigest: revision.digest,
          activeDigest: deployment.activeSpecDigest,
          desiredDigest: deployment.desiredSpecDigest,
          ready: resolved.ready,
          missing: resolved.missing,
          configurationDigest: resolved.digest,
          declarations: Object.fromEntries(
            Object.entries(spec.configuration).map(([key, declaration]) => {
              const stored =
                declaration.scope === 'site' ? siteValues.get(key) : applicationValues.get(key);
              return [
                key,
                {
                  ...declaration,
                  configured: Boolean(stored) || declaration.default !== undefined,
                  revision: stored?.revision || 0,
                  updatedAt: stored?.updatedAt || null,
                },
              ];
            }),
          ),
        });
      }

      const deploymentNodeMatch = path.match(/^\/api\/deployments\/([^/]+)\/node$/);

      if (deploymentNodeMatch && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = deploymentNodeMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username)
          return error(res, 'Not found', 404);
        if (deployment.status && MIGRATION_STATES.has(deployment.status)) {
          return error(res, 'This application is already moving between nodes', 409);
        }
        const body = JSON.parse((await readBody(req)).toString());
        const nodeId = String(body.nodeId || '');
        assertDeployRole(nodeId);
        const targetNode = getNode(nodeId);
        if (!targetNode || targetNode.revokedAt) return error(res, 'Node not found', 404);
        if (!targetNode.online)
          return error(res, `Deployment node "${targetNode.name}" is offline`, 503);
        const activeNodeId = deployment.activeNodeId || 'coordinator';
        if (activeNodeId === nodeId) {
          return error(res, `${name} is already running on ${targetNode.name}`, 409);
        }
        const artifactPath = latestRetainedArtifact(name);
        if (!artifactPath) {
          return error(
            res,
            'No retained source artifact is available. Run deploy once before using Move now.',
            409,
          );
        }
        try {
          setDeploymentDesiredNode(name, nodeId);
          const accepted = await submitRetainedArtifact(artifactPath, name, auth);
          return json(
            res,
            {
              ...accepted,
              message: `Migration to ${targetNode.name} started`,
              dashboardUrl: `/dashboard/${encodeURIComponent(name)}/build`,
            },
            202,
          );
        } catch (err) {
          return error(res, (err as Error).message, 500);
        }
      }

      if (deploymentNodeMatch && method === 'PUT') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = deploymentNodeMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username)
          return error(res, 'Not found', 404);
        const body = JSON.parse((await readBody(req)).toString());
        try {
          const updated = setDeploymentDesiredNode(name, String(body.nodeId || ''));
          return json(res, {
            deployment: updated,
            message:
              updated?.activeNodeId === updated?.desiredNodeId
                ? 'Deployment node unchanged'
                : 'Node selected. The next deployment will move this application.',
          });
        } catch (err) {
          return error(res, (err as Error).message);
        }
      }

      const componentActionMatch = path.match(
        /^\/api\/deployments\/([^/]+)\/components\/([^/]+)\/(restart|scale)$/,
      );

      const instanceReplaceMatch = path.match(
        /^\/api\/deployments\/([^/]+)\/components\/([^/]+)\/instances\/([^/]+)\/replace$/,
      );

      if (
        (componentActionMatch || instanceReplaceMatch) &&
        (method === 'POST' || method === 'PUT')
      ) {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const match = componentActionMatch || instanceReplaceMatch!;
        const name = match[1].toLowerCase();
        const component = decodeURIComponent(match[2]);
        const deployment = getDeployment(name);
        if (!deployment) return error(res, 'Not found', 404);
        const siteId = localGraphSiteFor(deployment);
        try {
          const executor = new ApplicationGraphExecutor();
          if (componentActionMatch?.[3] === 'scale') {
            if (method !== 'PUT') return error(res, 'Scale requires PUT', 405);
            const body = JSON.parse((await readBody(req)).toString() || '{}') as {
              instances?: unknown;
              expectedParentDigest?: unknown;
              confirmDestructive?: unknown;
              scope?: unknown;
              useDefault?: unknown;
              siteId?: unknown;
            };
            const scope = body.scope === undefined ? 'default' : String(body.scope);
            if (scope !== 'default' && scope !== 'site') {
              return error(res, 'scope must be "default" or "site"', 400);
            }
            const useDefault = body.useDefault === true;
            if (scope === 'default' && useDefault) {
              return error(res, 'useDefault is valid only for a site-scoped count', 400);
            }
            const instances = useDefault ? null : Number(body.instances);
            if (
              instances !== null &&
              (!Number.isSafeInteger(instances) || instances < 1 || instances > 128)
            ) {
              return error(res, 'instances must be an integer from 1 through 128', 400);
            }
            const parentDigest = deployment.desiredSpecDigest || deployment.activeSpecDigest;
            if (body.expectedParentDigest !== parentDigest) {
              return json(
                res,
                { error: 'Application revision changed', expectedParentDigest: parentDigest },
                409,
              );
            }
            const parentRevision = parentDigest
              ? getApplicationSpecRevision(name, parentDigest)
              : null;
            if (!parentRevision) return error(res, 'Desired application graph is missing', 409);
            const current = parseStoredApplicationSpec(parentRevision.normalizedSpec);
            if (!current.components[component]) {
              return error(res, `Unknown application component ${component}`, 404);
            }
            const currentComponent = current.components[component]!;
            const applicationId = deployment.appId || registerApplicationIdentity(name);
            if (scope === 'site') {
              const targetSiteId = body.siteId === undefined ? siteId : String(body.siteId).trim();
              if (!targetSiteId) return error(res, 'siteId is required for a site count', 400);
              if (targetSiteId !== siteId && process.env.DEPLOY_SUITCASE === '1') {
                return error(res, 'A Suitcase may change only its own local component count', 409);
              }
              if (!currentComponent.siteOverrides.allowed) {
                return error(
                  res,
                  `Component ${component} does not allow site-specific instance counts`,
                  409,
                );
              }
              if (
                instances !== null &&
                (instances < currentComponent.siteOverrides.minimum ||
                  instances > currentComponent.siteOverrides.maximum)
              ) {
                return error(
                  res,
                  `instances must be between ${currentComponent.siteOverrides.minimum} and ${currentComponent.siteOverrides.maximum} for component ${component}`,
                  400,
                );
              }
              const overrides = getComponentSiteOverrides(applicationId, targetSiteId);
              const effectiveInstances = instances ?? currentComponent.instances;
              const previousEffectiveInstances = overrides[component] ?? currentComponent.instances;
              const admittedOverrides = { ...overrides, [component]: effectiveInstances };
              const admission = planApplicationExecution(applicationId, current, {
                targetSiteId,
                siteInstanceOverrides: admittedOverrides,
                placementTarget: resolvePlacementTarget(targetSiteId),
              });
              if (admission.blocked) {
                return json(
                  res,
                  { error: 'Site-specific count is blocked', findings: admission.findings },
                  409,
                );
              }
              if (targetSiteId !== siteId) {
                const published = publishComponentSiteCount({
                  appId: applicationId,
                  deploymentName: name,
                  targetSiteId,
                  componentKey: component,
                  specDigest: parentDigest!,
                  instances,
                  actor: auth.username,
                });
                addDeployEvent(name, {
                  action: `scale:${component}:${published.effectiveInstances}:site:${targetSiteId}:pending`,
                  username: auth.username,
                  source: 'ui',
                });
                return json(
                  res,
                  {
                    component,
                    instances: published.effectiveInstances,
                    defaultInstances: published.defaultInstances,
                    siteId: targetSiteId,
                    siteOverride: instances,
                    specDigest: parentDigest,
                    activeSpecDigest: deployment.activeSpecDigest,
                    eventId: published.eventId,
                    pendingTargetProcessing: true,
                  },
                  202,
                );
              }
              if (!siteId || targetSiteId !== siteId) {
                return error(
                  res,
                  'Component operations require the target-local site control surface',
                  409,
                );
              }
              if (!deployment.directory) {
                return error(res, 'Application graph source directory is missing', 409);
              }
              const configuration = resolveApplicationConfiguration({
                deploymentName: name,
                specDigest: parentDigest!,
                declarations: current.configuration,
                siteId: targetSiteId,
              });
              if (!configuration.ready) {
                return error(
                  res,
                  `Required application configuration is missing: ${configuration.missing.join(', ')}`,
                  428,
                );
              }
              if (effectiveInstances < previousEffectiveInstances) {
                assertFleetMutationReady({
                  appId: applicationId,
                  applicationName: name,
                  kind: 'destructive-graph-change',
                  mutationFingerprint: destructiveGraphMutationFingerprint(
                    applicationId,
                    `${parentDigest}:site:${targetSiteId}:component:${encodeURIComponent(component)}:instances:${effectiveInstances}`,
                  ),
                  consequence: `This site-specific scale operation removes ${previousEffectiveInstances - effectiveInstances} ${component} instance${previousEffectiveInstances - effectiveInstances === 1 ? '' : 's'} at ${targetSiteId}. Every selected suitcase must sync and acknowledge this exact operational change first.`,
                  actor: auth.username,
                });
              }
              setComponentSiteOverride({
                appId: applicationId,
                deploymentName: name,
                siteId: targetSiteId,
                componentKey: component,
                instances,
                updatedBy: auth.username,
              });
              const runtime = buildApplicationGraphRuntime({
                applicationId,
                specDigest: parentDigest!,
                spec: current,
                configuration,
                siteId: targetSiteId,
              });
              const result = await executor.converge({
                deploymentName: name,
                applicationId,
                siteId: targetSiteId,
                nodeId: targetSiteId,
                projectDirectory: deployment.directory,
                runtime,
                writerSiteId: applicationWriterSiteId(applicationId, targetSiteId),
                memoryLimit: deployment.memoryLimit || '4g',
                cpuLimit: deployment.cpuLimit || undefined,
              });
              saveDeployment({
                name,
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
              updateDeploymentStatus(name, 'running');
              addDeployEvent(name, {
                action: `scale:${component}:${effectiveInstances}:site:${targetSiteId}`,
                username: auth.username,
                source: 'ui',
              });
              return json(res, {
                component,
                instances: effectiveInstances,
                defaultInstances: currentComponent.instances,
                siteId: targetSiteId,
                siteOverride: instances,
                specDigest: parentDigest,
                activeSpecDigest: deployment.activeSpecDigest,
              });
            }
            if (!siteId) {
              return error(
                res,
                'Component operations require the target-local site control surface',
                409,
              );
            }
            if (!deployment.directory) {
              return error(res, 'Application graph source directory is missing', 409);
            }
            const proposed = structuredClone(current);
            proposed.components[component]!.instances = instances!;
            const candidate = compileDeployYaml(renderDeployYaml(proposed), 'component scale');
            const plan = planApplicationChange(current, candidate.spec, { source: 'ui' });
            if (plan.blocked) return json(res, { error: 'Scale plan is blocked', plan }, 409);
            if (plan.destructive && body.confirmDestructive !== true) {
              return json(res, { error: 'Scale-down requires confirmation', plan }, 409);
            }
            if (requiresFleetAcknowledgement(plan, candidate.spec)) {
              assertFleetMutationReady({
                appId: applicationId,
                applicationName: name,
                kind: 'destructive-graph-change',
                mutationFingerprint: destructiveGraphMutationFingerprint(
                  applicationId,
                  candidate.digest,
                ),
                consequence:
                  'This scale operation removes application graph state. Every selected suitcase must sync and acknowledge this exact revision first.',
                actor: auth.username,
              });
            }
            saveDesiredApplicationSpec({
              digest: candidate.digest,
              deploymentName: name,
              parentDigest,
              apiVersion: candidate.spec.apiVersion,
              source: 'ui',
              manifestFormat: 'deploy.yaml',
              normalizedSpec: candidate.canonicalJson,
              originalSource: renderDeployYaml(candidate.spec),
              createdBy: auth.username,
            });
            carryForwardCompatibleConfiguration({
              deploymentName: name,
              fromSpec: current,
              fromDigest: parentDigest!,
              toSpec: candidate.spec,
              toDigest: candidate.digest,
              updatedBy: auth.username,
            });
            const configuration = resolveApplicationConfiguration({
              deploymentName: name,
              specDigest: candidate.digest,
              declarations: candidate.spec.configuration,
              siteId,
            });
            if (!configuration.ready) {
              return error(
                res,
                `Required application configuration is missing: ${configuration.missing.join(', ')}`,
                428,
              );
            }
            const runtime = buildApplicationGraphRuntime({
              applicationId,
              specDigest: candidate.digest,
              spec: candidate.spec,
              configuration,
              siteId,
            });
            const result = await executor.converge({
              deploymentName: name,
              applicationId,
              siteId,
              nodeId: siteId,
              projectDirectory: deployment.directory,
              runtime,
              writerSiteId: applicationWriterSiteId(applicationId, siteId),
              memoryLimit: deployment.memoryLimit || '4g',
              cpuLimit: deployment.cpuLimit || undefined,
            });
            activateDesiredApplicationSpec(name, candidate.digest, configuration.digest);
            publishActivatedApplicationRevision(name, auth.username);
            saveDeployment({
              name,
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
            updateDeploymentStatus(name, 'running');
            addDeployEvent(name, {
              action: `scale:${component}:${instances}`,
              username: auth.username,
              source: 'ui',
            });
            return json(res, {
              component,
              instances,
              specDigest: candidate.digest,
              activeSpecDigest: candidate.digest,
            });
          }

          if (method !== 'POST') return error(res, 'Component operation requires POST', 405);
          if (!siteId) {
            return error(
              res,
              'Component operations require the target-local site control surface',
              409,
            );
          }
          if (!deployment.directory) {
            return error(res, 'Application graph source directory is missing', 409);
          }
          const runtime = resolveApplicationGraphRuntime(deployment);
          if (!runtime.ready) {
            return error(
              res,
              `Required application configuration is missing: ${runtime.missing.join(', ')}`,
              428,
            );
          }
          const context = {
            deploymentName: name,
            applicationId: deployment.appId || name,
            siteId,
            nodeId: siteId,
            projectDirectory: deployment.directory,
            runtime,
            writerSiteId: applicationWriterSiteId(deployment.appId || name, siteId),
            memoryLimit: deployment.memoryLimit || '4g',
            cpuLimit: deployment.cpuLimit || undefined,
          };
          const result = instanceReplaceMatch
            ? await executor.replaceInstance(context, decodeURIComponent(instanceReplaceMatch[3]))
            : await executor.restartComponent(context, component);
          saveDeployment({
            name,
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
          addDeployEvent(name, {
            action: instanceReplaceMatch
              ? `replace:${component}:${decodeURIComponent(instanceReplaceMatch[3])}`
              : `restart:${component}`,
            username: auth.username,
            source: 'ui',
          });
          updateDeploymentStatus(name, 'running');
          return json(res, {
            component,
            instanceId: instanceReplaceMatch
              ? decodeURIComponent(instanceReplaceMatch[3])
              : undefined,
            instances: result.instances.length,
            activeSpecDigest: deployment.activeSpecDigest,
          });
        } catch (componentError) {
          if (componentError instanceof FleetMutationBlockedError) {
            return fleetMutationBlocked(res, componentError);
          }
          return error(res, (componentError as Error).message, 400);
        }
      }

      const profileOperationMatch = path.match(
        /^\/api\/deployments\/([^/]+)\/components\/([^/]+)\/operations\/([^/]+)$/,
      );

      if (profileOperationMatch && method === 'POST') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const name = profileOperationMatch[1].toLowerCase();
        const component = decodeURIComponent(profileOperationMatch[2]);
        const operation = decodeURIComponent(profileOperationMatch[3]);
        const deployment = getDeployment(name);
        if (!deployment) return error(res, 'Not found', 404);
        const siteId = localGraphSiteFor(deployment);
        if (!siteId) {
          return error(
            res,
            'Profile operations require the target-local site control surface',
            409,
          );
        }
        const revision = deployment.activeSpecDigest
          ? getApplicationSpecRevision(name, deployment.activeSpecDigest)
          : null;
        if (revision?.manifestFormat !== 'deploy.yaml') {
          return error(res, 'This deployment has no active component graph', 409);
        }
        if (!deployment.directory) {
          return error(res, 'Application graph source directory is missing', 409);
        }
        try {
          const body = JSON.parse((await readBody(req)).toString() || '{}') as {
            variables?: Record<string, unknown>;
            artifactDigest?: unknown;
          };
          const variables = Object.fromEntries(
            Object.entries(body.variables ?? {}).map(([key, value]) => {
              if (typeof value !== 'string') {
                throw new Error(`Profile operation variable ${key} must be a string`);
              }
              return [key, value];
            }),
          );
          const runtime = resolveApplicationGraphRuntime(deployment);
          if (!runtime.ready) {
            throw new Error(
              `Required application configuration is missing: ${runtime.missing.join(', ')}`,
            );
          }
          const profileOperation = runtime.execution.components[
            component
          ]?.profile?.operations.find((candidate) => candidate.id === operation);
          if (!profileOperation) {
            throw new Error(
              `Component ${JSON.stringify(component)} does not support profile operation ${JSON.stringify(operation)}`,
            );
          }
          if (body.artifactDigest !== undefined && typeof body.artifactDigest !== 'string') {
            throw new Error('Profile operation artifactDigest must be a string');
          }
          const baseContext: GraphExecutorContext = {
            deploymentName: name,
            applicationId: deployment.appId || name,
            siteId,
            nodeId: siteId,
            projectDirectory: deployment.directory,
            runtime,
            writerSiteId: applicationWriterSiteId(deployment.appId || name, siteId),
            memoryLimit: deployment.memoryLimit || '4g',
            cpuLimit: deployment.cpuLimit || undefined,
          };
          let targetContext: GraphExecutorContext | undefined;
          let activationCommit: (() => void) | undefined;
          let activationRollback: (() => void) | undefined;
          const originalActiveDigest = deployment.activeSpecDigest!;
          const originalDesiredDigest = deployment.desiredSpecDigest;
          const originalConfigurationDigest = deployment.configurationDigest;

          if (profileOperation.workflow === 'logical-major-upgrade') {
            const targetDigest = deployment.desiredSpecDigest;
            if (!targetDigest || targetDigest === originalActiveDigest) {
              throw new Error(
                'Major profile upgrade requires a different desired application revision',
              );
            }
            const applicationId = deployment.appId || registerApplicationIdentity(name);
            assertFleetMutationReady({
              appId: applicationId,
              applicationName: name,
              kind: 'destructive-graph-change',
              mutationFingerprint: destructiveGraphMutationFingerprint(applicationId, targetDigest),
              consequence:
                'This major component profile upgrade changes durable data schema and application graph state. Every selected suitcase must sync and acknowledge the target revision first.',
              actor: auth.username,
            });
            const targetRevision = getApplicationSpecRevision(name, targetDigest);
            if (targetRevision?.manifestFormat !== 'deploy.yaml') {
              throw new Error('Desired application graph revision not found');
            }
            const targetSpec = parseStoredApplicationSpec(targetRevision.normalizedSpec);
            const targetConfiguration = resolveApplicationConfiguration({
              deploymentName: name,
              specDigest: targetDigest,
              declarations: targetSpec.configuration,
              siteId,
            });
            if (!targetConfiguration.ready) {
              throw new Error(
                `Required target configuration is missing: ${targetConfiguration.missing.join(', ')}`,
              );
            }
            const targetRuntime = buildApplicationGraphRuntime({
              applicationId: deployment.appId || name,
              specDigest: targetDigest,
              spec: targetSpec,
              configuration: targetConfiguration,
              siteId,
            });
            targetContext = { ...baseContext, runtime: targetRuntime };
            activationCommit = () =>
              transitionProfileApplicationSpec({
                deploymentName: name,
                expectedActiveSpecDigest: originalActiveDigest,
                expectedDesiredSpecDigest: originalDesiredDigest,
                targetActiveSpecDigest: targetDigest,
                targetDesiredSpecDigest: targetDigest,
                configurationDigest: targetConfiguration.digest,
              });
            activationRollback = () =>
              transitionProfileApplicationSpec({
                deploymentName: name,
                expectedActiveSpecDigest: targetDigest,
                expectedDesiredSpecDigest: targetDigest,
                targetActiveSpecDigest: originalActiveDigest,
                targetDesiredSpecDigest: originalDesiredDigest,
                configurationDigest: originalConfigurationDigest,
              });
          } else if (profileOperation.workflow === 'logical-rollback') {
            const actual = getApplicationGraphState(name, deployment.appId || name, siteId);
            const binding = actual.profileVolumeBindings.find(
              (candidate) => candidate.componentKey === component,
            );
            const targetDigest = binding?.rollbackSpecDigest;
            if (!targetDigest) throw new Error('No preserved profile rollback revision exists');
            const applicationId = deployment.appId || registerApplicationIdentity(name);
            assertFleetMutationReady({
              appId: applicationId,
              applicationName: name,
              kind: 'destructive-graph-change',
              mutationFingerprint: destructiveGraphMutationFingerprint(applicationId, targetDigest),
              consequence:
                'This component profile rollback changes durable data schema and application graph state. Every selected suitcase must sync and acknowledge the rollback revision first.',
              actor: auth.username,
            });
            const targetRevision = getApplicationSpecRevision(name, targetDigest);
            if (targetRevision?.manifestFormat !== 'deploy.yaml') {
              throw new Error('Preserved profile rollback revision not found');
            }
            const targetSpec = parseStoredApplicationSpec(targetRevision.normalizedSpec);
            const targetConfiguration = resolveApplicationConfiguration({
              deploymentName: name,
              specDigest: targetDigest,
              declarations: targetSpec.configuration,
              siteId,
            });
            if (!targetConfiguration.ready) {
              throw new Error(
                `Required rollback configuration is missing: ${targetConfiguration.missing.join(', ')}`,
              );
            }
            const targetRuntime = buildApplicationGraphRuntime({
              applicationId: deployment.appId || name,
              specDigest: targetDigest,
              spec: targetSpec,
              configuration: targetConfiguration,
              siteId,
            });
            targetContext = { ...baseContext, runtime: targetRuntime };
            activationCommit = () =>
              transitionProfileApplicationSpec({
                deploymentName: name,
                expectedActiveSpecDigest: originalActiveDigest,
                expectedDesiredSpecDigest: originalDesiredDigest,
                targetActiveSpecDigest: targetDigest,
                targetDesiredSpecDigest: targetDigest,
                configurationDigest: targetConfiguration.digest,
              });
            activationRollback = () =>
              transitionProfileApplicationSpec({
                deploymentName: name,
                expectedActiveSpecDigest: targetDigest,
                expectedDesiredSpecDigest: targetDigest,
                targetActiveSpecDigest: originalActiveDigest,
                targetDesiredSpecDigest: originalDesiredDigest,
                configurationDigest: originalConfigurationDigest,
              });
          }
          const result = await new ApplicationGraphExecutor().executeProfileOperation(baseContext, {
            component,
            operation,
            variables,
            artifactDigest: body.artifactDigest,
            targetContext,
            activationCommit,
            activationRollback,
          });
          if (result.materialization) {
            saveDeployment({
              name,
              type: deployment.type || undefined,
              username: deployment.username,
              port: result.materialization.primaryPort ?? undefined,
              containerId: result.materialization.primaryContainerId ?? undefined,
              containerName: result.materialization.primaryContainerName ?? undefined,
              directory: deployment.directory,
              desiredNodeId: deployment.desiredNodeId,
              activeNodeId: deployment.activeNodeId,
              createdAt: deployment.createdAt || undefined,
            });
            updateDeploymentStatus(name, 'running');
          }
          if (
            profileOperation.workflow === 'logical-major-upgrade' ||
            profileOperation.workflow === 'logical-rollback'
          ) {
            publishActivatedApplicationRevision(name, auth.username);
          }
          addDeployEvent(name, {
            action: `profile:${component}:${operation}`,
            username: auth.username,
            source: 'ui',
          });
          return json(res, result, 201);
        } catch (profileError) {
          if (profileError instanceof FleetMutationBlockedError) {
            return fleetMutationBlocked(res, profileError);
          }
          return error(res, (profileError as Error).message, 400);
        }
      }

      const migrationProgressMatch = path.match(
        /^\/api\/deployments\/([^/]+)\/migration-progress$/,
      );

      if (migrationProgressMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = migrationProgressMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username)
          return error(res, 'Not found', 404);
        return json(res, {
          active: Boolean(deployment.status && MIGRATION_STATES.has(deployment.status)),
          progress: migrationProgressByDeployment.get(name) || null,
        });
      }

      const deploymentMatch = path.match(/^\/api\/deployments\/([^/]+)$/);

      if (deploymentMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const d = getDeployment(deploymentMatch[1]);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        const status = await resolveStatusAsync(d);
        return json(res, { ...d, status });
      }

      if (deploymentMatch && method === 'DELETE') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = deploymentMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        const applicationId = d.appId || registerApplicationIdentity(name);
        try {
          assertFleetMutationReady({
            appId: applicationId,
            applicationName: name,
            kind: 'application-delete',
            mutationFingerprint: applicationDeleteMutationFingerprint(applicationId),
            consequence:
              'Deleting this application removes its Home runtime, graph record, and managed data. It cannot proceed while a selected suitcase may still hold an unreceived branch.',
            actor: auth.username,
          });
        } catch (deleteGuardError) {
          if (deleteGuardError instanceof FleetMutationBlockedError) {
            return fleetMutationBlocked(res, deleteGuardError);
          }
          throw deleteGuardError;
        }
        const activeRevision = d.activeSpecDigest
          ? getApplicationSpecRevision(name, d.activeSpecDigest)
          : null;
        if (activeRevision?.manifestFormat === 'deploy.yaml') {
          const siteId = localGraphSiteFor(d);
          if (siteId) {
            const spec = parseStoredApplicationSpec(activeRevision.normalizedSpec);
            await new ApplicationGraphExecutor().remove({
              applicationId: d.appId || name,
              siteId,
              managedVolumeResources: Object.entries(spec.resources)
                .filter(([, resource]) => resource.source?.type !== 'bind')
                .map(([resource]) => resource),
              removeInfrastructure: true,
            });
            deleteVolumes(name);
          } else {
            // On another computer: its worker removes the app and confirms it is gone. A new id
            // each time, so a later app with this name can never be answered by this job.
            await stopApp(d, `delete-${randomUUID()}`);
          }
        } else if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
          await dispatchAgentCommand(d.activeNodeId, 'delete', name, { deleteVolumes: true });
        } else {
          await removeContainer(name);
          deleteVolumes(name);
        }
        forgetCrashTracker(name);
        addDeployEvent(name, { action: 'delete', username: auth.username, source: 'ui' });
        deleteDeployment(name);
        emit({
          type: 'deployment:deleted',
          deploymentName: name,
          data: { username: auth.username },
        });
        return json(res, { message: `Deleted ${name}` });
      }

      if (deploymentMatch && method === 'PATCH') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = deploymentMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);

        const body = JSON.parse((await readBody(req)).toString());
        const activeRevision = d.activeSpecDigest
          ? getApplicationSpecRevision(name, d.activeSpecDigest)
          : null;
        if (activeRevision?.manifestFormat === 'deploy.yaml') {
          const manifestOwned = [
            'discoverable',
            'envVars',
            'gpuEnabled',
            'privilegedDocker',
            'extraPorts',
          ].filter((key) => body[key] !== undefined);
          if (manifestOwned.length > 0) {
            return error(
              res,
              `Settings ${manifestOwned.join(', ')} are owned by deploy.yaml; edit and redeploy the manifest`,
              409,
            );
          }
        }
        if (
          (body.gpuEnabled !== undefined ||
            body.privilegedDocker !== undefined ||
            body.volumes !== undefined) &&
          !isAdmin(auth.username)
        ) {
          return error(res, 'Host-level container settings require an administrator', 403);
        }
        const settings: {
          autoBackup?: boolean;
          discoverable?: boolean;
          envVars?: Record<string, string>;
          memoryLimit?: string;
          cpuLimit?: string;
          volumes?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
          gpuEnabled?: boolean;
          privilegedDocker?: boolean;
        } = {};
        let extraPortsConfig: Array<{ container: number; protocol?: string }> | undefined;
        if (body.autoBackup !== undefined) settings.autoBackup = body.autoBackup;
        if (body.discoverable !== undefined) settings.discoverable = body.discoverable;
        if (body.gpuEnabled !== undefined) settings.gpuEnabled = !!body.gpuEnabled;
        if (body.privilegedDocker !== undefined)
          settings.privilegedDocker = !!body.privilegedDocker;
        if (body.envVars !== undefined) settings.envVars = body.envVars;
        if (body.memoryLimit !== undefined) {
          const parsed = parseMemoryLimit(body.memoryLimit);
          if (parsed === null)
            return error(
              res,
              'Invalid memory limit format. Use values like "128m", "512m", "1g", "4g".',
              400,
            );
          if (parsed < 128 * 1024 * 1024)
            return error(res, 'Memory limit must be at least 128m', 400);
          if (parsed > totalmem()) return error(res, 'Memory limit exceeds system memory', 400);
          settings.memoryLimit = body.memoryLimit;
        }
        if (body.cpuLimit !== undefined) {
          // Numeric string like "0.5", "2", "4.0" — anything Docker --cpus accepts.
          // We bound it to [0.1, cpu-core-count] to avoid sub-second slices that
          // starve event loop ticks, or values larger than the host can offer.
          const cpuNum = parseFloat(body.cpuLimit);
          if (!Number.isFinite(cpuNum) || cpuNum < 0.1) {
            return error(res, 'cpuLimit must be a number ≥ 0.1', 400);
          }
          if (cpuNum > cpus().length) {
            return error(res, `cpuLimit exceeds available cores (${cpus().length})`, 400);
          }
          settings.cpuLimit = String(cpuNum);
        }
        if (body.volumes !== undefined) {
          if (!Array.isArray(body.volumes)) return error(res, 'volumes must be an array', 400);
          // Use the new privilegedDocker value if it's being changed, else fall back to current
          const effectivePrivilegedDocker =
            body.privilegedDocker !== undefined
              ? !!body.privilegedDocker
              : (d.privilegedDocker ?? false);
          // Host paths belong to the selected execution node. Only validate
          // existence locally when this deployment is assigned locally; the
          // agent performs the same validation before a remote container run.
          if (!d.desiredNodeId || d.desiredNodeId === 'coordinator') {
            const volError = validateVolumeMounts(body.volumes, {
              privilegedDocker: effectivePrivilegedDocker,
            });
            if (volError) return error(res, volError, 400);
          }
          settings.volumes = body.volumes;
        }
        if (body.extraPorts !== undefined) {
          if (!Array.isArray(body.extraPorts))
            return error(res, 'extraPorts must be an array', 400);
          for (let i = 0; i < body.extraPorts.length; i++) {
            const p = body.extraPorts[i];
            if (
              typeof p.container !== 'number' ||
              !Number.isInteger(p.container) ||
              p.container < 1 ||
              p.container > 65535
            )
              return error(
                res,
                `extraPorts[${i}].container must be an integer between 1 and 65535`,
                400,
              );
            if (p.protocol !== undefined && p.protocol !== 'tcp' && p.protocol !== 'udp')
              return error(res, `extraPorts[${i}].protocol must be "tcp" or "udp"`, 400);
          }
          extraPortsConfig = body.extraPorts;
        }
        updateDeploymentSettings(name, settings);

        // If env vars, volumes, GPU, privileged Docker, or extra ports changed, recreate the container so they take effect
        const needsRecreation =
          body.envVars !== undefined ||
          body.volumes !== undefined ||
          body.gpuEnabled !== undefined ||
          body.privilegedDocker !== undefined ||
          body.extraPorts !== undefined;
        if (
          needsRecreation &&
          activeRevision?.manifestFormat !== 'deploy.yaml' &&
          d.port &&
          d.status === 'running' &&
          (!d.activeNodeId || d.activeNodeId === 'coordinator')
        ) {
          const volumeDir = getVolumeDir(name);
          const memLimit = body.memoryLimit || d.memoryLimit || '4g';
          const envVarsToUse = body.envVars ?? (d.envVars ? JSON.parse(d.envVars) : {});
          const customVolumes = body.volumes ?? getDeploymentVolumes(name);
          const gpuFlag = body.gpuEnabled ?? d.gpuEnabled ?? false;
          const privilegedDockerFlag = body.privilegedDocker ?? d.privilegedDocker ?? false;
          // If user didn't change extraPorts, preserve existing DB ports
          if (extraPortsConfig === undefined && d.extraPorts) {
            try {
              const parsed = JSON.parse(d.extraPorts) as Array<{
                container: number;
                host: number;
                protocol: string;
              }>;
              extraPortsConfig = parsed.map((p) => ({
                container: p.container,
                protocol: p.protocol,
              }));
            } catch {
              // ignore parse errors
            }
          }
          const { id, containerName, extraPorts } = await recreateContainer(
            name,
            d.port,
            volumeDir,
            d.directory,
            envVarsToUse,
            memLimit,
            customVolumes,
            gpuFlag,
            extraPortsConfig,
            privilegedDockerFlag,
          );
          const extraPortsJson = extraPorts.length > 0 ? JSON.stringify(extraPorts) : null;
          saveDeployment({
            name,
            type: d.type || undefined,
            username: d.username,
            port: d.port,
            containerId: id,
            containerName,
            directory: d.directory || undefined,
            extraPorts: extraPortsJson,
          });
          const action =
            body.gpuEnabled !== undefined
              ? 'gpu-update'
              : body.privilegedDocker !== undefined
                ? 'privileged-docker-update'
                : body.volumes !== undefined
                  ? 'volumes-update'
                  : 'env-update';
          addDeployEvent(name, { action, username: auth.username, source: 'ui' });
          emit({
            type: 'deployment:status',
            deploymentName: name,
            data: { status: 'running', username: auth.username, source: 'recreate' },
          });
        }

        return json(res, { message: 'Settings updated' });
      }

      const logsMatch = path.match(/^\/api\/deployments\/([^/]+)\/logs$/);

      if (logsMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = logsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        let target: ReturnType<typeof resolveApplicationInstanceTarget>;
        try {
          target = resolveApplicationInstanceTarget(name, {
            siteId: url.searchParams.get('siteId') || undefined,
            component: url.searchParams.get('component') || undefined,
            instanceId: url.searchParams.get('instanceId') || undefined,
          });
        } catch (targetError) {
          return error(res, (targetError as Error).message, 404);
        }
        const requestedTail = url.searchParams.get('tail');
        const tail = requestedTail ? Number(requestedTail) : 1000;
        if (!Number.isSafeInteger(tail) || tail < 1 || tail > 50_000) {
          return error(res, 'tail must be an integer between 1 and 50000', 400);
        }

        if (target.nodeId !== 'coordinator') {
          try {
            const result = await dispatchAgentCommand(target.nodeId, 'logs', name, {
              tail,
              containerName: target.containerName,
            });
            res.writeHead(200, {
              'Content-Type': 'text/plain',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(String(result.logs || ''));
          } catch (err) {
            return error(res, (err as Error).message, 502);
          }
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Transfer-Encoding': 'chunked',
          'Access-Control-Allow-Origin': '*',
          // Long-lived stream: tells the edge's forwarding proxy to disable
          // gzip buffering and its idle timeout for this response.
          'X-Accel-Buffering': 'no',
        });

        const proc = streamContainerLogs(target.containerName, tail);
        proc.stdout!.pipe(res);
        proc.stderr!.pipe(res);
        proc.on('close', () => res.end());
        req.on('close', () => proc.kill());
        return;
      }
      return false;
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
  })();
  return result !== false;
}
