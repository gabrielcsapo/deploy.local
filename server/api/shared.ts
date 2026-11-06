import { resolveLocalSiteId } from '../multisite.ts';
import { emit } from '../events.ts';
import { type ServerResponse, type IncomingMessage } from 'node:http';
import { sendJson } from '../http.ts';
import { FleetMutationBlockedError } from '../fleet-mutation-guard.ts';
import {
  authenticate,
  isAdmin,
  getNode,
  enqueueAgentJob,
  getAgentJob,
  cancelQueuedAgentJob,
} from '../store.ts';
import { assertNoCiRelease } from '../ci-releases.ts';
import { assertCiMutation } from '../ci-fence.ts';
import { assertWanderLegacyAllowed } from '../wander-adoption-fence.ts';
import { createConnection } from 'node:net';

// Pre-container states where Docker has no container yet
export const PRE_CONTAINER_STATES = new Set([
  'uploading',
  'backing-up',
  'building',
  'restoring',
  'starting',
  'recreating',
]);

export const CONFIGURATION_REQUIRED_STATUS = 'configuration-required';

export const MIGRATION_STATES = new Set(['backing-up', 'restoring']);

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

export function localGraphSiteFor(deployment: {
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

export const migrationProgressByDeployment = new Map<string, MigrationProgress>();

export const agentJobsWithStreamedBuildOutput = new Set<string>();

export function reportMigrationProgress(
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

// ── Helpers ─────────────────────────────────────────────────────────────────

export function json(res: ServerResponse, data: unknown, status = 200) {
  sendJson(res, data, status, {
    guard: true,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

export function error(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

export function fleetMutationBlocked(
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

// ── Auth ────────────────────────────────────────────────────────────────────
// Supports two transport methods (no behavioral difference, just where the
// secret lives):
//   - Cookie `deploy-sh-auth` set by /api/login — used by the browser so server
//     components can read it via getRequest() on initial render, skipping the
//     usual __action round-trip to fetch dashboard data.
//   - X-Deploy-Username / X-Deploy-Token headers — used by the CLI and by
//     existing client-side `'use server'` calls that pass auth explicitly.
export const AUTH_COOKIE = 'deploy-sh-auth';

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

export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
): { username: string; token: string } | null {
  const { username, token } = getAuth(req);
  if (!authenticate(username, token)) {
    error(res, 'Unauthorized', 401);
    return null;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const app = new URL(req.url || '/', 'https://localhost').pathname.match(
      /^\/api\/(?:deployments|components)\/([^/]+)/,
    )?.[1];
    if (app) {
      assertNoCiRelease(decodeURIComponent(app));
      if (
        !new URL(req.url || '/', 'https://localhost').pathname.startsWith(
          '/api/deployments/wander/managed-adoption',
        )
      )
        assertCiMutation(decodeURIComponent(app));
      if (
        req.method === 'DELETE' &&
        new URL(req.url || '/', 'https://localhost').pathname === '/api/deployments/wander'
      )
        assertWanderLegacyAllowed('wander');
    }
  }
  return { username: username!, token: token! };
}

export function requireAdmin(
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

export async function dispatchAgentCommand(
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

export function waitForRemotePort(
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<boolean> {
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
