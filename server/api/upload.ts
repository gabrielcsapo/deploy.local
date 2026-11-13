import { dispatch, routes } from '../routes.ts';
import {
  requireAuth,
  json,
  error,
  MIGRATION_STATES,
  CONFIGURATION_REQUIRED_STATUS,
  dispatchAgentCommand,
  reportMigrationProgress,
  agentJobsWithStreamedBuildOutput,
  waitForRemotePort,
} from './shared.ts';
import {
  ownerCiRelease,
  ciReceipt,
  assertCiOwnerStopped,
  ciBootId,
  ciError,
  resolveOwnerCiRelease,
  issueCiCredential,
  revokeCiCredential,
  type CiRelease,
  authenticateCi,
  ciHead,
  existingCiIntent,
  ciTarget,
  reserveCiRelease,
  ciRelease,
  finishCiRelease,
  claimCiUpload,
  assertCiUploadCurrent,
  assertNoCiRelease,
  recordCiBuild,
} from '../ci-releases.ts';
import {
  getDeployAdmissionState,
  type DeployLease,
  acquireDeploySlot,
} from '../deploy-admission.ts';
import { withCiMutation, withApplicationMutation } from '../ci-fence.ts';
import {
  updateDeploymentStatus,
  getUploadsDir,
  getDeployment,
  getFleetPlacementState,
  assertDeployRole,
  getApplicationSpecRevision,
  readDeploymentRecord,
  updateDeploymentArtifactDigests,
  isAdmin,
  saveDesiredApplicationSpec,
  registerDeploymentStart,
  updateDeploymentSourceDirectory,
  createBuildLog,
  updateCurrentBuildLogId,
  buildLogFilePath,
  completeBuildLog,
  getNode,
  getDeploymentEnvVars,
  saveBackup,
  enqueueAgentJob,
  getDeploymentVolumes,
  getAgentJob,
  saveDeployment,
  recordContainerStart,
  activateDesiredApplicationSpec,
  addDeployEvent,
  getAllDeployments,
  updateDeploymentSettings,
  saveRuntimeLogs,
} from '../store.ts';
import { readBody, RequestBodyTooLargeError } from '../http.ts';
import {
  consumeAgentUpload,
  assertRepositoryOwner,
  assertAgentApplication,
  recordApplicationOrigin,
  recordAgentUpload,
  finishAgentUpload,
} from '../agent-upload.ts';
import { emit } from '../events.ts';
import {
  MAX_UPLOAD_ARCHIVE_BYTES,
  UploadArchiveError,
  inspectUploadArchive,
} from '../upload-archive.ts';
import { resolve, basename } from 'node:path';
import { planApplicationChange, emptyApplicationSpec } from '../application-plan.ts';
import Busboy from 'busboy';
import {
  createWriteStream,
  createReadStream,
  mkdirSync,
  readFileSync,
  existsSync,
  copyFileSync,
  readdirSync,
  appendFileSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { assertApplicationReleaseIdle } from '../v2/releases.ts';
import { beginApplicationMutation } from '../v2/releases-fence.ts';
import { assertLegacyMutationAllowed } from '../legacy-docker-update.ts';
import { assertWanderLegacyAllowed } from '../wander-adoption-fence.ts';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { readDeploymentDefinition } from '../deploy-config.ts';
import { putArtifactFile } from '../content-store.ts';
import { type WanderIntent } from '../wander-adoption.ts';
import { legacyUpdateService } from '../legacy-update-service.ts';
import { assertNoImplicitLegacyGraphAdoption } from '../legacy-preserving-update.ts';
import { parseRepositoryBaseDigest, parseStoredApplicationSpec } from '../application-spec.ts';
import {
  admitRepositoryRevision,
  RepositoryRevisionConflictError,
  repositoryUploadCanSkipRuntime,
} from '../application-revision.ts';

import { registerApplicationIdentity } from '../local-site.ts';
import {
  classifyProject,
  ensureDockerfile,
  containerExists,
  removeContainer,
  buildImage,
  captureContainerLogsAsync,
  getAvailablePort,
  validateVolumeMounts,
  renameContainerByName,
  runContainer,
  healthCheckPort,
  removeContainerByName,
  stopContainerByName,
  prunePreviousContainers,
} from '../docker.ts';
import {
  carryForwardCompatibleConfiguration,
  resolveApplicationConfiguration,
} from '../application-configuration.ts';
import { shipUploadedProject } from '../v2/releases-upload.ts';
import {
  type ResolvedApplicationGraphRuntime,
  buildApplicationGraphRuntime,
} from '../application-runtime.ts';
import { ApplicationGraphExecutor } from '../application-graph-executor.ts';
import { createBackup, getBackupDir, restoreBackup, getVolumeDir } from '../volumes.ts';
import { createAgentGraphPayload } from '../agent-graph-payload.ts';
import { applicationWriterSiteId } from '../application-authority.ts';
import { recordAgentGraphMaterialization } from '../agent-graph-recording.ts';
import { type AgentGraphExecutionResult } from '../agent-graph-runtime.ts';

import { ensureCertCoversHost } from '../certs.ts';
import { notifyCertReload } from '../ipc.ts';
import { inspectContainer } from '../docker-api.ts';
import { type ApiRouteContext } from './context.ts';

const DEPLOYMENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

const MAX_UPLOAD_MULTIPART_OVERHEAD = 1024 * 1024;

const configuredArtifactRetention = Number(process.env.DEPLOY_SOURCE_ARTIFACT_RETENTION);

const SOURCE_ARTIFACT_RETENTION =
  Number.isSafeInteger(configuredArtifactRetention) && configuredArtifactRetention > 0
    ? configuredArtifactRetention
    : 5;

function uploadByteLimitLabel() {
  if (MAX_UPLOAD_ARCHIVE_BYTES >= 1024 * 1024) {
    return `${Math.floor(MAX_UPLOAD_ARCHIVE_BYTES / 1024 ** 2)} MiB`;
  }
  return `${MAX_UPLOAD_ARCHIVE_BYTES.toLocaleString('en-US')} bytes`;
}

const MIGRATION_TIMEOUT_MS = 30 * 60 * 1000;

function deploymentErrorStatus(errorValue: unknown): string {
  const value = errorValue as { deploymentStatus?: unknown };
  return typeof value?.deploymentStatus === 'string' ? value.deploymentStatus : 'failed';
}

async function verifiedCiRuntime(application: string, username: string, allowFailed = false) {
  const d = getDeployment(application);
  if (
    !d ||
    d.username !== username ||
    !d.containerId ||
    !d.activeSpecDigest ||
    d.activeSpecDigest !== d.desiredSpecDigest ||
    !d.port ||
    !d.sourceArtifactDigest ||
    (!allowFailed && d.status !== 'running')
  )
    ciError('Runtime is not an active release');
  const revision = getApplicationSpecRevision(application, d.activeSpecDigest);
  if (!revision) ciError('Graph unavailable');
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const components = Object.values(spec.components);
  if (components.length !== 1 || !components[0].health) ciError('Declared health gate required');
  const health = components[0].health;
  const port = components[0].interfaces[health.interface]?.port;
  const info = await inspectContainer(d.containerId);
  if (
    !info ||
    info.State.Status !== 'running' ||
    !/^sha256:[a-f0-9]{64}$/.test(info.Image) ||
    !info.NetworkSettings.Ports[port + '/tcp']?.some((p) => Number(p.HostPort) === d.port)
  )
    ciError('Container identity or port mismatch');
  const response = await fetch('http://127.0.0.1:' + d.port + (health.path || '/'), {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  if (!response.ok) ciError('Runtime failed HTTP health');
  const current = getDeployment(application);
  if (
    current?.containerId !== d.containerId ||
    current.activeSpecDigest !== d.activeSpecDigest ||
    current.desiredSpecDigest !== d.desiredSpecDigest ||
    current.sourceArtifactDigest !== d.sourceArtifactDigest
  )
    ciError('Runtime changed during health verification');
  return { containerId: info.Id, imageDigest: info.Image, sourceDigest: d.sourceArtifactDigest };
}

const ciRoute = routes<ApiRouteContext>();
const ciRoutes = [
  ...[
    '/api/ci/owner/releases/:id([a-f0-9-]+)',
    '/api/ci/owner/releases/:id([a-f0-9-]+)/:action(recover|cancel)',
  ].map((path) =>
    ciRoute({
      method: '*',
      path,
      handler: async ({ context: ctx }) => {
        const { req, res, path, method } = ctx;
        try {
          const ownerCiRoute = path.match(
            /^\/api\/ci\/owner\/releases\/([a-f0-9-]+)(?:\/(recover|cancel))?$/,
          );
          if (!ownerCiRoute) return false;

          const auth = requireAuth(req, res);
          if (!auth) return;
          const r = ownerCiRelease(ownerCiRoute[1], auth.username);
          res.setHeader('Cache-Control', 'no-store');
          return await dispatch(
            [
              ciRoute({
                method: 'GET',
                path: '/api/ci/owner/releases/:id([a-f0-9-]+)',
                handler: () => json(res, ciReceipt(r)),
              }),
              ciRoute({
                method: 'POST',
                path: '/api/ci/owner/releases/:id([a-f0-9-]+)/:action(recover|cancel)',
                handler: async () => {
                  if (['healthy', 'cancelled'].includes(r.status)) return json(res, ciReceipt(r));
                  assertCiOwnerStopped(r);
                  if (
                    getDeployAdmissionState().activeDeployments.includes(r.application) ||
                    (r.boot_id === ciBootId && !['accepted', 'failed'].includes(r.status))
                  )
                    ciError('Current process owns release; wait for completion');
                  const runtime = await verifiedCiRuntime(r.application, auth.username, true);
                  return await withCiMutation(r.id, async () => {
                    if (ownerCiRoute[2] === 'cancel') {
                      if (
                        !['accepted', 'failed'].includes(r.status) ||
                        runtime.sourceDigest !== r.baseline_source
                      )
                        ciError('Only an unstarted release can be cancelled');
                      return json(
                        res,
                        ciReceipt(resolveOwnerCiRelease(r, auth.username, 'cancelled', runtime)),
                      );
                    }
                    const healthy =
                      runtime.containerId !== r.baseline_container &&
                      runtime.sourceDigest === r.source_digest;
                    if (!healthy && runtime.containerId !== r.baseline_container)
                      ciError('Interrupted runtime requires owner investigation');
                    const result = resolveOwnerCiRelease(
                      r,
                      auth.username,
                      healthy ? 'healthy' : 'accepted',
                      runtime,
                    );
                    if (!healthy) updateDeploymentStatus(r.application, 'running');
                    return json(res, ciReceipt(result));
                  });
                },
              }),
            ],
            {
              path: () => path,
              method: () => method,
              notFound: () => error(res, 'Route not found', 404),
            },
          )(req, res, ctx);
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
  ),
  ...['/api/ci/credentials', '/api/ci/credentials/:id([a-f0-9-]+)'].map((path) =>
    ciRoute({
      method: '*',
      path,
      handler: async ({ context: ctx }) => {
        const { req, res, path, method } = ctx;
        try {
          const ciCredentialRoute = path.match(/^\/api\/ci\/credentials(?:\/([a-f0-9-]+))?$/);
          if (!ciCredentialRoute) return false;

          const auth = requireAuth(req, res);
          if (!auth) return;
          res.setHeader('Cache-Control', 'no-store');
          return await dispatch(
            [
              ciRoute({
                method: 'POST',
                path: '/api/ci/credentials',
                handler: async () => {
                  const body = JSON.parse((await readBody(req)).toString());
                  return json(
                    res,
                    issueCiCredential(auth.username, body.application, body.ttlSeconds),
                    201,
                  );
                },
              }),
              ciRoute({
                method: 'DELETE',
                path: '/api/ci/credentials/:id([a-f0-9-]+)',
                handler: () => {
                  revokeCiCredential(ciCredentialRoute[1], auth.username);
                  return json(res, { revoked: true });
                },
              }),
            ],
            {
              path: () => path,
              method: () => method,
              notFound: () => error(res, 'Route not found', 404),
            },
          )(req, res, ctx);
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
  ),
];

export async function uploadRoutes(ctx: ApiRouteContext): Promise<boolean> {
  if (
    await dispatch(ciRoutes, { path: () => ctx.path, method: () => ctx.method })(
      ctx.req,
      ctx.res,
      ctx,
    )
  )
    return true;

  const { req, res, path, method, makeLegacyUpdate, makeWanderAdoption } = ctx;
  // Keep the original return boundary: returned promises bypass the catch,
  // while thrown errors and rejected awaits use the existing API error response.
  const result = await (async () => {
    try {
      // ── Upload / Deploy ─────────────────────────────────────────────────

      const ciRoute = path.match(/^\/api\/ci\/releases(?:\/(head|[a-f0-9-]+)(?:\/(upload))?)?$/);

      let ciUpload: CiRelease | undefined;
      const uploadRoute = routes<undefined>();

      // Admission may set ciUpload without answering; false continues into multipart handling.
      if (ciRoute) {
        const credential = authenticateCi(req.headers['x-deploy-ci-token']);
        res.setHeader('Cache-Control', 'no-store');
        if (
          await dispatch(
            [
              ...['/api/ci/releases/head', '/api/ci/releases/head/upload'].map((pattern) =>
                uploadRoute({
                  method: 'GET',
                  path: pattern,
                  handler: () => json(res, ciHead(credential)),
                }),
              ),
              uploadRoute({
                method: 'POST',
                path: '/api/ci/releases',
                handler: async () => {
                  const body = JSON.parse((await readBody(req)).toString());
                  const prior = existingCiIntent(credential, body);
                  if (prior) return json(res, ciReceipt(prior), 202);
                  ciTarget(credential.application, credential.username);
                  const runtime = await verifiedCiRuntime(
                    credential.application,
                    credential.username,
                  );
                  return json(res, ciReceipt(reserveCiRelease(credential, body, runtime)), 202);
                },
              }),
              uploadRoute({
                method: 'GET',
                path: '/api/ci/releases/:id([a-f0-9-]+)',
                handler: () => json(res, ciReceipt(ciRelease(ciRoute[1], credential))),
              }),
              uploadRoute({
                method: 'POST',
                path: '/api/ci/releases/:id([a-f0-9-]+)/upload',
                handler: () => {
                  ciUpload = ciRelease(ciRoute[1], credential);
                  return false;
                },
              }),
              uploadRoute({
                method: '*',
                path: '/api/ci/releases/:rest*',
                handler: () => {
                  if (ciUpload || !ciRoute[1] || ciRoute[1] === 'head') return false;
                  return error(res, 'Route not found', 404);
                },
              }),
            ],
            { path: () => path, method: () => method },
          )(req, res, undefined)
        )
          return;
      }

      const adoptionUpload = path === '/api/deployments/wander/managed-adoption/upload';
      const multipartUpload = async () => {
        return await withCiMutation(ciUpload?.id, async () => {
          const agentUpload = path === '/api/upload' ? consumeAgentUpload(req) : undefined;
          const auth = agentUpload
            ? { username: agentUpload.owner }
            : ciUpload
              ? { username: ciUpload.username }
              : requireAuth(req, res);
          if (!auth) return;
          if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
            return error(res, 'Only a signed-in person can start a release', 403);
          const { username } = auth;
          const repositoryProjectId = req.headers['x-deploy-project-id'];
          if (repositoryProjectId !== undefined) {
            if (agentUpload || ciUpload || typeof repositoryProjectId !== 'string')
              return error(
                res,
                'Repository association requires an authenticated manual upload',
                403,
              );
            assertRepositoryOwner(username, repositoryProjectId);
          }
          const uploadEvent = (value: Parameters<typeof emit>[0]) =>
            emit({
              ...value,
              data: {
                ...value.data,
                ...(agentUpload
                  ? {
                      taskId: agentUpload.taskId,
                      trigger: `Triggered by ${username} via ${agentUpload.pipelineId ? `pipeline ${agentUpload.pipelineId}` : `task ${agentUpload.taskTitle}`}`,
                    }
                  : {}),
              },
            });
          if (adoptionUpload) makeWanderAdoption(username); // Owner/admin authorization before staging bytes.
          const failCi = () => {
            if (ciUpload) finishCiRelease(ciUpload.id, null);
          };

          // Stream the multipart body to a temp file on disk, then once parsing
          // is complete and we have both `name` and the file part, untar the
          // temp file into the deployment directory in a single deterministic
          // step.
          //
          // The previous implementation tried to pipe file bytes straight into
          // a `tar -xz` subprocess as they arrived, deferring "ready to extract"
          // until both name and file had been seen. That raced badly: depending
          // on field/file arrival order, `ensureExtractor` could be invoked from
          // both the `field` handler and the `close` handler while the first
          // call was still awaiting `rm(...)`, spawning two tar processes; and
          // `stdin.end()` was reachable only from one branch, so trailing
          // buffered bytes sometimes got dropped when tar exited on archive EOF
          // markers. Buffering to a temp file avoids OOM (no in-memory buffer
          // of a 500 MB upload) and removes the race entirely.
          const contentType = req.headers['content-type'] || '';
          if (!contentType.startsWith('multipart/form-data')) {
            return error(res, 'Expected multipart/form-data');
          }
          const declaredUploadBytes = Number(req.headers['content-length']);
          if (
            Number.isFinite(declaredUploadBytes) &&
            declaredUploadBytes > MAX_UPLOAD_ARCHIVE_BYTES + MAX_UPLOAD_MULTIPART_OVERHEAD
          ) {
            return error(res, `Deployment archive exceeds ${uploadByteLimitLabel()}`, 413);
          }

          const fields: Record<string, string> = Object.create(null);
          if (ciUpload)
            ciUpload = claimCiUpload(ciUpload.id, authenticateCi(req.headers['x-deploy-ci-token']));
          const uploadsDir = getUploadsDir();
          const tmpFile = resolve(
            uploadsDir,
            `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`,
          );
          let deployDir: string | null = null;
          let fileFinished: Promise<void> | null = null;
          let sawFile = false;
          let deployLease: DeployLease | null = null;
          let releaseProjectMutation: (() => unknown) | undefined;
          let artifactPath: string | null = null;
          let uploadedSourceArtifactDigest: string | null = null;
          let releaseBaselineStatus: string | null = null;
          // The stored status this upload replaces with "uploading", for an upload that changes nothing.
          let statusBeforeUpload: string | null = null;
          let uploadLimitError: UploadArchiveError | null = null;
          let clientAborted = false;
          let legacyResult: Record<string, unknown> | null = null;
          let adoptionResult: Record<string, unknown> | null = null;
          let repositoryRevisionUnchanged = false;
          let repositoryRuntimeCanBeSkipped = false;
          let repositorySourceChanged = false;
          let repositoryRetryAfterFailure = false;
          let repositoryChangePlan: ReturnType<typeof planApplicationChange> | null = null;
          req.once('aborted', () => {
            clientAborted = true;
          });

          try {
            await new Promise<void>((resolveP, rejectP) => {
              const bb = Busboy({
                headers: req.headers as Record<string, string>,
                limits: {
                  fileSize: MAX_UPLOAD_ARCHIVE_BYTES,
                  files: 1,
                  fields: 16,
                  fieldSize: 16 * 1024,
                  parts: 17,
                },
              });

              const recordUploadLimit = (message: string) => {
                uploadLimitError ??= new UploadArchiveError(message, 413);
              };

              bb.on('field', (fieldname, val, info) => {
                if (info.nameTruncated || info.valueTruncated) {
                  recordUploadLimit('Deployment upload contains an oversized form field');
                  return;
                }
                fields[fieldname] = val;
              });

              bb.on('file', (_fieldname, fileStream) => {
                sawFile = true;
                fileStream.on('limit', () => {
                  recordUploadLimit(`Deployment archive exceeds ${uploadByteLimitLabel()}`);
                });
                const out = createWriteStream(tmpFile, { highWaterMark: 256 * 1024 });
                fileFinished = new Promise<void>((done, fail) => {
                  out.on('finish', () => done());
                  out.on('error', fail);
                  fileStream.on('error', fail);
                });
                fileStream.pipe(out);
              });
              bb.on('filesLimit', () =>
                recordUploadLimit('Only one deployment archive is allowed'),
              );
              bb.on('fieldsLimit', () =>
                recordUploadLimit('Deployment upload contains too many form fields'),
              );
              bb.on('partsLimit', () =>
                recordUploadLimit('Deployment upload contains too many multipart sections'),
              );

              const onClose = async () => {
                const withAdoptionOrApplicationMutation = adoptionUpload
                  ? async (_name: string, fn: () => Promise<void>) => fn()
                  : withApplicationMutation;
                return await withAdoptionOrApplicationMutation(
                  (fields.name || '').toLowerCase(),
                  async () => {
                    // Wait for accepted bytes to flush before inspecting or removing the
                    // bounded temporary file.
                    if (fileFinished) await fileFinished;
                    if (uploadLimitError) throw uploadLimitError;
                    if (!sawFile) throw new Error('No file uploaded');
                    if (!fields.name) throw new Error('Missing deployment name');

                    const name = fields.name.toLowerCase();
                    if (agentUpload) {
                      if (
                        name !== agentUpload.application ||
                        fields.detached !== '1' ||
                        Object.keys(fields).some(
                          (key) => !['name', 'detached', 'expectedParentDigest'].includes(key),
                        )
                      )
                        throw Object.assign(
                          new Error(
                            'Internal upload is scoped to one application without confirmations',
                          ),
                          { status: 403 },
                        );
                      assertAgentApplication(agentUpload);
                    }

                    if (!DEPLOYMENT_NAME_PATTERN.test(name)) {
                      throw Object.assign(
                        new Error(
                          'Deployment name must start with a letter and contain only lowercase letters, numbers, or hyphens (maximum 63 characters).',
                        ),
                        { status: 400 },
                      );
                    }
                    if (ciUpload) {
                      if (
                        name !== ciUpload.application ||
                        fields.detached !== '1' ||
                        Object.keys(fields).some((k) => !['name', 'detached'].includes(k))
                      )
                        ciError('CI upload may only update its admitted application source', 403);
                      assertCiUploadCurrent(ciUpload);
                      const digest = createHash('sha256');
                      for await (const chunk of createReadStream(tmpFile)) digest.update(chunk);
                      if ('sha256:' + digest.digest('hex') !== ciUpload.source_digest)
                        ciError('Source archive digest mismatch', 400);
                      const archiveHash = createHash('sha256');
                      let inflated = 0;
                      const unzip = createReadStream(tmpFile).pipe(createGunzip());
                      for await (const chunk of unzip) {
                        inflated += chunk.length;
                        if (inflated > MAX_UPLOAD_ARCHIVE_BYTES) {
                          unzip.destroy();
                          ciError('Expanded source exceeds limit', 413);
                        }
                        archiveHash.update(chunk);
                      }
                      if ('sha256:' + archiveHash.digest('hex') !== ciUpload.source_archive_digest)
                        ciError('Tested source archive digest mismatch', 400);
                    }
                    assertNoCiRelease(name, ciUpload?.id);
                    assertApplicationReleaseIdle(username, name);
                    const existingDeployment = getDeployment(name);
                    releaseBaselineStatus = existingDeployment?.status || null;
                    if (existingDeployment && existingDeployment.username !== username) {
                      throw Object.assign(new Error('Deployment name is already in use'), {
                        status: 409,
                      });
                    }

                    const uploadPlacement = getFleetPlacementState();
                    const uploadTarget =
                      existingDeployment?.desiredNodeId || uploadPlacement.defaultNodeId;
                    if (uploadTarget) assertDeployRole(uploadTarget);
                    if (!uploadPlacement.ready) {
                      throw Object.assign(
                        new Error(
                          'Choose a default deployment computer in Computers before deploying.',
                        ),
                        { status: 428 },
                      );
                    }

                    if (
                      existingDeployment?.status &&
                      MIGRATION_STATES.has(existingDeployment.status)
                    ) {
                      throw Object.assign(
                        new Error(
                          `Migration in progress for ${name}. Wait for it to finish before deploying again.`,
                        ),
                        { status: 409 },
                      );
                    }

                    await inspectUploadArchive(tmpFile);
                    if (!adoptionUpload)
                      deployLease = await acquireDeploySlot(name, username, (position) => {
                        if (position > 0) {
                          uploadEvent({
                            type: 'deployment:queued',
                            deploymentName: name,
                            data: { position, username },
                          });
                        }
                      });
                    if (clientAborted) {
                      deployLease?.release();
                      deployLease = null;
                      throw new Error('Upload cancelled while waiting for a build slot');
                    }
                    assertNoCiRelease(name, ciUpload?.id);
                    assertApplicationReleaseIdle(username, name);
                    if (deployLease) {
                      const lease = deployLease;
                      const releaseMutation = beginApplicationMutation(username, name);
                      releaseProjectMutation = releaseMutation;
                      deployLease = {
                        release: () => {
                          releaseMutation();
                          lease.release();
                        },
                      };
                    }
                    if (ciUpload) assertCiUploadCurrent(ciUpload);
                    if (agentUpload) assertAgentApplication(agentUpload);
                    if (!adoptionUpload && fields.legacyCodeUpdate !== '1') {
                      assertLegacyMutationAllowed(name);
                      if (!getDeployment(name)?.activeSpecDigest) assertWanderLegacyAllowed(name);
                    }
                    const finalDeployDir = resolve(uploadsDir, name);
                    const stagingDir = await mkdtemp(resolve(uploadsDir, '.extract-'));
                    const displacedDir = resolve(
                      uploadsDir,
                      `.previous-${name}-${basename(stagingDir)}`,
                    );

                    try {
                      await new Promise<void>((done, fail) => {
                        const proc = spawn('tar', ['-xzf', tmpFile], {
                          cwd: stagingDir,
                          stdio: ['ignore', 'pipe', 'pipe'],
                        });
                        let stderr = '';
                        proc.stderr.on('data', (chunk: Buffer) => {
                          if (stderr.length < 16 * 1024) stderr += chunk.toString();
                        });
                        proc.on('close', (code) => {
                          if (code === 0) done();
                          else
                            fail(
                              new UploadArchiveError(
                                `Unable to extract deployment archive${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
                              ),
                            );
                        });
                        proc.on('error', fail);
                      });

                      const stagedDefinition = readDeploymentDefinition(stagingDir);
                      if (adoptionUpload) {
                        const keys = [
                          'applicationId',
                          'expectedContainer',
                          'expectedImage',
                          'expectedRuntimeSettings',
                          'expectedSource',
                          'expectedParent',
                          'sourceCommit',
                          'sourceDigest',
                          'sourceArchiveDigest',
                          'requestKey',
                          'specDigest',
                        ] as const;
                        if (
                          name !== 'wander' ||
                          fields.confirmDowntime !== '1' ||
                          Object.keys(fields).some(
                            (k) => !['name', 'confirmDowntime', ...keys].includes(k),
                          ) ||
                          keys.some((k) => !fields[k])
                        )
                          throw Object.assign(
                            new Error(
                              'Exact adoption intent and downtime acknowledgement required',
                            ),
                            { status: 400 },
                          );
                        const hash = createHash('sha256');
                        for await (const chunk of createReadStream(tmpFile)) hash.update(chunk);
                        if ('sha256:' + hash.digest('hex') !== fields.sourceDigest)
                          throw new UploadArchiveError('Adoption source digest mismatch');
                        const archiveHash = createHash('sha256');
                        let inflated = 0;
                        const unzip = createReadStream(tmpFile).pipe(createGunzip());
                        for await (const chunk of unzip) {
                          inflated += chunk.length;
                          if (inflated > MAX_UPLOAD_ARCHIVE_BYTES) {
                            unzip.destroy();
                            throw new UploadArchiveError('Expanded adoption source exceeds limit');
                          }
                          archiveHash.update(chunk);
                        }
                        if ('sha256:' + archiveHash.digest('hex') !== fields.sourceArchiveDigest)
                          throw new UploadArchiveError('Adoption archive digest mismatch');
                        const retained = await putArtifactFile(tmpFile, {
                          type: 'application-source',
                          mediaType: 'application/gzip',
                          retentionClass: 'release',
                        });
                        if (retained.digest !== fields.sourceDigest)
                          throw new UploadArchiveError('Retained adoption source digest mismatch');
                        const intent = Object.fromEntries(
                          keys.map((k) => [k, fields[k]]),
                        ) as unknown as WanderIntent;
                        adoptionResult = await makeWanderAdoption(username).adopt({
                          ...intent,
                          sourceDirectory: stagingDir,
                        });
                        return;
                      }
                      if (fields.legacyCodeUpdate === '1') {
                        if (name !== 'groffee' || fields.confirmDowntime !== '1')
                          throw Object.assign(
                            new Error(
                              'Legacy update requires Groffee and explicit downtime acknowledgement',
                            ),
                            { status: 409 },
                          );
                        const current = getDeployment(name);
                        if (
                          !current ||
                          fields.legacyExpectedContainerId !== current.containerId ||
                          fields.legacyExpectedDesiredDigest !==
                            (current.desiredSpecDigest || 'none')
                        )
                          throw Object.assign(
                            new Error('Legacy preflight state changed; repeat preflight'),
                            { status: 409 },
                          );
                        if (
                          stagedDefinition.compiled.spec.metadata.name !== name ||
                          Object.keys(stagedDefinition.compiled.spec.components).length !== 1 ||
                          !stagedDefinition.compiled.spec.components.web?.build
                        )
                          throw new Error(
                            'Legacy code update requires a validated single web-component Groffee manifest',
                          );
                        legacyUpdateService(name, username); // authorize host control before retaining source
                        const componentBuild = stagedDefinition.compiled.spec.components.web.build!;
                        if (
                          componentBuild.context !== '.' ||
                          (componentBuild.dockerfile &&
                            componentBuild.dockerfile !== 'Dockerfile') ||
                          componentBuild.target
                        )
                          throw new Error(
                            'Legacy code update supports only the existing root Dockerfile build',
                          );
                        const source = await putArtifactFile(tmpFile, {
                          type: 'application-source',
                          mediaType: 'application/gzip',
                          retentionClass: 'release',
                        });
                        const releaseRoot = resolve(uploadsDir, '..', 'legacy-releases', name);
                        mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
                        const releaseDirectory = resolve(releaseRoot, basename(stagingDir));
                        await rename(stagingDir, releaseDirectory);
                        const service = makeLegacyUpdate(
                          name,
                          username,
                          releaseDirectory,
                          source.digest,
                          {
                            noCache: fields.noCache === '1' || fields.noCache === 'true',
                            projectId: repositoryProjectId,
                          },
                        );
                        legacyResult = {
                          name,
                          legacyCodeUpdate: true,
                          ...(await service.update()),
                        };
                        return;
                      }
                      if (fields.legacyCodeUpdate) throw new Error('Invalid legacy update mode');

                      if (
                        ciUpload &&
                        (stagedDefinition.format !== 'deploy.yaml' ||
                          stagedDefinition.compiled.digest !== ciUpload.spec_digest)
                      )
                        ciError(
                          'Scoped CI cannot change infrastructure or adopt legacy storage',
                          403,
                        );
                      if (stagedDefinition.format === 'deploy.yaml') {
                        if (existingDeployment) {
                          assertNoImplicitLegacyGraphAdoption({
                            name,
                            containerName: existingDeployment.containerName,
                            activeSpecDigest: existingDeployment.activeSpecDigest,
                          });
                        }

                        const manifestSource = readFileSync(
                          resolve(stagingDir, 'deploy.yaml'),
                          'utf8',
                        );
                        const directiveBase = parseRepositoryBaseDigest(manifestSource);
                        const transportedBase = fields.expectedParentDigest || null;
                        if (transportedBase && !/^sha256:[a-f0-9]{64}$/.test(transportedBase)) {
                          throw Object.assign(new Error('Repository base digest is invalid'), {
                            status: 400,
                          });
                        }
                        if (directiveBase && transportedBase && directiveBase !== transportedBase) {
                          throw Object.assign(
                            new Error('Repository base digest does not match deploy.yaml'),
                            { status: 400 },
                          );
                        }
                        const currentDigest =
                          existingDeployment?.desiredSpecDigest ||
                          existingDeployment?.activeSpecDigest ||
                          null;
                        try {
                          const admission = admitRepositoryRevision({
                            currentDigest,
                            candidateDigest: stagedDefinition.compiled.digest,
                            declaredBaseDigest: directiveBase || transportedBase,
                            resolution: fields.revisionResolution,
                          });
                          repositoryRevisionUnchanged = admission.unchanged;
                        } catch (revisionError) {
                          if (revisionError instanceof RepositoryRevisionConflictError) {
                            throw Object.assign(revisionError, { status: 409 });
                          }
                          throw revisionError;
                        }

                        const currentRevisionDigest =
                          existingDeployment?.desiredSpecDigest ||
                          existingDeployment?.activeSpecDigest ||
                          null;
                        const currentRevision = currentRevisionDigest
                          ? getApplicationSpecRevision(name, currentRevisionDigest)
                          : null;
                        const currentSpec = currentRevision
                          ? parseStoredApplicationSpec(currentRevision.normalizedSpec)
                          : emptyApplicationSpec(name);
                        repositoryChangePlan = planApplicationChange(
                          currentSpec,
                          stagedDefinition.compiled.spec,
                          { source: 'repository' },
                        );
                        if (repositoryChangePlan.blocked) {
                          throw Object.assign(
                            new Error('Repository application change plan is blocked'),
                            {
                              status: 409,
                            },
                          );
                        }
                        if (
                          repositoryChangePlan.destructive &&
                          fields.confirmDestructive !== '1' &&
                          fields.confirmDestructive !== 'true'
                        ) {
                          throw Object.assign(
                            new Error(
                              'Destructive repository application changes require --confirm-destructive',
                            ),
                            { status: 409 },
                          );
                        }
                      }

                      if (existsSync(finalDeployDir)) await rename(finalDeployDir, displacedDir);
                      try {
                        await rename(stagingDir, finalDeployDir);
                      } catch (swapError) {
                        if (existsSync(displacedDir)) {
                          await rename(displacedDir, finalDeployDir).catch(() => {});
                        }
                        throw swapError;
                      }
                      deployDir = finalDeployDir;
                      if (existsSync(displacedDir)) {
                        await rm(displacedDir, { recursive: true, force: true }).catch(
                          (cleanupError) =>
                            console.warn(
                              `Unable to remove previous source directory for ${name}:`,
                              cleanupError,
                            ),
                        );
                      }
                    } finally {
                      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
                    }

                    // The coordinator retains the exact source artifact so a later
                    // node move never depends on the previous execution host.
                    const artifactDir = resolve(uploadsDir, '..', 'artifacts', name);
                    mkdirSync(artifactDir, { recursive: true });
                    artifactPath = resolve(artifactDir, `${Date.now()}.tar.gz`);
                    copyFileSync(tmpFile, artifactPath);
                    const sourceArtifact = await putArtifactFile(artifactPath, {
                      type: 'application-source',
                      mediaType: 'application/gzip',
                      retentionClass: 'release',
                    });
                    uploadedSourceArtifactDigest = sourceArtifact.digest;
                    statusBeforeUpload = readDeploymentRecord(name)?.status ?? null;
                    updateDeploymentStatus(name, 'uploading');
                    repositorySourceChanged = Boolean(
                      existingDeployment?.sourceArtifactDigest &&
                      existingDeployment.sourceArtifactDigest !== sourceArtifact.digest,
                    );
                    repositoryRetryAfterFailure = existingDeployment?.status === 'failed';
                    repositoryRuntimeCanBeSkipped = repositoryUploadCanSkipRuntime({
                      revisionUnchanged: repositoryRevisionUnchanged,
                      forceBuild: !!ciUpload || fields.noCache === '1' || fields.noCache === 'true',
                      runtimeReady: existingDeployment?.status === 'running',
                      desiredDigest: existingDeployment?.desiredSpecDigest || null,
                      activeDigest: existingDeployment?.activeSpecDigest || null,
                      previousSourceArtifactDigest:
                        existingDeployment?.sourceArtifactDigest || null,
                      nextSourceArtifactDigest: sourceArtifact.digest,
                    });
                    updateDeploymentArtifactDigests(name, {
                      sourceArtifactDigest: sourceArtifact.digest,
                    });
                    const retainedArtifacts = readdirSync(artifactDir)
                      .filter((filename) => /^\d+\.tar\.gz$/.test(filename))
                      .sort(
                        (left, right) => Number(right.slice(0, -7)) - Number(left.slice(0, -7)),
                      );
                    for (const expiredArtifact of retainedArtifacts.slice(
                      SOURCE_ARTIFACT_RETENTION,
                    )) {
                      await rm(resolve(artifactDir, expiredArtifact), {
                        force: true,
                      }).catch((cleanupError) =>
                        console.warn(
                          `Unable to prune retained source artifact for ${name}:`,
                          cleanupError,
                        ),
                      );
                    }
                  },
                );
              };
              bb.on('close', () => {
                withCiMutation(ciUpload?.id, () => onClose()).then(
                  () => resolveP(),
                  (err) => rejectP(err),
                );
              });

              bb.on('error', rejectP);
              req.pipe(bb);
            });
          } catch (uploadErr) {
            await rm(tmpFile, { force: true }).catch(() => {});
            (deployLease as DeployLease | null)?.release();
            failCi();

            if (uploadErr instanceof RepositoryRevisionConflictError) {
              return json(
                res,
                {
                  error: uploadErr.message,
                  currentDigest: uploadErr.currentDigest,
                  declaredBaseDigest: uploadErr.declaredBaseDigest,
                  choices: uploadErr.choices,
                },
                409,
              );
            }
            const typedUploadError = uploadErr as Error & { status?: number };
            return error(
              res,
              typedUploadError.message || 'Upload failed',
              typedUploadError.status || 400,
            );
          }
          await rm(tmpFile, { force: true }).catch(() => {});

          if (adoptionResult) return json(res, adoptionResult);
          if (legacyResult) {
            (deployLease as DeployLease | null)?.release();
            return json(res, legacyResult);
          }

          if (!deployDir) {
            (deployLease as DeployLease | null)?.release();
            return error(res, 'No file uploaded');
          }
          const deploymentDirectory = deployDir;

          const name = (fields.name || 'app').toLowerCase();

          let leaseReleased = false;
          const releaseDeployLease = () => {
            if (leaseReleased) return;
            leaseReleased = true;
            (deployLease as DeployLease | null)?.release();
            failCi();
          };
          const detached = fields.detached === '1' || fields.detached === 'true';
          if (!detached) {
            res.once('finish', releaseDeployLease);
            res.once('close', releaseDeployLease);
          }

          // Compile either the public deploy.yaml graph or the legacy/default
          // one-container declaration before touching runtime state.
          let deploymentDefinition;
          try {
            deploymentDefinition = readDeploymentDefinition(deploymentDirectory);
          } catch (err: any) {
            releaseDeployLease();
            return error(res, err.message);
          }
          const graphDeployment = deploymentDefinition.format === 'deploy.yaml';
          const deployConfig = deploymentDefinition.legacyRuntime?.deployConfig ?? {};
          const graphComponents = Object.values(deploymentDefinition.compiled.spec.components);
          const requiresHostControl = graphDeployment
            ? Boolean(
                graphComponents.some(
                  (component) =>
                    component.runtime.gpus ||
                    component.runtime.privilegedDocker ||
                    component.runtime.networks.length > 0,
                ) ||
                Object.values(deploymentDefinition.compiled.spec.resources).some(
                  (resource) => resource.source?.type === 'bind',
                ),
              )
            : Boolean(
                deployConfig.gpus ||
                deployConfig.privilegedDocker ||
                deployConfig.volumes?.length ||
                deployConfig.docker?.networks.length,
              );
          if (requiresHostControl && !isAdmin(username)) {
            releaseDeployLease();
            return error(
              res,
              'GPU, privileged Docker, host mounts, and Docker networks require an administrator',
              403,
            );
          }
          const declaredApplicationName = deploymentDefinition.compiled.spec.metadata.name;
          if (declaredApplicationName && declaredApplicationName !== name) {
            releaseDeployLease();
            return error(
              res,
              `deploy.yaml metadata.name is "${declaredApplicationName}", but this deployment is named "${name}"`,
            );
          }

          // Classify and build
          const type = graphDeployment ? 'application-graph' : classifyProject(deploymentDirectory);
          if (!type) {
            releaseDeployLease();
            return error(
              res,
              'Unknown project type. Need a Dockerfile, package.json, or index.html.',
            );
          }

          if (!graphDeployment) ensureDockerfile(deploymentDirectory, type);

          const previousDeployment = getDeployment(name);
          const previousSpecDigest =
            previousDeployment?.desiredSpecDigest || previousDeployment?.activeSpecDigest || null;
          const previousSpecRevision = previousSpecDigest
            ? getApplicationSpecRevision(name, previousSpecDigest)
            : null;

          if (graphDeployment && repositoryRuntimeCanBeSkipped && previousDeployment && !ciUpload) {
            saveDesiredApplicationSpec({
              digest: deploymentDefinition.compiled.digest,
              deploymentName: name,
              parentDigest: previousSpecDigest,
              apiVersion: deploymentDefinition.compiled.spec.apiVersion,
              source: 'repository',
              manifestFormat: 'deploy.yaml',
              normalizedSpec: deploymentDefinition.compiled.canonicalJson,
              originalSource: readFileSync(resolve(deploymentDirectory, 'deploy.yaml'), 'utf8'),
              createdBy: username,
            });
            if (repositoryProjectId && previousDeployment.currentBuildLogId)
              recordApplicationOrigin(
                { owner: username, application: name, projectId: repositoryProjectId },
                previousDeployment.currentBuildLogId,
              );
            // Nothing restarted, so the app is still what it was before the upload began.
            if (statusBeforeUpload) updateDeploymentStatus(name, statusBeforeUpload);
            releaseDeployLease();
            return json(res, {
              name,
              unchanged: true,
              sourceAligned: true,
              digest: deploymentDefinition.compiled.digest,
              message: 'Repository now matches the desired revision; runtime was not restarted',
              plan: repositoryChangePlan,
            });
          }

          // Register the deployment row up front so a brand-new app shows up in the
          // dashboard the moment it starts deploying (and stays visible as `failed`
          // if the build dies). For an existing app this only refreshes type — it
          // leaves the live container's port/id untouched so its route survives the
          // build. Without this, the `uploading`/`building` status updates below are
          // UPDATE-only no-ops for a never-deployed app and it stays invisible.
          const previousBuildLogId = previousDeployment?.currentBuildLogId ?? null;
          registerDeploymentStart(name, username, type);
          updateDeploymentSourceDirectory(name, deploymentDirectory);
          if (uploadedSourceArtifactDigest) {
            // New deployments did not have a row when the upload was retained.
            // Link it now so deferred activation and remote placement can recover it.
            updateDeploymentArtifactDigests(name, {
              sourceArtifactDigest: uploadedSourceArtifactDigest,
            });
          }
          const applicationId = registerApplicationIdentity(name);
          saveDesiredApplicationSpec({
            digest: deploymentDefinition.compiled.digest,
            deploymentName: name,
            parentDigest:
              previousDeployment?.desiredSpecDigest || previousDeployment?.activeSpecDigest || null,
            apiVersion: deploymentDefinition.compiled.spec.apiVersion,
            source: 'repository',
            manifestFormat: deploymentDefinition.format,
            normalizedSpec: deploymentDefinition.compiled.canonicalJson,
            ...(deploymentDefinition.source == null
              ? {}
              : { originalSource: deploymentDefinition.source }),
            createdBy: username,
          });
          if (previousSpecRevision) {
            carryForwardCompatibleConfiguration({
              deploymentName: name,
              fromSpec: parseStoredApplicationSpec(previousSpecRevision.normalizedSpec),
              fromDigest: previousSpecRevision.digest,
              toSpec: deploymentDefinition.compiled.spec,
              toDigest: deploymentDefinition.compiled.digest,
              updatedBy: username,
            });
          }
          const deployStartedAtMs = Date.now();
          const orchestrationBuildLogId = createBuildLog(name);
          updateCurrentBuildLogId(name, orchestrationBuildLogId);
          if (agentUpload) recordAgentUpload(agentUpload, orchestrationBuildLogId);
          if (ciUpload) recordCiBuild(ciUpload.id, orchestrationBuildLogId);
          if (repositoryProjectId)
            recordApplicationOrigin(
              { owner: username, application: name, projectId: repositoryProjectId },
              orchestrationBuildLogId,
            );
          const appendOrchestrationLog = (message: string) => {
            const timestamp = new Date().toISOString();
            appendFileSync(
              buildLogFilePath(orchestrationBuildLogId),
              `[${timestamp}] ${message}\n`,
            );
            uploadEvent({
              type: 'build:output',
              deploymentName: name,
              data: { line: message, timestamp },
            });
          };
          const ua = (req.headers['user-agent'] as string | undefined) || '';
          const deploySource: 'cli' | 'ui' = /Mozilla|Chrome|Safari|Firefox|Edg/i.test(ua)
            ? 'ui'
            : 'cli';

          // Emit uploading status
          updateDeploymentStatus(name, 'uploading');
          uploadEvent({
            type: 'deployment:status',
            deploymentName: name,
            data: { status: 'uploading', username },
          });
          appendOrchestrationLog('Source artifact accepted by the coordinator');
          if (agentUpload)
            appendOrchestrationLog(
              `Triggered by ${username} via ${agentUpload.pipelineId ? `pipeline ${agentUpload.pipelineId}` : `task ${agentUpload.taskTitle}`}`,
            );

          const executeDeployment = async () => {
            if (graphDeployment) {
              const release = await shipUploadedProject(
                username,
                name,
                {
                  kind: ciUpload ? 'pipeline' : deploySource === 'cli' ? 'cli' : 'ship',
                  ref: ciUpload?.source_commit || 'Uploaded source',
                },
                orchestrationBuildLogId,
                releaseProjectMutation,
              );
              completeBuildLog(orchestrationBuildLogId, {
                success: true,
                duration: Date.now() - deployStartedAtMs,
              });
              appendOrchestrationLog(`Project release ${release.id} is Live`);
              if (!res.writableEnded)
                return json(res, { name, release, state: release.state }, 201);
              return;
            }
            // Cache deployment lookup to avoid redundant DB queries
            const cachedDeployment = getDeployment(name);
            const placement = getFleetPlacementState();
            const targetNodeId = cachedDeployment?.desiredNodeId || placement.defaultNodeId;
            const targetNode = targetNodeId ? getNode(targetNodeId) : null;
            if (!targetNode) {
              throw Object.assign(
                new Error('Choose a default deployment computer in Computers before deploying.'),
                { status: 428 },
              );
            }

            assertDeployRole(targetNode.id);
            let resolvedRuntimeEnvironment = getDeploymentEnvVars(name);
            let resolvedConfigurationDigest: string | null = null;
            let resolvedGraphRuntime: ResolvedApplicationGraphRuntime | null = null;
            if (deploymentDefinition.format === 'deploy.yaml') {
              const resolvedConfiguration = resolveApplicationConfiguration({
                deploymentName: name,
                specDigest: deploymentDefinition.compiled.digest,
                declarations: deploymentDefinition.compiled.spec.configuration,
                siteId: targetNode.id,
              });
              resolvedConfigurationDigest = resolvedConfiguration.digest;
              resolvedGraphRuntime = buildApplicationGraphRuntime({
                applicationId,
                specDigest: deploymentDefinition.compiled.digest,
                spec: deploymentDefinition.compiled.spec,
                configuration: resolvedConfiguration,
                siteId: targetNode.id,
              });
              if (!resolvedConfiguration.ready) {
                updateDeploymentStatus(name, 'building');
                appendOrchestrationLog(
                  'Preparing component images before the unresolved configuration gate',
                );
                uploadEvent({
                  type: 'deployment:status',
                  deploymentName: name,
                  data: { status: 'building', username },
                });
                const prepared = await new ApplicationGraphExecutor().prepare({
                  deploymentName: name,
                  applicationId,
                  siteId: targetNode.id,
                  nodeId: targetNode.id,
                  projectDirectory: deploymentDirectory,
                  runtime: resolvedGraphRuntime,
                  memoryLimit: cachedDeployment?.memoryLimit || '4g',
                  cpuLimit: cachedDeployment?.cpuLimit || undefined,
                  noCache: fields.noCache === '1' || fields.noCache === 'true',
                });
                const duration = Date.now() - deployStartedAtMs;
                completeBuildLog(orchestrationBuildLogId, { success: true, duration });
                uploadEvent({
                  type: 'build:complete',
                  deploymentName: name,
                  data: { success: true, duration },
                });
                updateDeploymentStatus(name, CONFIGURATION_REQUIRED_STATUS);
                appendOrchestrationLog(
                  `Build completed; runtime activation is waiting for: ${resolvedConfiguration.missing.join(', ')}`,
                );
                uploadEvent({
                  type: 'deployment:status',
                  deploymentName: name,
                  data: {
                    status: CONFIGURATION_REQUIRED_STATUS,
                    username,
                    missing: resolvedConfiguration.missing,
                  },
                });
                return json(
                  res,
                  {
                    name,
                    type,
                    buildCompleted: true,
                    activationGated: true,
                    missingConfiguration: resolvedConfiguration.missing,
                    preparedComponents: prepared.components.map((component) => component.component),
                  },
                  202,
                );
              }
              if (!resolvedGraphRuntime.ready) {
                throw Object.assign(
                  new Error(
                    `Application graph admission failed: ${resolvedGraphRuntime.execution.findings
                      .filter((finding) => finding.severity === 'error')
                      .map((finding) => finding.message)
                      .join('; ')}`,
                  ),
                  { status: 422 },
                );
              }
            }

            const sourceNodeId = cachedDeployment?.activeNodeId || 'coordinator';
            const movingBetweenNodes = Boolean(cachedDeployment) && sourceNodeId !== targetNode.id;
            const coordinatorContainerWasPresent =
              targetNode.id !== 'coordinator' &&
              (await containerExists(`deploy-sh-${name.toLowerCase()}`));
            let relocationBackupFilename: string | null = null;
            let relocationVolumeSizeBytes = 0;

            // A placement change carries managed data with it. First take custody
            // of a source-host snapshot on the coordinator, keeping the old route
            // live until the destination has built and restored successfully.
            if (cachedDeployment && (cachedDeployment.autoBackup || movingBetweenNodes)) {
              appendOrchestrationLog(
                movingBetweenNodes
                  ? `Backing up managed volumes on ${sourceNodeId} before moving nodes`
                  : `Backing up managed volumes on ${sourceNodeId} before deployment`,
              );
              updateDeploymentStatus(name, 'backing-up');
              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: {
                  status: 'backing-up',
                  username,
                  nodeId: sourceNodeId,
                  moving: movingBetweenNodes,
                },
              });
              try {
                let backup: Record<string, unknown>;
                const backupLabel = movingBetweenNodes ? 'pre-move' : 'pre-deploy';
                if (sourceNodeId !== 'coordinator') {
                  backup = await dispatchAgentCommand(
                    sourceNodeId,
                    'backup',
                    name,
                    {
                      label: backupLabel,
                      createdBy: username,
                      relatedBuildLogId: previousBuildLogId,
                      auto: cachedDeployment.autoBackup === true,
                    },
                    MIGRATION_TIMEOUT_MS,
                  );
                } else {
                  const localBackup = await createBackup(name, backupLabel, (progress) => {
                    reportMigrationProgress(name, {
                      phase: 'backing-up',
                      stage: 'compressing',
                      ...progress,
                    });
                  });
                  saveBackup({
                    deploymentName: name,
                    filename: localBackup.filename,
                    label: backupLabel,
                    sizeBytes: localBackup.sizeBytes,
                    createdBy: username,
                    createdAt: localBackup.timestamp,
                    volumePaths: ['data', 'uploads'],
                    relatedBuildLogId: previousBuildLogId,
                    auto: cachedDeployment.autoBackup === true,
                  });
                  backup = localBackup;
                }
                if (movingBetweenNodes) {
                  relocationBackupFilename = String(backup.filename || '');
                  if (!relocationBackupFilename)
                    throw new Error('Backup filename was not returned');
                  relocationVolumeSizeBytes = Number(
                    backup.volumeSizeBytes || backup.sizeBytes || 0,
                  );
                }
              } catch (backupErr) {
                if (movingBetweenNodes) {
                  updateDeploymentStatus(name, 'failed');
                  uploadEvent({
                    type: 'deployment:status',
                    deploymentName: name,
                    data: { status: 'failed', username, nodeId: sourceNodeId },
                  });
                  throw Object.assign(
                    new Error(`Unable to move application data: ${(backupErr as Error).message}`),
                    { status: 500 },
                  );
                }
                console.error('Auto-backup failed:', backupErr);
              }
            }

            // Finish the managed-volume migration before the destination build.
            // The old container remains live and routed during backup/restore.
            if (relocationBackupFilename) {
              updateDeploymentStatus(name, 'restoring');
              appendOrchestrationLog(`Restoring managed volumes on ${targetNode.name}`);
              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'restoring', username, nodeId: targetNode.id },
              });
              if (targetNode.kind === 'agent') {
                await dispatchAgentCommand(
                  targetNode.id,
                  'restore',
                  name,
                  { restart: false, totalBytes: relocationVolumeSizeBytes },
                  MIGRATION_TIMEOUT_MS,
                  resolve(getBackupDir(name), relocationBackupFilename),
                );
              } else {
                const backupPath = resolve(getBackupDir(name), relocationBackupFilename);
                const backupSizeBytes = statSync(backupPath).size;
                reportMigrationProgress(name, {
                  phase: 'restoring',
                  stage: 'extracting',
                  processedBytes: 0,
                  totalBytes: backupSizeBytes,
                });
                restoreBackup(name, relocationBackupFilename);
                reportMigrationProgress(name, {
                  phase: 'restoring',
                  stage: 'extracting',
                  processedBytes: backupSizeBytes,
                  totalBytes: backupSizeBytes,
                });
              }
              appendOrchestrationLog(`Managed-volume migration to ${targetNode.name} completed`);
            }

            // Remote nodes pull the retained artifact and perform the Docker build
            // locally after migration has completed.
            if (targetNode.kind === 'agent') {
              if (!targetNode.online) {
                throw Object.assign(new Error(`Deployment node "${targetNode.name}" is offline`), {
                  status: 503,
                });
              }
              if (!artifactPath) {
                throw Object.assign(new Error('Deployment artifact was not retained'), {
                  status: 500,
                });
              }

              updateDeploymentStatus(name, 'building');
              appendOrchestrationLog(`Remote build queued on ${targetNode.name}`);
              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'building', username, nodeId: targetNode.id },
              });
              const buildLogId = orchestrationBuildLogId;
              const job = enqueueAgentJob({
                nodeId: targetNode.id,
                type: 'deploy',
                deploymentName: name,
                artifactPath,
                payload: {
                  buildLogId,
                  noCache: fields.noCache === '1' || fields.noCache === 'true',
                  memoryLimit: cachedDeployment?.memoryLimit || '4g',
                  cpuLimit: cachedDeployment?.cpuLimit || undefined,
                  ...(graphDeployment
                    ? {
                        graph: createAgentGraphPayload({
                          deploymentName: name,
                          applicationId,
                          siteId: targetNode.id,
                          writerSiteId: applicationWriterSiteId(applicationId, targetNode.id),
                          runtime: resolvedGraphRuntime!,
                          runtimeVolumes: getDeploymentVolumes(name),
                        }),
                      }
                    : {
                        envVars: resolvedRuntimeEnvironment,
                        volumes: getDeploymentVolumes(name),
                        gpuEnabled: deployConfig.gpus ?? cachedDeployment?.gpuEnabled ?? false,
                        privilegedDocker:
                          deployConfig.privilegedDocker ??
                          cachedDeployment?.privilegedDocker ??
                          false,
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
              if (
                !finishedJob ||
                (finishedJob.status !== 'complete' && finishedJob.status !== 'failed')
              ) {
                agentJobsWithStreamedBuildOutput.delete(job.id);
                updateDeploymentStatus(name, 'failed');
                throw Object.assign(
                  new Error(`Timed out waiting for "${targetNode.name}" to finish the deploy`),
                  { status: 504 },
                );
              }

              const streamedBuildOutput = agentJobsWithStreamedBuildOutput.delete(job.id);
              const remoteResult = finishedJob.result ? JSON.parse(finishedJob.result) : {};
              const remoteOutput = String(remoteResult.buildOutput || '');
              if (remoteOutput && !streamedBuildOutput) {
                appendFileSync(buildLogFilePath(buildLogId), remoteOutput);
              }
              const buildDuration = Number(remoteResult.buildDuration || 0);
              uploadEvent({
                type: 'build:complete',
                deploymentName: name,
                data: {
                  success: finishedJob.status === 'complete',
                  duration: buildDuration,
                },
              });

              if (finishedJob.status === 'failed') {
                updateDeploymentStatus(name, 'failed');
                appendOrchestrationLog(finishedJob.error || 'Remote build failed');
                uploadEvent({
                  type: 'deployment:status',
                  deploymentName: name,
                  data: { status: 'failed', username, nodeId: targetNode.id },
                });
                throw Object.assign(new Error(finishedJob.error || 'Remote build failed'), {
                  status: 500,
                });
              }

              const reportedPort = Number(remoteResult.port);
              const port = Number.isInteger(reportedPort) && reportedPort > 0 ? reportedPort : null;
              const containerId = String(remoteResult.containerId || '');
              if (
                port &&
                (!targetNode.address || !(await waitForRemotePort(targetNode.address, port)))
              ) {
                throw Object.assign(
                  new Error(
                    `Application started, but the coordinator cannot reach ${targetNode.name} at ${
                      targetNode.address || 'its reported address'
                    }:${port}`,
                  ),
                  { status: 502 },
                );
              }
              if (!port && Object.keys(deploymentDefinition.compiled.spec.routes).length > 0) {
                throw Object.assign(
                  new Error('Application graph started without its primary route metadata'),
                  { status: 502 },
                );
              }
              const extraPorts =
                !graphDeployment && Array.isArray(remoteResult.extraPorts)
                  ? remoteResult.extraPorts
                  : [];
              if (graphDeployment) {
                if (!resolvedGraphRuntime)
                  throw new Error('Application graph runtime was not resolved');
                recordAgentGraphMaterialization({
                  deploymentName: name,
                  applicationId,
                  siteId: targetNode.id,
                  nodeId: targetNode.id,
                  nodeAddress: targetNode.address || '127.0.0.1',
                  relayPort: port,
                  runtime: resolvedGraphRuntime,
                  result: remoteResult as AgentGraphExecutionResult,
                });
              }
              saveDeployment({
                name,
                type: String(remoteResult.type || type),
                username,
                port: port ?? undefined,
                containerId,
                containerName: String(remoteResult.containerName || ''),
                directory: deploymentDirectory,
                extraPorts: extraPorts.length ? JSON.stringify(extraPorts) : null,
                desiredNodeId: targetNode.id,
                activeNodeId: targetNode.id,
                createdAt: new Date().toISOString(),
              });
              recordContainerStart(name);
              activateDesiredApplicationSpec(
                name,
                deploymentDefinition.compiled.digest,
                resolvedConfigurationDigest,
              );

              updateDeploymentStatus(name, 'running');
              updateCurrentBuildLogId(name, buildLogId);
              addDeployEvent(name, {
                action: 'deploy',
                username,
                type,
                port: port ?? undefined,
                containerId,
                buildLogId,
                durationMs: Date.now() - deployStartedAtMs,
                source: deploySource,
              });
              const allNames = getAllDeployments().map((deployment) => deployment.name);
              const firstRoute = resolvedGraphRuntime
                ? Object.values(resolvedGraphRuntime.execution.routes)[0]
                : null;
              if (firstRoute)
                updateDeploymentSettings(name, { discoverable: firstRoute.discoverable });
              if (port && ensureCertCoversHost(name, allNames)) notifyCertReload();
              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'running', username, type, port, nodeId: targetNode.id },
              });
              uploadEvent({
                type: 'deployment:created',
                deploymentName: name,
                data: { name, type, port, containerId, username, nodeId: targetNode.id },
              });
              if (movingBetweenNodes && cachedDeployment) {
                try {
                  if (sourceNodeId === 'coordinator') {
                    await removeContainer(name);
                    appendOrchestrationLog('Previous coordinator containers removed');
                  } else {
                    await dispatchAgentCommand(sourceNodeId, 'delete', name, {
                      deleteVolumes: false,
                    });
                    appendOrchestrationLog(`Previous containers removed from ${sourceNodeId}`);
                  }
                } catch (cleanupErr) {
                  console.warn(`[deploy] Previous node cleanup failed for ${name}:`, cleanupErr);
                  appendOrchestrationLog(
                    `Warning: previous node cleanup failed: ${(cleanupErr as Error).message}`,
                  );
                }
              }
              if (coordinatorContainerWasPresent && sourceNodeId !== 'coordinator') {
                try {
                  await removeContainer(name);
                  appendOrchestrationLog('Stray coordinator containers removed');
                } catch (cleanupErr) {
                  console.warn(
                    `[deploy] Stray coordinator container cleanup failed for ${name}:`,
                    cleanupErr,
                  );
                  appendOrchestrationLog(
                    `Warning: stray coordinator cleanup failed: ${(cleanupErr as Error).message}`,
                  );
                }
              }
              appendOrchestrationLog(`Deployment completed on ${targetNode.name}`);
              completeBuildLog(buildLogId, {
                success: true,
                duration: Date.now() - deployStartedAtMs,
              });
              return json(
                res,
                {
                  name,
                  type,
                  port,
                  containerId,
                  extraPorts,
                  node: targetNode.name,
                  ...(graphDeployment
                    ? {
                        components: Array.isArray(remoteResult.instances)
                          ? remoteResult.instances.length
                          : 0,
                        primaryRouting: remoteResult.primaryRouting ?? null,
                      }
                    : {}),
                },
                201,
              );
            }

            if (graphDeployment) {
              if (!resolvedGraphRuntime) {
                throw new Error('Application graph runtime was not resolved');
              }
              updateDeploymentStatus(name, 'building');
              appendOrchestrationLog(
                'Materializing application component graph on the coordinator',
              );
              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'building', username },
              });
              const graphExecutor = new ApplicationGraphExecutor();
              const materialized = await graphExecutor.converge({
                deploymentName: name,
                applicationId,
                siteId: targetNode.id,
                nodeId: targetNode.id,
                projectDirectory: deploymentDirectory,
                runtime: resolvedGraphRuntime,
                writerSiteId: applicationWriterSiteId(applicationId, targetNode.id),
                memoryLimit: cachedDeployment?.memoryLimit || '4g',
                cpuLimit: cachedDeployment?.cpuLimit || undefined,
                noCache: fields.noCache === '1' || fields.noCache === 'true',
                forceBuild:
                  !!ciUpload ||
                  repositorySourceChanged ||
                  repositoryRetryAfterFailure ||
                  fields.noCache === '1' ||
                  fields.noCache === 'true',
                forceReplace:
                  !!ciUpload ||
                  repositorySourceChanged ||
                  repositoryRetryAfterFailure ||
                  fields.noCache === '1' ||
                  fields.noCache === 'true',
              });
              updateDeploymentStatus(name, 'starting');
              saveDeployment({
                name,
                type,
                username,
                port: materialized.primaryPort ?? undefined,
                containerId: materialized.primaryContainerId ?? undefined,
                containerName: materialized.primaryContainerName ?? undefined,
                directory: deploymentDirectory,
                desiredNodeId: targetNode.id,
                activeNodeId: targetNode.id,
                createdAt: previousDeployment?.createdAt || new Date().toISOString(),
              });
              activateDesiredApplicationSpec(
                name,
                deploymentDefinition.compiled.digest,
                resolvedConfigurationDigest,
              );

              recordContainerStart(name);
              updateDeploymentStatus(name, 'running');
              updateCurrentBuildLogId(name, orchestrationBuildLogId);
              completeBuildLog(orchestrationBuildLogId, {
                success: true,
                duration: Date.now() - deployStartedAtMs,
              });
              addDeployEvent(name, {
                action: 'deploy',
                username,
                type,
                port: materialized.primaryPort ?? undefined,
                containerId: materialized.primaryContainerId ?? undefined,
                buildLogId: orchestrationBuildLogId,
                durationMs: Date.now() - deployStartedAtMs,
                source: deploySource,
              });
              const firstRoute = Object.values(resolvedGraphRuntime.execution.routes)[0];
              if (firstRoute) {
                updateDeploymentSettings(name, { discoverable: firstRoute.discoverable });
                const allNames = getAllDeployments().map((deployment) => deployment.name);
                if (ensureCertCoversHost(name, allNames)) notifyCertReload();
              }
              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'running', username, type, port: materialized.primaryPort },
              });
              uploadEvent({
                type: 'deployment:created',
                deploymentName: name,
                data: {
                  name,
                  type,
                  port: materialized.primaryPort,
                  containerId: materialized.primaryContainerId,
                  username,
                },
              });
              appendOrchestrationLog('Application graph deployment completed on the coordinator');
              return json(
                res,
                {
                  name,
                  type,
                  port: materialized.primaryPort,
                  containerId: materialized.primaryContainerId,
                  components: materialized.instances.length,
                },
                201,
              );
            }

            // Emit building status
            updateDeploymentStatus(name, 'building');
            appendOrchestrationLog('Local Docker build started on the coordinator');
            uploadEvent({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: 'building', username },
            });

            console.log(`Building ${name} (${type})...`);
            const buildLogId = orchestrationBuildLogId;
            // Build output goes straight to an append-only file. The old flow
            // accumulated the whole log in a string and rewrote the entire DB
            // column every 2s — O(n²) writes for chatty builds.
            const buildLogStream = createWriteStream(buildLogFilePath(buildLogId), {
              flags: 'a',
            });
            const buildStartedMs = Date.now();
            let buildResult: Awaited<ReturnType<typeof buildImage>> | null = null;
            try {
              const noCache = fields.noCache === '1' || fields.noCache === 'true';
              buildResult = await buildImage(
                name,
                deploymentDirectory,
                (line, timestamp) => {
                  buildLogStream.write(`[${timestamp}] ${line}\n`);
                  uploadEvent({
                    type: 'build:output',
                    deploymentName: name,
                    data: { line, timestamp },
                  });
                },
                { noCache, owner: username, projectId: repositoryProjectId },
              );

              buildLogStream.end();
              uploadEvent({
                type: 'build:complete',
                deploymentName: name,
                data: { success: buildResult.success, duration: buildResult.duration },
              });
            } catch (buildErr) {
              // Ensure build log is always marked as failed if an error occurs
              buildLogStream.write(
                `[${new Date().toISOString()}] Build failed due to an internal error\n`,
              );
              buildLogStream.end();
              completeBuildLog(buildLogId, {
                success: false,
                duration: Date.now() - buildStartedMs,
              });
              updateDeploymentStatus(name, 'failed');
              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'failed', username },
              });
              throw buildErr;
            }

            // If build failed, return error
            if (!buildResult.success) {
              updateDeploymentStatus(name, 'failed');
              completeBuildLog(buildLogId, {
                success: false,
                duration: Date.now() - deployStartedAtMs,
              });
              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'failed', username },
              });
              throw Object.assign(
                new Error(
                  `Build failed after ${buildResult.duration}ms. Check build logs for details.`,
                ),
                { status: 500 },
              );
            }

            // Capture runtime logs from the current container before it's replaced
            if (previousBuildLogId) {
              const runtimeLogs = await captureContainerLogsAsync(name);
              if (runtimeLogs) {
                saveRuntimeLogs(previousBuildLogId, runtimeLogs);
              }
            }

            // Emit starting status
            updateDeploymentStatus(name, 'starting');
            uploadEvent({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: 'starting', username },
            });

            try {
              const port = await getAvailablePort();
              console.log(`Starting ${name} on port ${port}...`);
              const volumeDir = getVolumeDir(name);
              const storedEnvVars = resolvedRuntimeEnvironment;
              const storedVolumes = getDeploymentVolumes(name);
              const memLimit = cachedDeployment?.memoryLimit || '4g';
              const cpuLimit = cachedDeployment?.cpuLimit || undefined;
              const gpuFlag = deployConfig.gpus ?? cachedDeployment?.gpuEnabled ?? false;
              const privilegedDocker =
                deployConfig.privilegedDocker ?? cachedDeployment?.privilegedDocker ?? false;
              // Validate manifest-declared volumes before merging them in.
              const declaredVolumes = (deployConfig.volumes || []).map((v) => ({
                hostPath: v.hostPath,
                containerPath: v.containerPath,
                readOnly: v.readOnly,
              }));
              if (declaredVolumes.length > 0) {
                const volErr = validateVolumeMounts(declaredVolumes, { privilegedDocker });
                if (volErr) {
                  throw new Error(`Manifest volumes invalid: ${volErr}`);
                }
              }
              // Merge: stored (UI-set) volumes take precedence, declared volumes are appended
              const mergedVolumes = [
                ...storedVolumes,
                ...declaredVolumes.filter(
                  (dv) =>
                    !storedVolumes.some(
                      (sv) => sv.hostPath === dv.hostPath && sv.containerPath === dv.containerPath,
                    ),
                ),
              ];
              // Preserve existing runtime ports when none are declared.
              if (!deployConfig.ports?.length && cachedDeployment?.extraPorts) {
                try {
                  const parsed = JSON.parse(cachedDeployment.extraPorts) as Array<{
                    container: number;
                    host: number;
                    protocol: string;
                  }>;
                  deployConfig.ports = parsed.map((p) => ({
                    container: p.container,
                    protocol: p.protocol,
                  }));
                } catch {
                  // ignore parse errors
                }
              }

              // ── Blue/green orchestration ────────────────────────────────────
              // Old container stays alive on its current port until the new one
              // passes a health check. The reverse proxy points at the port
              // recorded on the deployment row; updating that row at the end is
              // the atomic switchover. The old container is removed after a
              // drain window so in-flight requests can finish; one prior release
              // remains available for an operator-triggered rollback.
              const canonicalName = `deploy-sh-${name.toLowerCase()}`;
              const prevName = `${canonicalName}-prev-${Date.now()}`;
              const hadPrevious = await containerExists(canonicalName);
              if (hadPrevious) {
                try {
                  await renameContainerByName(canonicalName, prevName);
                  console.log(
                    `[deploy] Renamed ${canonicalName} -> ${prevName} for blue/green swap`,
                  );
                } catch (err) {
                  console.warn(
                    `[deploy] Failed to rename previous container, falling back to recreate:`,
                    err,
                  );
                }
              }

              let runResult;
              try {
                runResult = await runContainer(
                  buildResult.tag,
                  name,
                  port,
                  volumeDir,
                  deployConfig,
                  storedEnvVars,
                  memLimit,
                  mergedVolumes,
                  gpuFlag,
                  privilegedDocker,
                  cpuLimit,
                  undefined,
                  {
                    skipExistingRemoval: hadPrevious,
                    sshKeysSourceContainer: hadPrevious ? prevName : undefined,
                  },
                );

                // Health-gate the switchover. If the new container never accepts
                // a TCP connection within 30s, treat it as a failed deploy and
                // roll back to the previous container.
                const healthy = await healthCheckPort(port, 30_000);
                if (!healthy) {
                  throw new Error(
                    `New container failed health check (port ${port} not accepting connections within 30s)`,
                  );
                }
              } catch (rolloutErr) {
                // Rollback: kill the new container if it started, restore the
                // previous one to its canonical name so the proxy keeps working.
                await removeContainerByName(canonicalName);
                if (hadPrevious && (await containerExists(prevName))) {
                  try {
                    await renameContainerByName(prevName, canonicalName);
                    console.log(`[deploy] Rolled back: restored ${canonicalName}`);
                  } catch (renameErr) {
                    console.error(`[deploy] Rollback rename failed:`, renameErr);
                  }
                }
                throw rolloutErr;
              }

              const { id, containerName, extraPorts } = runResult;
              const extraPortsJson = extraPorts.length > 0 ? JSON.stringify(extraPorts) : null;

              saveDeployment({
                name,
                type,
                username,
                port,
                containerId: id,
                containerName,
                directory: deploymentDirectory,
                extraPorts: extraPortsJson,
                desiredNodeId: targetNode.id,
                activeNodeId: targetNode.id,
                createdAt: new Date().toISOString(),
              });
              recordContainerStart(name);
              activateDesiredApplicationSpec(
                name,
                deploymentDefinition.compiled.digest,
                resolvedConfigurationDigest,
              );

              // Switchover happened above (DB now points at the new container).
              // Retain one previous release for instant rollback. Older retained
              // releases are pruned after the route has switched successfully.
              if (hadPrevious) {
                setTimeout(() => {
                  stopContainerByName(prevName)
                    .then(() => prunePreviousContainers(name))
                    .catch((err) =>
                      console.warn(`[deploy] Failed to retain previous release for ${name}:`, err),
                    );
                }, 30_000).unref();
              }

              updateDeploymentStatus(name, 'running');
              updateCurrentBuildLogId(name, buildLogId);

              const deployConfigSettings: {
                discoverable?: boolean;
                gpuEnabled?: boolean;
                privilegedDocker?: boolean;
              } = {};
              if (deployConfig.discoverable !== undefined)
                deployConfigSettings.discoverable = deployConfig.discoverable;
              if (deployConfig.gpus !== undefined)
                deployConfigSettings.gpuEnabled = deployConfig.gpus;
              if (deployConfig.privilegedDocker !== undefined)
                deployConfigSettings.privilegedDocker = deployConfig.privilegedDocker;
              if (Object.keys(deployConfigSettings).length > 0) {
                updateDeploymentSettings(name, deployConfigSettings);
              }

              addDeployEvent(name, {
                action: 'deploy',
                username,
                type,
                port,
                containerId: id,
                buildLogId,
                durationMs: Date.now() - deployStartedAtMs,
                source: deploySource,
              });
              // Regenerate TLS cert if this hostname isn't covered yet; the edge
              // (TLS owner) hot-reloads its secure context on the IPC signal.
              const allNames = getAllDeployments().map((d) => d.name);
              if (ensureCertCoversHost(name, allNames)) {
                notifyCertReload();
              }

              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'running', username, type, port },
              });
              uploadEvent({
                type: 'deployment:created',
                deploymentName: name,
                data: { name, type, port, containerId: id, username },
              });

              if (movingBetweenNodes && sourceNodeId !== 'coordinator') {
                try {
                  await dispatchAgentCommand(sourceNodeId, 'delete', name, {
                    deleteVolumes: false,
                  });
                } catch (cleanupErr) {
                  console.warn(`[deploy] Previous node cleanup failed for ${name}:`, cleanupErr);
                }
              }

              appendOrchestrationLog('Deployment completed on the coordinator');
              completeBuildLog(buildLogId, {
                success: true,
                duration: Date.now() - deployStartedAtMs,
              });
              console.log(`Deployed ${name} → https://${name}.local`);
              return json(res, { name, type, port, containerId: id, extraPorts }, 201);
            } catch (startErr) {
              // Container start failed — mark deployment as failed
              updateDeploymentStatus(name, 'failed');
              uploadEvent({
                type: 'deployment:status',
                deploymentName: name,
                data: { status: 'failed', username },
              });
              throw startErr;
            }
          };

          if (detached) {
            json(
              res,
              {
                accepted: true,
                ...(ciUpload ? { receipt: { ...ciReceipt(ciUpload), status: 'building' } } : {}),
                name,
                buildLogId: orchestrationBuildLogId,
                projectRelease: !!graphDeployment,
                status: 'uploading',
                dashboardUrl: `/dashboard/${encodeURIComponent(name)}/build`,
              },
              202,
            );
            void withApplicationMutation(name, executeDeployment)
              .then(async () => {
                if (agentUpload && getDeployment(name)?.status === 'running')
                  finishAgentUpload(agentUpload);
                if (!ciUpload) return;
                const verified = await verifiedCiRuntime(name, username);
                const d = getDeployment(name);
                const info = d?.containerId ? await inspectContainer(d.containerId) : null;
                if (
                  !d ||
                  d.status !== 'running' ||
                  d.activeSpecDigest !== ciUpload.spec_digest ||
                  d.sourceArtifactDigest !== ciUpload.source_digest ||
                  !info ||
                  info.State.Status !== 'running' ||
                  !/^sha256:[a-f0-9]{64}$/.test(info.Image) ||
                  (ciUpload.source_digest !== ciUpload.baseline_source &&
                    d.containerId === ciUpload.baseline_container)
                )
                  ciError('Runtime does not match release receipt');
                finishCiRelease(ciUpload.id, {
                  containerId: info.Id,
                  imageDigest: verified.imageDigest,
                });
              })
              .catch((deployErr) => {
                const failureStatus = (deployErr as Error & { runtimeUnchanged?: boolean })
                  .runtimeUnchanged
                  ? releaseBaselineStatus || 'stopped'
                  : deploymentErrorStatus(deployErr);
                updateDeploymentStatus(name, failureStatus);
                appendOrchestrationLog(
                  `Deployment failed: ${(deployErr as Error).message || String(deployErr)}`,
                );
                completeBuildLog(orchestrationBuildLogId, {
                  success: false,
                  duration: Date.now() - deployStartedAtMs,
                });
                uploadEvent({
                  type: 'deployment:status',
                  deploymentName: name,
                  data: { status: failureStatus, username },
                });
              })
              .finally(releaseDeployLease);
            return;
          }

          try {
            await executeDeployment();
          } catch (deployErr) {
            const failureStatus = (deployErr as Error & { runtimeUnchanged?: boolean })
              .runtimeUnchanged
              ? releaseBaselineStatus || 'stopped'
              : deploymentErrorStatus(deployErr);
            updateDeploymentStatus(name, failureStatus);
            appendOrchestrationLog(
              `Deployment failed: ${(deployErr as Error).message || String(deployErr)}`,
            );
            completeBuildLog(orchestrationBuildLogId, {
              success: false,
              duration: Date.now() - deployStartedAtMs,
            });
            uploadEvent({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: failureStatus, username },
            });
            const typedDeployError = deployErr as Error & { status?: number };
            return error(res, typedDeployError.message, typedDeployError.status || 500);
          } finally {
            releaseDeployLease();
          }
          return;
        });
      };
      return await dispatch(
        [
          ...[
            '/api/upload',
            '/api/ci/releases/:id([a-f0-9-]+)/upload',
            '/api/deployments/wander/managed-adoption/upload',
          ].map((uploadPath) =>
            uploadRoute({
              method: 'POST',
              path: uploadPath,
              handler: async () => {
                if (uploadPath === '/api/ci/releases/:id([a-f0-9-]+)/upload' && !ciUpload)
                  return false;

                return multipartUpload();
              },
            }),
          ),
        ],
        { path: () => path, method: () => method },
      )(req, res, undefined);
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
