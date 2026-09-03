import {
  appendFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { totalmem, cpus } from 'node:os';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection, isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import Busboy from 'busboy';
import {
  inspectUploadArchive,
  MAX_UPLOAD_ARCHIVE_BYTES,
  UploadArchiveError,
} from './upload-archive.ts';
import { startMetricsCollector } from './metrics-collector.ts';
import {
  claimAgentExecSession,
  closeAgentExecSession,
  pollAgentExecSession,
  writeAgentExecOutput,
} from './agent-exec.ts';
import { createHotPathHandler } from './edge/proxy.ts';
import {
  certsExist,
  ensureCertCoversHost,
  getCaCertBuffer,
  signSuitcaseIntermediateCertificate,
  validateSuitcaseIntermediateCsr,
} from './certs.ts';

import {
  registerUser,
  loginUser,
  authenticate,
  logoutUser,
  getUser,
  changePassword,
  saveDeployment,
  getDeployment,
  getDeployments,
  deleteDeployment,
  updateDeploymentSettings,
  updateDeploymentStatus,
  recordContainerStart,
  getDiscoverableDeployments,
  getUploadsDir,
  addDeployEvent,
  getDeployHistory,
  logRequest,
  getRequestLogs,
  getRequestSummary,
  getCurrentHealth,
  getDashboardAggregate,
  getRequestSeries,
  getTopErrorPaths,
  saveBackup,
  getBackups,
  deleteBackupRecord,
  createBuildLog,
  buildLogFilePath,
  completeBuildLog,
  getBuildLogs,
  getActiveBuildLog,
  saveRuntimeLogs,
  updateCurrentBuildLogId,
  getDeploymentEnvVars,
  getDeploymentVolumes,
  getAllocatedMemory,
  getAllDeployments,
  isAdmin,
  createNodeEnrollment,
  redeemNodeEnrollment,
  authenticateNode,
  heartbeatNode,
  revokeNode,
  setDefaultNode,
  getFleetPlacementState,
  claimAgentJob,
  getAgentJob,
  getRecentAgentJobs,
  reconcileNodeRuntimePorts,
  registerDeploymentStart,
  completeAgentJob,
  cancelQueuedAgentJob,
  setDeploymentDesiredNode,
  enqueueAgentJob,
  getNode,
  saveDesiredApplicationSpec,
  activateDesiredApplicationSpec,
  getApplicationSpecRevision,
  getApplicationSpecRevisions,
  getApplicationSpecTransitions,
  getApplicationGraphState,
  getComponentSiteOverrides,
  listComponentSiteOverrides,
  setComponentSiteOverride,
  getApplicationConfigurationValues,
  transitionProfileApplicationSpec,
  updateDeploymentConfigurationDigest,
  updateDeploymentArtifactDigests,
} from './store.ts';
import { emit } from './events.ts';
import { notifyCertReload } from './ipc.ts';
import { forgetApp as forgetCrashTracker } from './crash-tracker.ts';
import {
  classifyProject,
  ensureDockerfile,
  buildImage,
  runContainer,
  removeContainer,
  removeContainerByName,
  renameContainerByName,
  containerExists,
  healthCheckPort,
  prunePreviousContainers,
  stopContainerByName,
  getContainerStatusAsync,
  getAllContainerStatuses,
  getDeploymentContainerStatuses,
  captureContainerLogsAsync,
  streamContainerLogs,
  getAvailablePort,
  getContainerInspectAsync,
  getContainerStats,
  restartContainer,
  recreateContainer,
  parseMemoryLimit,
  validateVolumeMounts,
  startDockerEventStream,
} from './docker.ts';
import { resolveApplicationInstanceTarget } from './application-instance-target.ts';
import { createAgentGraphPayload } from './agent-graph-payload.ts';
import { recordAgentGraphMaterialization } from './agent-graph-recording.ts';
import type { AgentGraphExecutionResult } from './agent-graph-runtime.ts';
import {
  getVolumeDir,
  createBackup,
  restoreBackup,
  deleteBackupFile,
  deleteVolumes,
  getVolumeSize,
  getBackupDir,
} from './volumes.ts';
import { readDeploymentDefinition } from './deploy-config.ts';
import {
  carryForwardCompatibleConfiguration,
  resolveApplicationConfiguration,
  setDeclaredConfigurationValue,
} from './application-configuration.ts';
import {
  buildApplicationGraphRuntime,
  resolveApplicationGraphRuntime,
  resolveDeploymentRuntime,
  type ResolvedApplicationGraphRuntime,
} from './application-runtime.ts';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
} from './application-graph-executor.ts';
import {
  createCoordinatorApplicationBackup,
  isCoordinatorApplicationGraph,
  restoreCoordinatorApplicationBackup,
} from './application-backups.ts';
import { applicationWriterSiteId } from './application-authority.ts';
import {
  compileDeployYaml,
  parseRepositoryBaseDigest,
  parseStoredApplicationSpec,
  renderDeployYaml,
  renderRepositoryDeployYaml,
} from './application-spec.ts';
import { emptyApplicationSpec, planApplicationChange } from './application-plan.ts';
import {
  admitRepositoryRevision,
  rebaseApplicationRevision,
  repositoryUploadCanSkipRuntime,
  renderParentRelativeApplicationPatch,
  RepositoryRevisionConflictError,
} from './application-revision.ts';
import { planApplicationExecution } from './application-execution.ts';
import { resolvePlacementTarget } from './application-placement-target.ts';
import {
  CatalogService,
  DeployLocalCatalogRuntime,
  DurableCatalogTargetResolver,
  DurableCatalogStore,
  handleCatalogRequest,
  loadValidationCatalog,
} from './catalog/index.ts';
import {
  acquireDeploySlot,
  getDeployAdmissionState,
  cancelQueuedDeploy,
  type DeployLease,
} from './deploy-admission.ts';
import {
  MULTISITE_PROTOCOL_VERSION,
  createSuitcasePairing,
  ensureFleetIdentity,
  registerApplicationIdentity,
  redeemSuitcasePairing,
  resolveLocalSiteId,
  revokeSite,
  updateSitePresence,
} from './multisite.ts';
import {
  MAX_ARTIFACT_CHUNK_BYTES,
  SuitcaseProtocolError,
  appendSuitcaseArtifactChunk,
  authorizeSuitcaseSite,
  beginSuitcaseArtifactUpload,
  exchangeSuitcaseEvents,
  fleetTopologyWithSync,
  readSuitcaseArtifactChunk,
  suitcaseAccessDiagnostics,
  suitcaseSyncStatus,
  type SiteAuthorization,
} from './suitcase-transport.ts';
import { recordSuitcaseClientAccess } from './suitcase-access-readiness.ts';
import {
  completeSiteCredentialProof,
  requestSiteCredentialRotation,
} from './recovery-readoption.ts';
import { handleFleetRequest } from './fleet-handler.ts';
import {
  FleetMutationBlockedError,
  applicationDeleteMutationFingerprint,
  assertFleetMutationReady,
  destructiveGraphMutationFingerprint,
  requiresFleetAcknowledgement,
} from './fleet-mutation-guard.ts';
import { handleOperationsRequest } from './operations-handler.ts';
import {
  projectAdministratorsToEverySuitcase,
  projectAdministratorsToSite,
} from './offline-auth.ts';
import { publishActivatedApplicationRevision } from './distributed-application-events.ts';
import { projectApplicationConfigurationToReplicas } from './site-configuration-envelope.ts';
import { getArtifact, putArtifactFile } from './content-store.ts';
import { collectLocalFleetTelemetry } from './fleet-telemetry.ts';
import {
  reconcileAllAutomaticChangesets,
  reconcilePendingChangesets,
} from './reconciliation-coordinator.ts';
import { processLocalOpaqueVolumeAuthorityTransfers } from './volume-sync.ts';
import { publishComponentSiteCount } from './component-site-overrides.ts';

// Pre-container states where Docker has no container yet
const PRE_CONTAINER_STATES = new Set([
  'uploading',
  'backing-up',
  'building',
  'restoring',
  'starting',
  'recreating',
]);
const CONFIGURATION_REQUIRED_STATUS = 'configuration-required';
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
const MIGRATION_STATES = new Set(['backing-up', 'restoring']);
const MIGRATION_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Graph lifecycle work is always executed by the control surface that owns the
 * local Docker runtime. Home historically stores that location as
 * `coordinator`; a Suitcase stores its durable fleet site id. Keeping this
 * translation at the API boundary lets the exact same operation endpoints work
 * while disconnected without accidentally operating a remote node's graph.
 */
function localGraphSiteId(): string {
  return process.env.DEPLOY_SUITCASE === '1' ? resolveLocalSiteId() : 'coordinator';
}

function graphDeploymentSiteId(deployment: {
  activeNodeId?: string | null;
  desiredNodeId?: string | null;
}): string {
  return deployment.activeNodeId || deployment.desiredNodeId || 'coordinator';
}

function localGraphSiteFor(deployment: {
  activeNodeId?: string | null;
  desiredNodeId?: string | null;
}): string | null {
  const localSiteId = localGraphSiteId();
  return graphDeploymentSiteId(deployment) === localSiteId ? localSiteId : null;
}

interface MigrationProgress {
  phase: 'backing-up' | 'restoring';
  stage: 'compressing' | 'transferring' | 'extracting';
  processedBytes: number;
  totalBytes: number;
  updatedAt: number;
}
const migrationProgressByDeployment = new Map<string, MigrationProgress>();
interface AgentJobActivity {
  stage: string;
  processedBytes: number;
  totalBytes: number;
  updatedAt: number;
  logs: Array<{ timestamp: number; message: string }>;
}
const agentActivityByJob = new Map<string, AgentJobActivity>();
const agentJobsWithStreamedBuildOutput = new Set<string>();

function reportMigrationProgress(
  deploymentName: string,
  progress: Omit<MigrationProgress, 'updatedAt'>,
) {
  const snapshot = { ...progress, updatedAt: Date.now() };
  migrationProgressByDeployment.set(deploymentName, snapshot);
  emit({
    type: 'deployment:migration-progress',
    deploymentName,
    data: snapshot,
  });
}

function updateAgentActivity(
  jobId: string,
  update: Partial<Omit<AgentJobActivity, 'logs'>>,
  message?: string,
) {
  const current = agentActivityByJob.get(jobId) || {
    stage: 'queued',
    processedBytes: 0,
    totalBytes: 0,
    updatedAt: Date.now(),
    logs: [],
  };
  const logs = message
    ? [...current.logs, { timestamp: Date.now(), message }].slice(-20)
    : current.logs;
  agentActivityByJob.set(jobId, {
    ...current,
    ...update,
    updatedAt: Date.now(),
    logs,
  });
}

/** Async resolve status — avoids blocking the event loop during HTTP request handling. */
async function resolveStatusAsync(d: {
  name: string;
  status: string | null;
  updatedAt?: string | null;
  activeNodeId?: string | null;
}): Promise<string> {
  if (d.status === CONFIGURATION_REQUIRED_STATUS) return d.status;
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
    status: string | null;
    updatedAt?: string | null;
    activeNodeId?: string | null;
  },
  statusMap: Map<string, string>,
): string {
  if (d.status === CONFIGURATION_REQUIRED_STATUS) return d.status;
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

// ── Helpers ─────────────────────────────────────────────────────────────────

class RequestBodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejected = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError(`Request body exceeds the ${maxBytes} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

function fleetMutationBlocked(
  res: ServerResponse,
  blocked: FleetMutationBlockedError,
  details: Record<string, unknown> = {},
) {
  return json(
    res,
    {
      error: blocked.message,
      code: blocked.code,
      gate: blocked.gate,
      ...details,
    },
    blocked.status,
  );
}

function deploymentErrorStatus(errorValue: unknown): string {
  const value = errorValue as { deploymentStatus?: unknown };
  return typeof value?.deploymentStatus === 'string' ? value.deploymentStatus : 'failed';
}

// ── Auth ────────────────────────────────────────────────────────────────────
// Supports two transport methods (no behavioral difference, just where the
// secret lives):
//   - Cookie `deploy-sh-auth` set by /api/login — used by the browser so server
//     components can read it via getRequest() on initial render, skipping the
//     usual __action round-trip to fetch dashboard data.
//   - X-Deploy-Username / X-Deploy-Token headers — used by the CLI and by
//     existing client-side `'use server'` calls that pass auth explicitly.
const AUTH_COOKIE = 'deploy-sh-auth';

function parseAuthCookie(req: IncomingMessage): { username?: string; token?: string } {
  const raw = req.headers.cookie;
  if (!raw) return {};
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === AUTH_COOKIE) {
      const value = rest.join('=');
      try {
        const decoded = decodeURIComponent(value);
        const sep = decoded.indexOf(':');
        if (sep === -1) return {};
        return { username: decoded.slice(0, sep), token: decoded.slice(sep + 1) };
      } catch {
        return {};
      }
    }
  }
  return {};
}

function getAuth(req: IncomingMessage) {
  const username = (req.headers['x-deploy-username'] as string | undefined) ?? undefined;
  const token = (req.headers['x-deploy-token'] as string | undefined) ?? undefined;
  if (username && token) return { username, token };
  return parseAuthCookie(req);
}

function buildAuthCookie(username: string, token: string): string {
  // 30 day TTL; httpOnly so JS can't read it (XSS-resistant); SameSite=Lax so
  // cookie still flows on top-level navigation. Secure flag is set because we
  // only serve over HTTPS (HTTP redirects to HTTPS).
  const value = encodeURIComponent(`${username}:${token}`);
  return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${60 * 60 * 24 * 30}`;
}

function clearAuthCookie(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
): { username: string; token: string } | null {
  const { username, token } = getAuth(req);
  if (!authenticate(username, token)) {
    error(res, 'Unauthorized', 401);
    return null;
  }
  return { username: username!, token: token! };
}

function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): { username: string; token: string } | null {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (!isAdmin(auth.username)) {
    error(res, 'Administrator access required', 403);
    return null;
  }
  return auth;
}

function suitcaseProtocolFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof SuitcaseProtocolError) {
    json(
      res,
      {
        error: err.message,
        code: err.code,
        protocolVersion: MULTISITE_PROTOCOL_VERSION,
        ...(err.details || {}),
      },
      err.status,
    );
    return;
  }
  error(res, err instanceof Error ? err.message : String(err), 400);
}

function requireSuitcaseSite(req: IncomingMessage, res: ServerResponse): SiteAuthorization | null {
  try {
    return authorizeSuitcaseSite({
      siteId: req.headers['x-deploy-site-id'] as string | undefined,
      credential: req.headers['x-deploy-site-credential'] as string | undefined,
      protocolVersion: req.headers['x-deploy-suitcase-protocol'] as string | undefined,
    });
  } catch (err) {
    suitcaseProtocolFailure(res, err);
    return null;
  }
}

function remoteAddress(req: IncomingMessage): string | undefined {
  return req.socket.remoteAddress?.replace(/^::ffff:/, '');
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

async function dispatchAgentCommand(
  nodeId: string,
  type: string,
  deploymentName: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 120_000,
  artifactPath?: string,
  settleRunningOnTimeout = false,
) {
  const node = getNode(nodeId);
  if (!node || !node.online) throw new Error('Deployment node is offline');
  const queued = enqueueAgentJob({
    nodeId,
    type,
    deploymentName,
    payload,
    artifactPath,
  });
  const deadline = Date.now() + timeoutMs;
  let job = getAgentJob(queued.id);
  while (job && job.status !== 'complete' && job.status !== 'failed' && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    job = getAgentJob(queued.id);
  }
  if (!job || (job.status !== 'complete' && job.status !== 'failed')) {
    const timeoutError = `Timed out waiting for ${node.name}`;
    if (job && cancelQueuedAgentJob(job.id, timeoutError)) {
      throw new Error(timeoutError);
    }
    job = getAgentJob(queued.id);
    if (settleRunningOnTimeout && job?.status === 'running') {
      // The mutation has started and can no longer be safely abandoned. Wait
      // for its terminal result so coordinator metadata cannot diverge from
      // what the agent actually did.
      while (job.status === 'running') {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        job = getAgentJob(queued.id);
        if (!job) break;
      }
    }
    if (!job || (job.status !== 'complete' && job.status !== 'failed')) {
      throw new Error(timeoutError);
    }
  }
  if (job.status === 'failed') throw new Error(job.error || `Remote ${type} failed`);
  return job.result ? (JSON.parse(job.result) as Record<string, unknown>) : {};
}

function waitForRemotePort(host: string, port: number, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = createConnection({ host, port });
      let settled = false;
      const finishAttempt = (connected: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (connected) {
          resolvePromise(true);
        } else if (Date.now() >= deadline) {
          resolvePromise(false);
        } else {
          setTimeout(attempt, 250);
        }
      };
      socket.once('connect', () => finishAttempt(true));
      socket.once('error', () => finishAttempt(false));
      socket.setTimeout(1_000, () => finishAttempt(false));
    };
    attempt();
  });
}

// ── Reverse proxy hot path ──────────────────────────────────────────────────
// Lives in edge/proxy.ts (shared with the edge process). In single-process
// mode the entry swaps the route source to the edge RouteTable (which also
// sees mutations made from RSC action worker threads via IPC); the store
// cache is the fallback. In split mode app traffic never reaches this
// process, so the hot path simply never matches.

let _routeSource: (appName: string) => { name: string; port: number | null } | null = (appName) =>
  getDeployment(appName);

export function setHotPathRouteSource(fn: typeof _routeSource) {
  _routeSource = fn;
}

const hotPath = createHotPathHandler({
  getRoute: (appName) => _routeSource(appName),
  logRequest,
  emitEvent: emit,
});

const catalogService = new CatalogService(loadValidationCatalog(), new DurableCatalogStore());
const catalogRuntime = new DeployLocalCatalogRuntime();
const catalogTargets = new DurableCatalogTargetResolver();

// ── Middleware ───────────────────────────────────────────────────────────────

type NextFn = () => void;

export function apiMiddleware() {
  startMetricsCollector();
  void reconcileAllAutomaticChangesets().catch((error) =>
    console.error('[reconciliation] startup sweep failed:', error),
  );
  void processLocalOpaqueVolumeAuthorityTransfers().catch((error) =>
    console.error('[writer-handoff] startup recovery failed:', error),
  );
  // Single long-lived `docker events` subscriber keeps the container-status
  // cache warm without per-request polling. Auto-reconnects if docker daemon
  // restarts.
  startDockerEventStream();
  return async (req: IncomingMessage, res: ServerResponse, next: NextFn) => {
    // ── Hot-path: mDNS proxy for <name>.local (edge/proxy.ts) ──
    if (hotPath(req, res)) return;

    // ── Non-proxy paths: parse URL and continue with the slow path ──
    const rawUrl = req.url!;
    const method = req.method;
    const hostHeader =
      req.headers.host || (req.headers[':authority'] as string | undefined) || 'deploy.local';
    const colonIdx = hostHeader.indexOf(':');
    const hostname = colonIdx === -1 ? hostHeader : hostHeader.substring(0, colonIdx);
    const url = new URL(rawUrl, `http://${hostHeader}`);
    const path = url.pathname;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      res.end();
      return;
    }

    // Serve CA certificate for trust installation (works on any host)
    if (path === '/ca.crt' && method === 'GET' && certsExist()) {
      const caCert = getCaCertBuffer();
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="deploy-sh-ca.crt"',
        'Content-Length': caCert.length,
      });
      res.end(caCert);
      return;
    }

    // ── discover.local — redirect root to /discover ─────────────────────
    if (hostname === 'discover.local' && (path === '/' || path === '')) {
      res.writeHead(302, { Location: '/discover' });
      res.end();
      return;
    }

    try {
      if (path === '/api/catalog' || path.startsWith('/api/catalog/')) {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        if (method !== 'GET' && method !== 'POST') {
          return error(res, 'Catalog route not found', 404);
        }
        let body: unknown;
        if (method === 'POST') {
          const source = (await readBody(req)).toString();
          try {
            body = source ? JSON.parse(source) : {};
          } catch {
            return error(res, 'Request body must be valid JSON', 400);
          }
        }
        const response = await handleCatalogRequest(
          catalogService,
          {
            method,
            pathname: `${path.slice('/api'.length)}${url.search}`,
            body,
            actor: { username: auth.username, role: 'admin' },
          },
          catalogRuntime,
          catalogTargets,
        );
        return json(res, response.body, response.status);
      }

      // ── Public discover API ──────────────────────────────────────────────

      if (path === '/api/discover' && method === 'GET') {
        const allDeps = getDiscoverableDeployments();
        const statusMap = await getAllContainerStatuses();
        const apps = allDeps.map((d) => ({
          name: d.name,
          type: d.type,
          status: resolveStatusBatched(d, statusMap),
        }));
        return json(res, apps);
      }

      if (path === '/api/system/memory' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const systemBytes = totalmem();
        const { totalBytes, perDeployment } = getAllocatedMemory();
        return json(res, {
          system: {
            totalBytes: systemBytes,
            allocatedBytes: totalBytes,
            availableBytes: Math.max(0, systemBytes - totalBytes),
          },
          deployments: perDeployment,
        });
      }

      // ── Auth routes ───────────────────────────────────────────────────────

      if (path === '/api/register' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.username || !body.password) {
          return error(res, 'Username and password required');
        }
        const result = registerUser(body.username as string, body.password as string);
        if ('error' in result) return error(res, result.error!, result.status!);
        if (isAdmin(body.username as string)) {
          projectAdministratorsToEverySuitcase(body.username as string);
        }
        // Set cookie so subsequent navigations can pre-render with auth context
        // (server components can read it via getRequest()).
        res.setHeader('Set-Cookie', buildAuthCookie(body.username as string, result.token));
        return json(res, { token: result.token }, 201);
      }

      if (path === '/api/login' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.username || !body.password) {
          return error(res, 'Username and password required');
        }
        const result = loginUser(body.username as string, body.password as string);
        if ('error' in result) return error(res, result.error!, result.status!);
        res.setHeader('Set-Cookie', buildAuthCookie(body.username as string, result.token));
        return json(res, { token: result.token });
      }

      if (path === '/api/logout' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        logoutUser(auth.username, auth.token);
        res.setHeader('Set-Cookie', clearAuthCookie());
        return json(res, { message: 'Logged out' });
      }

      if (path === '/api/user' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const user = getUser(auth.username);
        return json(res, user);
      }

      if (path === '/api/user/password' && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.currentPassword || !body.newPassword) {
          return error(res, 'Current password and new password required');
        }
        const result = changePassword(auth.username, body.currentPassword, body.newPassword);
        if ('error' in result) return error(res, result.error!, result.status!);
        if (isAdmin(auth.username)) projectAdministratorsToEverySuitcase(auth.username);
        return json(res, { message: 'Password changed' });
      }

      if (path === '/api/suitcases/access-proof' && method === 'POST') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        if (process.env.DEPLOY_SUITCASE !== '1') {
          return json(res, { applicable: false, ready: false });
        }
        const proof = recordSuitcaseClientAccess({
          siteId: resolveLocalSiteId(),
          actor: auth.username,
          hostHeader: String(req.headers.host || ''),
          remoteAddress: String(req.socket.remoteAddress || ''),
        });
        return json(res, { applicable: true, ...proof });
      }

      // ── Suitcase fleet transport ────────────────────────────────────────

      if (path.startsWith('/api/fleet/') && (method === 'GET' || method === 'POST')) {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const body =
          method === 'POST'
            ? JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}')
            : undefined;
        const result = await handleFleetRequest({
          method,
          pathname: path.slice('/api'.length) + url.search,
          body,
          actor: { username: auth.username, role: 'admin' },
        });
        return json(res, result.body, result.status);
      }

      if (path.startsWith('/api/operations/') && (method === 'GET' || method === 'POST')) {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        let body: unknown;
        if (method === 'POST') {
          const source = (await readBody(req, 1024 * 1024)).toString();
          try {
            body = source ? JSON.parse(source) : {};
          } catch {
            return error(res, 'Request body must be valid JSON', 400);
          }
        }
        const result = await handleOperationsRequest({
          method,
          pathname: path.slice('/api'.length) + url.search,
          body,
          actor: { username: auth.username, role: 'admin' },
        });
        return json(res, result.body, result.status);
      }

      if (path === '/api/suitcases/pairing' && method === 'POST') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<
          string,
          unknown
        >;
        try {
          return json(
            res,
            createSuitcasePairing({
              name: String(body.name || ''),
              defaultDataPolicy:
                body.defaultDataPolicy === 'automatic' ||
                body.defaultDataPolicy === 'manual' ||
                body.defaultDataPolicy === 'none'
                  ? body.defaultDataPolicy
                  : undefined,
              accessMode:
                body.accessMode === 'existing-lan' ||
                body.accessMode === 'host-hotspot' ||
                body.accessMode === 'linux-access-point'
                  ? body.accessMode
                  : undefined,
              securityProfile:
                body.securityProfile === 'isolated' || body.securityProfile === 'trusted-lan'
                  ? body.securityProfile
                  : undefined,
              createdBy: auth.username,
            }),
            201,
          );
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      if (path === '/api/suitcases/pair' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<
          string,
          unknown
        >;
        if (Number(body.protocolVersion) !== MULTISITE_PROTOCOL_VERSION) {
          return suitcaseProtocolFailure(
            res,
            new SuitcaseProtocolError(
              `Suitcase protocol ${MULTISITE_PROTOCOL_VERSION} is required`,
              426,
              'protocol_version_mismatch',
            ),
          );
        }
        try {
          const intermediateCsr = String(body.intermediateCsr || '');
          // Validate before consuming the one-time code. Signing happens only
          // after redemption, so an invalid code cannot obtain a certificate.
          validateSuitcaseIntermediateCsr(intermediateCsr);
          const paired = redeemSuitcasePairing({
            code: String(body.code || ''),
            publicKey: String(body.publicKey || ''),
            platform: String(body.platform || ''),
            architecture: String(body.architecture || ''),
            version: String(body.version || ''),
            capabilities:
              body.capabilities && typeof body.capabilities === 'object'
                ? (body.capabilities as Record<string, unknown>)
                : undefined,
            nodeId: typeof body.targetId === 'string' ? body.targetId : undefined,
          });
          const delegatedTrust = signSuitcaseIntermediateCertificate(intermediateCsr);
          const fleet = ensureFleetIdentity();
          const administratorProjection = projectAdministratorsToSite(paired.siteId, 'pairing');
          return json(
            res,
            {
              ...paired,
              homeSiteId: fleet.homeSiteId,
              rootPublicIdentity: fleet.rootPublicIdentity,
              ...delegatedTrust,
              administratorProjection,
            },
            201,
          );
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      if (path === '/api/suitcases/topology' && method === 'GET') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        try {
          return json(res, fleetTopologyWithSync());
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      if (path === '/api/suitcases/credentials/rotation' && method === 'POST') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<
          string,
          unknown
        >;
        try {
          return json(
            res,
            requestSiteCredentialRotation({
              siteId: typeof body.siteId === 'string' && body.siteId ? body.siteId : undefined,
              actor: auth.username,
            }),
          );
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      if (
        (path === '/api/suitcases/recovery/readopt' ||
          path === '/api/suitcases/credentials/complete') &&
        method === 'POST'
      ) {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}') as Record<
          string,
          unknown
        >;
        try {
          return json(
            res,
            completeSiteCredentialProof({
              siteId: String(req.headers['x-deploy-site-id'] || ''),
              credential: String(req.headers['x-deploy-site-credential'] || ''),
              proof: body.proof,
              signature: typeof body.signature === 'string' ? body.signature : '',
              expectedPurpose:
                path === '/api/suitcases/recovery/readopt'
                  ? 'home-recovery-readoption'
                  : 'credential-rotation',
            }),
          );
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      const suitcaseRevokeMatch = path.match(/^\/api\/suitcases\/([^/]+)\/revoke$/);
      if (suitcaseRevokeMatch && method === 'POST') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<
          string,
          unknown
        >;
        try {
          revokeSite(
            decodeURIComponent(suitcaseRevokeMatch[1]),
            typeof body.reason === 'string' ? body.reason : `Revoked by ${auth.username}`,
          );
          return json(res, { message: 'Suitcase credential revoked' });
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      const suitcaseAccessMatch = path.match(/^\/api\/suitcases\/([^/]+)\/access$/);
      if (suitcaseAccessMatch && method === 'GET') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        try {
          return json(res, suitcaseAccessDiagnostics(decodeURIComponent(suitcaseAccessMatch[1])));
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      if (path === '/api/suitcases/presence' && method === 'POST') {
        const site = requireSuitcaseSite(req, res);
        if (!site) return;
        const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<
          string,
          unknown
        >;
        if (Number(body.protocolVersion) !== MULTISITE_PROTOCOL_VERSION) {
          return suitcaseProtocolFailure(
            res,
            new SuitcaseProtocolError(
              `Suitcase protocol ${MULTISITE_PROTOCOL_VERSION} is required`,
              426,
              'protocol_version_mismatch',
            ),
          );
        }
        try {
          const mode = String(body.mode || '');
          if (mode !== 'docked' && mode !== 'away' && mode !== 'rejoining') {
            throw new SuitcaseProtocolError('Presence mode must be docked, away, or rejoining');
          }
          updateSitePresence({
            siteId: site.siteId,
            mode,
            capabilities:
              body.capabilities && typeof body.capabilities === 'object'
                ? (body.capabilities as Record<string, unknown>)
                : undefined,
            readiness:
              body.readiness && typeof body.readiness === 'object'
                ? (body.readiness as Record<string, unknown>)
                : undefined,
            networkFingerprint:
              typeof body.networkFingerprint === 'string' ? body.networkFingerprint : undefined,
          });
          return json(res, { siteId: site.siteId, mode, protocolVersion: site.protocolVersion });
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      if (path === '/api/suitcases/sync/status' && method === 'GET') {
        const site = requireSuitcaseSite(req, res);
        if (!site) return;
        try {
          return json(res, suitcaseSyncStatus(site.siteId));
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      if (path === '/api/suitcases/sync/exchange' && method === 'POST') {
        const site = requireSuitcaseSite(req, res);
        if (!site) return;
        const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString() || '{}');
        try {
          await collectLocalFleetTelemetry({ fleetId: site.fleetId, siteId: site.homeSiteId });
          const exchange = exchangeSuitcaseEvents(site, body);
          const reconciliation = await reconcilePendingChangesets({
            originSiteId: site.siteId,
            explicitManual: body.manualSync === true,
            applicationIds: Array.isArray(body.manualSyncAppIds)
              ? new Set(
                  body.manualSyncAppIds.filter(
                    (appId: unknown): appId is string => typeof appId === 'string',
                  ),
                )
              : undefined,
          });
          const writerTransfers = await processLocalOpaqueVolumeAuthorityTransfers({
            localSiteId: site.homeSiteId,
          });
          const catalogCompletions = await catalogService.reconcileRuntime(catalogRuntime);
          return json(res, {
            ...exchange,
            reconciliation,
            writerTransfers,
            catalogCompletions,
          });
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      const suitcaseArtifactBeginMatch = path.match(
        /^\/api\/suitcases\/sync\/artifacts\/([^/]+)\/begin$/,
      );
      if (suitcaseArtifactBeginMatch && method === 'POST') {
        const site = requireSuitcaseSite(req, res);
        if (!site) return;
        const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<
          string,
          unknown
        >;
        try {
          return json(
            res,
            beginSuitcaseArtifactUpload(site, {
              digest: decodeURIComponent(suitcaseArtifactBeginMatch[1]),
              expectedSize: Number(body.expectedSize),
            }),
            201,
          );
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      const suitcaseArtifactMatch = path.match(/^\/api\/suitcases\/sync\/artifacts\/([^/]+)$/);
      if (suitcaseArtifactMatch && method === 'PUT') {
        const site = requireSuitcaseSite(req, res);
        if (!site) return;
        try {
          const bytes = await readBody(req, MAX_ARTIFACT_CHUNK_BYTES);
          return json(
            res,
            await appendSuitcaseArtifactChunk(site, {
              transferId: String(url.searchParams.get('transferId') || ''),
              digest: decodeURIComponent(suitcaseArtifactMatch[1]),
              offset: Number(url.searchParams.get('offset')),
              bytes,
              metadata: {
                type: String(req.headers['x-deploy-artifact-type'] || 'portable'),
                mediaType: String(
                  req.headers['x-deploy-artifact-media-type'] || 'application/octet-stream',
                ),
                retentionClass:
                  req.headers['x-deploy-artifact-retention'] === 'release' ||
                  req.headers['x-deploy-artifact-retention'] === 'checkpoint' ||
                  req.headers['x-deploy-artifact-retention'] === 'recovery'
                    ? req.headers['x-deploy-artifact-retention']
                    : 'temporary',
              },
            }),
          );
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      if (suitcaseArtifactMatch && method === 'GET') {
        const site = requireSuitcaseSite(req, res);
        if (!site) return;
        try {
          const chunk = readSuitcaseArtifactChunk(
            site,
            decodeURIComponent(suitcaseArtifactMatch[1]),
            Number(url.searchParams.get('offset') || 0),
            Number(url.searchParams.get('limit') || MAX_ARTIFACT_CHUNK_BYTES),
          );
          res.writeHead(200, {
            'Content-Type': chunk.mediaType,
            'Content-Length': chunk.bytes.length,
            'Access-Control-Allow-Origin': '*',
            'X-Deploy-Artifact-Digest': chunk.digest,
            'X-Deploy-Artifact-Offset': String(chunk.offset),
            'X-Deploy-Artifact-Next-Offset': String(chunk.nextOffset),
            'X-Deploy-Artifact-Size': String(chunk.totalSize),
            'X-Deploy-Artifact-Complete': chunk.complete ? '1' : '0',
          });
          res.end(chunk.bytes);
          return;
        } catch (err) {
          return suitcaseProtocolFailure(res, err);
        }
      }

      // ── Fleet enrollment and node administration ───────────────────────

      if (path === '/api/agent/enroll' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.code) return error(res, 'Enrollment code required');
        const result = redeemNodeEnrollment({
          code: String(body.code),
          name: typeof body.name === 'string' ? body.name : undefined,
          platform: typeof body.platform === 'string' ? body.platform : undefined,
          architecture: typeof body.architecture === 'string' ? body.architecture : undefined,
          agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion : undefined,
          address: remoteAddress(req),
          capabilities:
            body.capabilities && typeof body.capabilities === 'object'
              ? body.capabilities
              : undefined,
        });
        if ('error' in result && result.error) return error(res, result.error, 400);
        return json(res, result, 201);
      }

      if (path === '/api/agent/heartbeat' && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const advertisedAddress =
          typeof body.address === 'string' && isIP(body.address) === 4
            ? body.address
            : remoteAddress(req);
        const node = heartbeatNode(nodeId!, {
          platform: typeof body.platform === 'string' ? body.platform : undefined,
          architecture: typeof body.architecture === 'string' ? body.architecture : undefined,
          agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion : undefined,
          address: advertisedAddress,
          capabilities:
            body.capabilities && typeof body.capabilities === 'object'
              ? body.capabilities
              : undefined,
        });
        if (Array.isArray(body.capabilities?.apps)) {
          reconcileNodeRuntimePorts(nodeId!, body.capabilities.apps);
        }
        return json(res, { ok: true, node });
      }

      if (path === '/api/agent/jobs/claim' && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const job = claimAgentJob(nodeId!);
        if (!job) {
          res.writeHead(204);
          res.end();
          return;
        }
        updateAgentActivity(
          job.id,
          { stage: 'starting' },
          `Started ${job.type} for ${job.deploymentName}`,
        );
        return json(res, {
          id: job.id,
          type: job.type,
          deploymentName: job.deploymentName,
          payload: JSON.parse(job.payload),
          artifactUrl: job.artifactPath ? `/api/agent/jobs/${job.id}/artifact` : null,
        });
      }

      if (path === '/api/agent/exec/claim' && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const session = claimAgentExecSession(nodeId!);
        if (!session) {
          res.writeHead(204);
          res.end();
          return;
        }
        return json(res, session);
      }

      const agentExecPollMatch = path.match(/^\/api\/agent\/exec\/([^/]+)\/poll$/);
      if (agentExecPollMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const control = pollAgentExecSession(agentExecPollMatch[1], nodeId!);
        if (!control) return error(res, 'Terminal session not found', 404);
        return json(res, control);
      }

      const agentExecOutputMatch = path.match(/^\/api\/agent\/exec\/([^/]+)\/output$/);
      if (agentExecOutputMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (
          !writeAgentExecOutput(
            agentExecOutputMatch[1],
            nodeId!,
            typeof body.output === 'string' ? body.output : '',
          )
        ) {
          return error(res, 'Terminal session not found', 404);
        }
        return json(res, { ok: true });
      }

      const agentExecExitMatch = path.match(/^\/api\/agent\/exec\/([^/]+)\/exit$/);
      if (agentExecExitMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        closeAgentExecSession(agentExecExitMatch[1], nodeId!, {
          code: Number.isInteger(body.code) ? body.code : null,
          error: typeof body.error === 'string' ? body.error : undefined,
        });
        return json(res, { ok: true });
      }

      const agentJobArtifactMatch = path.match(/^\/api\/agent\/jobs\/([^/]+)\/artifact$/);
      if (agentJobArtifactMatch && method === 'GET') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const job = getAgentJob(agentJobArtifactMatch[1]);
        if (!job || job.nodeId !== nodeId || !job.artifactPath || !existsSync(job.artifactPath)) {
          return error(res, 'Artifact not found', 404);
        }
        const stat = statSync(job.artifactPath);
        const rangeHeader = req.headers.range;
        const rangeMatch =
          typeof rangeHeader === 'string' ? rangeHeader.match(/^bytes=(\d+)-$/) : null;
        const startByte = rangeMatch ? Number(rangeMatch[1]) : 0;
        if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte >= stat.size) {
          res.writeHead(416, {
            'Content-Range': `bytes */${stat.size}`,
            'Accept-Ranges': 'bytes',
          });
          res.end();
          return;
        }
        const partial = startByte > 0;
        res.writeHead(partial ? 206 : 200, {
          'Content-Type': 'application/gzip',
          'Content-Length': stat.size - startByte,
          'Accept-Ranges': 'bytes',
          ...(partial
            ? { 'Content-Range': `bytes ${startByte}-${stat.size - 1}/${stat.size}` }
            : {}),
        });
        const artifactStream = createReadStream(job.artifactPath, { start: startByte });
        if (job.type === 'restore') {
          let processedBytes = startByte;
          let lastReportedAt = 0;
          const report = (force = false) => {
            const now = Date.now();
            if (!force && now - lastReportedAt < 500) return;
            lastReportedAt = now;
            reportMigrationProgress(job.deploymentName, {
              phase: 'restoring',
              stage: 'transferring',
              processedBytes,
              totalBytes: stat.size,
            });
            updateAgentActivity(job.id, {
              stage: 'downloading backup',
              processedBytes,
              totalBytes: stat.size,
            });
          };
          artifactStream.on('data', (chunk) => {
            processedBytes += chunk.length;
            report();
          });
          artifactStream.on('end', () => {
            report(true);
            reportMigrationProgress(job.deploymentName, {
              phase: 'restoring',
              stage: 'extracting',
              processedBytes: stat.size,
              totalBytes: stat.size,
            });
            updateAgentActivity(
              job.id,
              {
                stage: 'extracting backup',
                processedBytes: 0,
                totalBytes: stat.size,
              },
              'Backup download complete; extracting archive',
            );
          });
        } else if (job.type === 'deploy') {
          let processedBytes = startByte;
          let lastReportedAt = 0;
          const report = (force = false) => {
            const now = Date.now();
            if (!force && now - lastReportedAt < 500) return;
            lastReportedAt = now;
            updateAgentActivity(job.id, {
              stage: 'downloading source',
              processedBytes,
              totalBytes: stat.size,
            });
          };
          artifactStream.on('data', (chunk) => {
            processedBytes += chunk.length;
            report();
          });
          artifactStream.on('end', () => {
            report(true);
            updateAgentActivity(
              job.id,
              {
                stage: 'unpacking source',
                processedBytes: stat.size,
                totalBytes: stat.size,
              },
              'Source download complete; unpacking application',
            );
          });
        }
        artifactStream.pipe(res);
        return;
      }

      const agentJobCompleteMatch = path.match(/^\/api\/agent\/jobs\/([^/]+)\/complete$/);
      if (agentJobCompleteMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const body = JSON.parse((await readBody(req)).toString());
        try {
          completeAgentJob(agentJobCompleteMatch[1], nodeId!, {
            success: body.success === true,
            result: body.result && typeof body.result === 'object' ? body.result : undefined,
            error: typeof body.error === 'string' ? body.error : undefined,
          });
          updateAgentActivity(
            agentJobCompleteMatch[1],
            { stage: body.success === true ? 'complete' : 'failed' },
            body.success === true
              ? 'Job completed'
              : `Job failed: ${typeof body.error === 'string' ? body.error : 'unknown error'}`,
          );
          return json(res, { ok: true });
        } catch (err) {
          return error(res, (err as Error).message, 404);
        }
      }

      const agentJobProgressMatch = path.match(/^\/api\/agent\/jobs\/([^/]+)\/progress$/);
      if (agentJobProgressMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const job = getAgentJob(agentJobProgressMatch[1]);
        if (!job || job.nodeId !== nodeId) return error(res, 'Job not found', 404);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const processedBytes = Math.max(0, Number(body.processedBytes || 0));
        const totalBytes = Math.max(0, Number(body.totalBytes || 0));
        const stage = String(body.stage || 'working').slice(0, 80);
        updateAgentActivity(
          job.id,
          { stage, processedBytes, totalBytes },
          typeof body.message === 'string' ? body.message.slice(0, 500) : undefined,
        );
        const buildOutput =
          job.type === 'deploy' && typeof body.output === 'string'
            ? body.output.slice(0, 512 * 1024)
            : '';
        if (buildOutput) {
          const payload = JSON.parse(job.payload) as { buildLogId?: number };
          const buildLogId = Number(payload.buildLogId);
          if (Number.isSafeInteger(buildLogId) && buildLogId > 0) {
            appendFileSync(buildLogFilePath(buildLogId), buildOutput);
            agentJobsWithStreamedBuildOutput.add(job.id);
            for (const outputLine of buildOutput.split('\n')) {
              if (!outputLine) continue;
              const timestampedLine = outputLine.match(/^\[([^\]]+)]\s?(.*)$/);
              emit({
                type: 'build:output',
                deploymentName: job.deploymentName,
                data: {
                  line: timestampedLine?.[2] ?? outputLine,
                  timestamp: timestampedLine?.[1] ?? new Date().toISOString(),
                },
              });
            }
          }
        }
        if (job.type === 'restore') {
          reportMigrationProgress(job.deploymentName, {
            phase: 'restoring',
            stage: 'extracting',
            processedBytes,
            totalBytes,
          });
        }
        return json(res, { ok: true });
      }

      const agentJobBackupMatch = path.match(/^\/api\/agent\/jobs\/([^/]+)\/backup$/);
      if (agentJobBackupMatch && method === 'PUT') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const job = getAgentJob(agentJobBackupMatch[1]);
        if (!job || job.nodeId !== nodeId || job.type !== 'backup') {
          return error(res, 'Backup job not found', 404);
        }
        const payload = JSON.parse(job.payload) as {
          label?: string;
          createdBy?: string;
          relatedBuildLogId?: number | null;
          auto?: boolean;
        };
        const timestamp = new Date().toISOString();
        const safeTimestamp = timestamp.replace(/[:.]/g, '-');
        const label = String(payload.label || 'scheduled').replace(/[^a-zA-Z0-9-]/g, '_');
        const filename = `${safeTimestamp}-${label}.tar.gz`;
        const backupDir = getBackupDir(job.deploymentName);
        const temporaryPath = resolve(backupDir, `.${job.id}.partial`);
        const finalPath = resolve(backupDir, filename);
        try {
          await new Promise<void>((resolvePromise, rejectPromise) => {
            const output = createWriteStream(temporaryPath, { flags: 'wx' });
            const totalBytes = Number(req.headers['content-length'] || 0);
            let processedBytes = 0;
            let lastReportedAt = 0;
            req.on('data', (chunk: Buffer) => {
              processedBytes += chunk.length;
              const now = Date.now();
              if (now - lastReportedAt < 500 && processedBytes !== totalBytes) return;
              lastReportedAt = now;
              reportMigrationProgress(job.deploymentName, {
                phase: 'backing-up',
                stage: 'transferring',
                processedBytes,
                totalBytes,
              });
              updateAgentActivity(job.id, {
                stage: 'uploading backup',
                processedBytes,
                totalBytes,
              });
            });
            req.pipe(output);
            output.on('finish', resolvePromise);
            output.on('error', rejectPromise);
            req.on('error', rejectPromise);
          });
          await rename(temporaryPath, finalPath);
          const sizeBytes = statSync(finalPath).size;
          saveBackup({
            deploymentName: job.deploymentName,
            filename,
            label,
            sizeBytes,
            createdBy: payload.createdBy || 'agent',
            createdAt: timestamp,
            volumePaths: ['data', 'uploads'],
            relatedBuildLogId: payload.relatedBuildLogId ?? null,
            auto: payload.auto === true,
          });
          return json(res, { filename, sizeBytes, timestamp, volumePaths: ['data', 'uploads'] });
        } catch (err) {
          await rm(temporaryPath, { force: true }).catch(() => {});
          return error(res, `Backup upload failed: ${(err as Error).message}`, 500);
        }
      }

      if (path === '/api/nodes' && method === 'GET') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const fleet = getFleetPlacementState();
        const coordinatorApps = await getDeploymentContainerStatuses();
        return json(res, {
          ...fleet,
          nodes: fleet.nodes.map((node) => {
            if (node.kind === 'coordinator') return { ...node, apps: coordinatorApps };
            try {
              const capabilities = JSON.parse(node.capabilities || '{}') as {
                apps?: unknown[];
              };
              return {
                ...node,
                apps: Array.isArray(capabilities.apps) ? capabilities.apps : [],
                jobs: getRecentAgentJobs(node.id).map((job) => ({
                  id: job.id,
                  type: job.type,
                  deploymentName: job.deploymentName,
                  status: job.status,
                  createdAt: job.createdAt,
                  claimedAt: job.claimedAt,
                  completedAt: job.completedAt,
                  error: job.error,
                  activity: agentActivityByJob.get(job.id) || null,
                })),
              };
            } catch {
              return {
                ...node,
                apps: [],
                jobs: getRecentAgentJobs(node.id).map((job) => ({
                  id: job.id,
                  type: job.type,
                  deploymentName: job.deploymentName,
                  status: job.status,
                  createdAt: job.createdAt,
                  claimedAt: job.claimedAt,
                  completedAt: job.completedAt,
                  error: job.error,
                  activity: agentActivityByJob.get(job.id) || null,
                })),
              };
            }
          }),
        });
      }

      if (path === '/api/nodes/enrollment' && method === 'POST') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString());
        try {
          return json(res, createNodeEnrollment(String(body.name || ''), auth.username), 201);
        } catch (err) {
          return error(res, (err as Error).message);
        }
      }

      if (path === '/api/nodes/default' && method === 'PUT') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString());
        try {
          return json(res, { node: setDefaultNode(String(body.nodeId || '')) });
        } catch (err) {
          return error(res, (err as Error).message);
        }
      }

      const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)$/);
      if (nodeMatch && method === 'DELETE') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        try {
          revokeNode(decodeURIComponent(nodeMatch[1]));
          return json(res, { message: 'Node access revoked' });
        } catch (err) {
          return error(res, (err as Error).message);
        }
      }

      // ── Upload / Deploy ─────────────────────────────────────────────────

      if (path === '/api/upload' && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const { username } = auth;

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
        const uploadsDir = getUploadsDir();
        const tmpFile = resolve(
          uploadsDir,
          `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`,
        );
        let deployDir: string | null = null;
        let fileFinished: Promise<void> | null = null;
        let sawFile = false;
        let deployLease: DeployLease | null = null;
        let artifactPath: string | null = null;
        let uploadLimitError: UploadArchiveError | null = null;
        let clientAborted = false;
        let repositoryRevisionUnchanged = false;
        let repositoryRuntimeCanBeSkipped = false;
        let repositorySourceChanged = false;
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
            bb.on('filesLimit', () => recordUploadLimit('Only one deployment archive is allowed'));
            bb.on('fieldsLimit', () =>
              recordUploadLimit('Deployment upload contains too many form fields'),
            );
            bb.on('partsLimit', () =>
              recordUploadLimit('Deployment upload contains too many multipart sections'),
            );

            const onClose = async () => {
              // Wait for accepted bytes to flush before inspecting or removing the
              // bounded temporary file.
              if (fileFinished) await fileFinished;
              if (uploadLimitError) throw uploadLimitError;
              if (!sawFile) throw new Error('No file uploaded');
              if (!fields.name) throw new Error('Missing deployment name');

              const name = fields.name.toLowerCase();
              if (!DEPLOYMENT_NAME_PATTERN.test(name)) {
                throw Object.assign(
                  new Error(
                    'Deployment name must start with a letter and contain only lowercase letters, numbers, or hyphens (maximum 63 characters).',
                  ),
                  { status: 400 },
                );
              }
              const existingDeployment = getDeployment(name);
              if (existingDeployment && existingDeployment.username !== username) {
                throw Object.assign(new Error('Deployment name is already in use'), {
                  status: 409,
                });
              }

              if (!getFleetPlacementState().ready) {
                throw Object.assign(
                  new Error(
                    'Choose a default deployment node in the Nodes dashboard before deploying.',
                  ),
                  { status: 428 },
                );
              }

              if (existingDeployment?.status && MIGRATION_STATES.has(existingDeployment.status)) {
                throw Object.assign(
                  new Error(
                    `Migration in progress for ${name}. Wait for it to finish before deploying again.`,
                  ),
                  { status: 409 },
                );
              }

              await inspectUploadArchive(tmpFile);
              deployLease = await acquireDeploySlot(name, username, (position) => {
                if (position > 0) {
                  emit({
                    type: 'deployment:queued',
                    deploymentName: name,
                    data: { position, username },
                  });
                }
              });
              if (clientAborted) {
                deployLease.release();
                deployLease = null;
                throw new Error('Upload cancelled while waiting for a build slot');
              }
              const finalDeployDir = resolve(uploadsDir, name);
              const stagingDir = await mkdtemp(resolve(uploadsDir, '.extract-'));
              const displacedDir = resolve(uploadsDir, `.previous-${name}-${basename(stagingDir)}`);

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
                if (stagedDefinition.format === 'deploy.yaml') {
                  const manifestSource = readFileSync(resolve(stagingDir, 'deploy.yaml'), 'utf8');
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
                  if (
                    requiresFleetAcknowledgement(
                      repositoryChangePlan,
                      stagedDefinition.compiled.spec,
                    ) &&
                    existingDeployment
                  ) {
                    const applicationId =
                      existingDeployment.appId || registerApplicationIdentity(name);
                    assertFleetMutationReady({
                      appId: applicationId,
                      applicationName: name,
                      kind: 'destructive-graph-change',
                      mutationFingerprint: destructiveGraphMutationFingerprint(
                        applicationId,
                        stagedDefinition.compiled.digest,
                      ),
                      consequence:
                        'This repository revision removes or incompatibly changes application graph state. Every selected suitcase must sync and acknowledge this exact revision before source or desired graph state changes.',
                      actor: username,
                    });
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
                  await rm(displacedDir, { recursive: true, force: true }).catch((cleanupError) =>
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
              repositorySourceChanged = Boolean(
                existingDeployment?.sourceArtifactDigest &&
                existingDeployment.sourceArtifactDigest !== sourceArtifact.digest,
              );
              repositoryRuntimeCanBeSkipped = repositoryUploadCanSkipRuntime({
                revisionUnchanged: repositoryRevisionUnchanged,
                desiredDigest: existingDeployment?.desiredSpecDigest || null,
                activeDigest: existingDeployment?.activeSpecDigest || null,
                previousSourceArtifactDigest: existingDeployment?.sourceArtifactDigest || null,
                nextSourceArtifactDigest: sourceArtifact.digest,
              });
              updateDeploymentArtifactDigests(name, {
                sourceArtifactDigest: sourceArtifact.digest,
              });
              const retainedArtifacts = readdirSync(artifactDir)
                .filter((filename) => /^\d+\.tar\.gz$/.test(filename))
                .sort((left, right) => Number(right.slice(0, -7)) - Number(left.slice(0, -7)));
              for (const expiredArtifact of retainedArtifacts.slice(SOURCE_ARTIFACT_RETENTION)) {
                await rm(resolve(artifactDir, expiredArtifact), { force: true }).catch(
                  (cleanupError) =>
                    console.warn(
                      `Unable to prune retained source artifact for ${name}:`,
                      cleanupError,
                    ),
                );
              }
            };
            bb.on('close', () => {
              onClose().then(
                () => resolveP(),
                (err) => rejectP(err),
              );
            });

            bb.on('error', rejectP);
            req.pipe(bb);
          });
        } catch (uploadErr) {
          (deployLease as DeployLease | null)?.release();
          await rm(tmpFile, { force: true }).catch(() => {});
          if (uploadErr instanceof FleetMutationBlockedError) {
            return fleetMutationBlocked(res, uploadErr, { plan: repositoryChangePlan });
          }
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

        if (graphDeployment && repositoryRuntimeCanBeSkipped && previousDeployment) {
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
        const appendOrchestrationLog = (message: string) => {
          const timestamp = new Date().toISOString();
          appendFileSync(buildLogFilePath(orchestrationBuildLogId), `[${timestamp}] ${message}\n`);
          emit({
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
        emit({
          type: 'deployment:status',
          deploymentName: name,
          data: { status: 'uploading', username },
        });
        appendOrchestrationLog('Source artifact accepted by the coordinator');

        const executeDeployment = async () => {
          // Cache deployment lookup to avoid redundant DB queries
          const cachedDeployment = getDeployment(name);
          const placement = getFleetPlacementState();
          const targetNodeId = cachedDeployment?.desiredNodeId || placement.defaultNodeId;
          const targetNode = targetNodeId ? getNode(targetNodeId) : null;
          if (!targetNode) {
            throw Object.assign(
              new Error(
                'Choose a default deployment node in the Nodes dashboard before deploying.',
              ),
              { status: 428 },
            );
          }

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
              emit({
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
              emit({
                type: 'build:complete',
                deploymentName: name,
                data: { success: true, duration },
              });
              updateDeploymentStatus(name, CONFIGURATION_REQUIRED_STATUS);
              appendOrchestrationLog(
                `Build completed; runtime activation is waiting for: ${resolvedConfiguration.missing.join(', ')}`,
              );
              emit({
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
            emit({
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
                if (!relocationBackupFilename) throw new Error('Backup filename was not returned');
                relocationVolumeSizeBytes = Number(backup.volumeSizeBytes || backup.sizeBytes || 0);
              }
            } catch (backupErr) {
              if (movingBetweenNodes) {
                updateDeploymentStatus(name, 'failed');
                emit({
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
            emit({
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
            emit({
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
                        writerSiteId: applicationWriterSiteId(applicationId),
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
            emit({
              type: 'build:complete',
              deploymentName: name,
              data: { success: finishedJob.status === 'complete', duration: buildDuration },
            });

            if (finishedJob.status === 'failed') {
              updateDeploymentStatus(name, 'failed');
              appendOrchestrationLog(finishedJob.error || 'Remote build failed');
              emit({
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
            publishActivatedApplicationRevision(name, username);
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
            emit({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: 'running', username, type, port, nodeId: targetNode.id },
            });
            emit({
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
            appendOrchestrationLog('Materializing application component graph on the coordinator');
            emit({
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
              writerSiteId: applicationWriterSiteId(applicationId),
              memoryLimit: cachedDeployment?.memoryLimit || '4g',
              cpuLimit: cachedDeployment?.cpuLimit || undefined,
              noCache: fields.noCache === '1' || fields.noCache === 'true',
              forceReplace: repositorySourceChanged,
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
            publishActivatedApplicationRevision(name, username);
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
            emit({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: 'running', username, type, port: materialized.primaryPort },
            });
            emit({
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
          emit({
            type: 'deployment:status',
            deploymentName: name,
            data: { status: 'building', username },
          });

          console.log(`Building ${name} (${type})...`);
          const buildLogId = orchestrationBuildLogId;
          // Build output goes straight to an append-only file. The old flow
          // accumulated the whole log in a string and rewrote the entire DB
          // column every 2s — O(n²) writes for chatty builds.
          const buildLogStream = createWriteStream(buildLogFilePath(buildLogId), { flags: 'a' });
          const buildStartedMs = Date.now();
          let buildResult: Awaited<ReturnType<typeof buildImage>> | null = null;
          try {
            const noCache = fields.noCache === '1' || fields.noCache === 'true';
            buildResult = await buildImage(
              name,
              deploymentDirectory,
              (line, timestamp) => {
                buildLogStream.write(`[${timestamp}] ${line}\n`);
                emit({ type: 'build:output', deploymentName: name, data: { line, timestamp } });
              },
              { noCache },
            );

            buildLogStream.end();
            emit({
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
            emit({
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
            emit({
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
          emit({
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
                console.log(`[deploy] Renamed ${canonicalName} -> ${prevName} for blue/green swap`);
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
            publishActivatedApplicationRevision(name, username);

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

            emit({
              type: 'deployment:status',
              deploymentName: name,
              data: { status: 'running', username, type, port },
            });
            emit({
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
            emit({
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
              name,
              buildLogId: orchestrationBuildLogId,
              status: 'uploading',
              dashboardUrl: `/dashboard/${encodeURIComponent(name)}/build`,
            },
            202,
          );
          void executeDeployment()
            .catch((deployErr) => {
              const failureStatus = deploymentErrorStatus(deployErr);
              updateDeploymentStatus(name, failureStatus);
              appendOrchestrationLog(
                `Deployment failed: ${(deployErr as Error).message || String(deployErr)}`,
              );
              completeBuildLog(orchestrationBuildLogId, {
                success: false,
                duration: Date.now() - deployStartedAtMs,
              });
              emit({
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
          const failureStatus = deploymentErrorStatus(deployErr);
          updateDeploymentStatus(name, failureStatus);
          appendOrchestrationLog(
            `Deployment failed: ${(deployErr as Error).message || String(deployErr)}`,
          );
          completeBuildLog(orchestrationBuildLogId, {
            success: false,
            duration: Date.now() - deployStartedAtMs,
          });
          emit({
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
      }

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

      if (path === '/api/deploy-admission' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const placement = getFleetPlacementState();
        return json(res, {
          ...getDeployAdmissionState(auth.username),
          placementReady: placement.ready,
          defaultNode: placement.defaultNode,
          nodes: placement.nodes,
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
        return json(res, {
          applicationId: deployment.appId,
          desiredDigest: deployment.desiredSpecDigest,
          activeDigest: deployment.activeSpecDigest,
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
                  writerSiteId: applicationWriterSiteId(deployment.appId || name),
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
              writerSiteId: applicationWriterSiteId(deployment.appId || name),
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
              writerSiteId: applicationWriterSiteId(deployment.appId || name),
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

      const deployPatchMatch = path.match(/^\/api\/deployments\/([^/]+)\/deploy\.patch\.yaml$/);
      if (deployPatchMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = deployPatchMatch[1].toLowerCase();
        const deployment = getDeployment(name);
        if (!deployment || deployment.username !== auth.username) {
          return error(res, 'Not found', 404);
        }
        const digest = deployment.desiredSpecDigest || deployment.activeSpecDigest;
        const revision = digest ? getApplicationSpecRevision(name, digest) : null;
        if (!revision || !digest) return error(res, 'Application manifest not found', 404);
        const parentRevision = revision.parentDigest
          ? getApplicationSpecRevision(name, revision.parentDigest)
          : null;
        const patch = renderParentRelativeApplicationPatch({
          applicationName: name,
          parentDigest: revision.parentDigest,
          targetDigest: digest,
          parent: parentRevision ? parseStoredApplicationSpec(parentRevision.normalizedSpec) : null,
          target: parseStoredApplicationSpec(revision.normalizedSpec),
        });
        res.writeHead(200, {
          'Content-Type': 'application/yaml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}-deploy.patch.yaml"`,
          'Content-Length': Buffer.byteLength(patch),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(patch);
        return;
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
                    writerSiteId: applicationWriterSiteId(deployment.appId || name),
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
                writerSiteId: applicationWriterSiteId(applicationId),
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
              writerSiteId: applicationWriterSiteId(applicationId),
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
            writerSiteId: applicationWriterSiteId(deployment.appId || name),
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
            writerSiteId: applicationWriterSiteId(deployment.appId || name),
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
          if (!siteId)
            return error(res, 'Graph deletion requires the target-local site control surface', 409);
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
            data: { status: 'running', username: auth.username },
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

      // ── Container inspect / stats / restart / history ──────────────────

      const inspectMatch = path.match(/^\/api\/deployments\/([^/]+)\/inspect$/);
      if (inspectMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = inspectMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        const info = await getContainerInspectAsync(name);
        if (!info) return error(res, 'Container not found', 404);
        info.started = d.containerStartedAt ?? null;
        return json(res, info);
      }

      const statsMatch = path.match(/^\/api\/deployments\/([^/]+)\/stats$/);
      if (statsMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = statsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        const stats = await getContainerStats(name);
        if (!stats) return error(res, 'Container not running', 404);
        return json(res, stats);
      }

      const restartMatch = path.match(/^\/api\/deployments\/([^/]+)\/restart$/);
      if (restartMatch && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = restartMatch[1];
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
            writerSiteId: applicationWriterSiteId(d.appId || name),
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
          data: { status: 'running', username: auth.username },
        });
        return json(res, { message: `Restarted ${name}` });
      }

      const recreateMatch = path.match(/^\/api\/deployments\/([^/]+)\/recreate$/);
      if (recreateMatch && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = recreateMatch[1].toLowerCase();
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
                writerSiteId: applicationWriterSiteId(d.appId || name),
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
                data: { status: 'running', username: auth.username },
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
              data: { status: 'running', username: auth.username },
            });
            return json(res, { message: `Recreated ${name}` });
          } catch (recreateError) {
            updateDeploymentStatus(name, previousStatus);
            throw recreateError;
          }
        } finally {
          lease.release();
        }
      }

      const historyMatch = path.match(/^\/api\/deployments\/([^/]+)\/history$/);
      if (historyMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = historyMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        return json(res, getDeployHistory(name));
      }

      // ── Live dashboard data ────────────────────────────────────────────

      // Roll-up of every deployment's current health + load: powers the
      // global dashboard's aggregate strip and per-app cards in a single
      // round-trip. Authed only — no per-app authz needed since the user
      // already sees all their apps on the list anyway.
      if (path === '/api/deployments/aggregate' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        return json(res, getDashboardAggregate());
      }

      const healthMatch = path.match(/^\/api\/deployments\/([^/]+)\/health$/);
      if (healthMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = healthMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        return json(res, getCurrentHealth(name));
      }

      const requestSeriesMatch = path.match(/^\/api\/deployments\/([^/]+)\/requests\/series$/);
      if (requestSeriesMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = requestSeriesMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const now = Date.now();
        const fromMs = parseInt(url.searchParams.get('from') || `${now - 3_600_000}`, 10);
        const toMs = parseInt(url.searchParams.get('to') || `${now}`, 10);
        return json(res, getRequestSeries(name, fromMs, toMs));
      }

      const topErrorsMatch = path.match(/^\/api\/deployments\/([^/]+)\/requests\/top-errors$/);
      if (topErrorsMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = topErrorsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const fromMs = parseInt(url.searchParams.get('from') || `${Date.now() - 86_400_000}`, 10);
        const limit = parseInt(url.searchParams.get('limit') || '10', 10);
        return json(res, getTopErrorPaths(name, fromMs, limit));
      }

      // ── Request logs API ───────────────────────────────────────────────

      const requestLogsMatch = path.match(/^\/api\/deployments\/([^/]+)\/requests$/);
      if (requestLogsMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = requestLogsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        return json(res, {
          logs: getRequestLogs(name),
          summary: getRequestSummary(name),
        });
      }

      // ── Backup management ──────────────────────────────────────────────

      // Create backup or list backups
      const backupsMatch = path.match(/^\/api\/deployments\/([^/]+)\/backups$/);
      if (backupsMatch && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = backupsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);

        const body = JSON.parse((await readBody(req)).toString());
        const label = body.label || null;

        let result;
        if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
          result = await dispatchAgentCommand(
            d.activeNodeId,
            'backup',
            name,
            {
              label: label || 'manual',
              createdBy: auth.username,
              relatedBuildLogId: d.currentBuildLogId ?? null,
              auto: false,
            },
            10 * 60_000,
          );
        } else {
          result = await createCoordinatorApplicationBackup(d, label);
          saveBackup({
            deploymentName: name,
            filename: result.filename,
            label,
            sizeBytes: result.sizeBytes,
            createdBy: auth.username,
            createdAt: result.timestamp,
            volumePaths: result.volumePaths,
            relatedBuildLogId: d.currentBuildLogId ?? null,
            auto: false,
          });
        }

        addDeployEvent(name, { action: 'backup', username: auth.username, source: 'ui' });
        return json(res, result, 201);
      }

      if (backupsMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = backupsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);

        const dbBackups = getBackups(name);
        const volumeSize =
          d.activeNodeId && d.activeNodeId !== 'coordinator'
            ? null
            : isCoordinatorApplicationGraph(d)
              ? null
              : getVolumeSize(name);

        return json(res, { backups: dbBackups, volumeSize });
      }

      // Restore backup
      const restoreMatch = path.match(/^\/api\/deployments\/([^/]+)\/backups\/([^/]+)\/restore$/);
      if (restoreMatch && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = restoreMatch[1];
        const filename = decodeURIComponent(restoreMatch[2]);
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        if (basename(filename) !== filename) return error(res, 'Invalid backup filename', 400);

        if (d.activeNodeId && d.activeNodeId !== 'coordinator') {
          const backupPath = resolve(getBackupDir(name), filename);
          if (!existsSync(backupPath)) return error(res, 'Backup file not found', 404);
          await dispatchAgentCommand(d.activeNodeId, 'restore', name, {}, 10 * 60_000, backupPath);
        } else {
          const restored = await restoreCoordinatorApplicationBackup(d, filename);
          if (restored.format === 'legacy') await restartContainer(name);
        }
        recordContainerStart(name);

        addDeployEvent(name, { action: 'restore', username: auth.username, source: 'ui' });
        return json(res, { message: 'Backup restored and container restarted' });
      }

      // Delete backup
      const deleteBackupMatch = path.match(/^\/api\/deployments\/([^/]+)\/backups\/([^/]+)$/);
      if (deleteBackupMatch && method === 'DELETE') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = deleteBackupMatch[1];
        const filename = decodeURIComponent(deleteBackupMatch[2]);
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);

        deleteBackupFile(name, filename);
        deleteBackupRecord(name, filename);

        return json(res, { message: 'Backup deleted' });
      }

      // ── Build Logs ─────────────────────────────────────────────────────

      const buildLogsMatch = path.match(/^\/api\/deployments\/([^/]+)\/build-logs$/);
      if (buildLogsMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = buildLogsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);

        const url = new URL(req.url!, `http://${req.headers.host}`);
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const { rows, total, pageSize } = getBuildLogs(name, page);
        const activeBuild = getActiveBuildLog(name);
        return json(res, {
          logs: rows,
          total,
          page,
          pageSize,
          activeBuild: activeBuild
            ? {
                output: activeBuild.output,
                timestamp: activeBuild.timestamp,
                phase: d.status || 'building',
              }
            : null,
        });
      }

      // ── Not an API route — pass to next middleware ─────────────────────
      next();
    } catch (err: unknown) {
      console.error(err);
      error(
        res,
        (err as Error).message || 'Internal server error',
        err instanceof RequestBodyTooLargeError ? 413 : 500,
      );
    }
  };
}
