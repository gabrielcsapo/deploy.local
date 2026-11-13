import { createReadiness } from './readiness.ts';
import { startIntegrityChecks } from './readiness-integrity.ts';
import { getSqlite } from './store/connection.ts';
import { db as workspaceDb } from './workspace/store.ts';
import './packages/hooks.ts';
import { legacyUpdateService } from './legacy-update-service.ts';
import { wanderAdoptionService, wanderAdoptionPreflight } from './wander-adoption-service.ts';
import { assertHomeCoordinator } from './home-coordinator.ts';
import { startDeploymentNotifications } from './deployment-notification-service.ts';
import { recoverProjectReleases } from './v2/releases-api.ts';
import { startComputerUpdateScheduler } from './v2/fleet-updates.ts';
import { startAgentScheduler } from './v2/agent-runs.ts';
import { startMetricsCollector } from './metrics-collector.ts';
import { startDockerEventStream } from './docker.ts';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { error, json, requireAuth } from './api/shared.ts';
import { shortGitRoute } from './workspace/api.ts';
import { npmRegistry } from './packages/npm.ts';
import { certsExist, getCaCertBuffer } from './certs.ts';
import { RequestBodyTooLargeError } from './http.ts';
import { beginApplicationMutation } from './v2/releases-fence.ts';
import { getDeployment, logRequest } from './store.ts';
import { createHotPathHandler } from './edge/proxy.ts';
import { emit } from './events.ts';
import { type ApiRouteContext } from './api/context.ts';
import { v2Routes } from './api/v2.ts';
import { workspaceRoutes } from './api/workspace.ts';
import { groffeeGuardRoutes } from './api/groffee-guard.ts';
import { catalogRoutes } from './api/catalog.ts';
import { authRoutes } from './api/auth.ts';
import { fleetRoutes } from './api/fleet.ts';
import { uploadRoutes } from './api/upload.ts';
import { deploymentsRoutes } from './api/deployments.ts';
import { containersRoutes } from './api/containers.ts';
import { healthRoutes } from './api/health.ts';
import { requestsRoutes } from './api/requests.ts';
import { backupsRoutes } from './api/backups.ts';
import { buildLogsRoutes } from './api/build-logs.ts';
import { observeRequest } from './v2/diagnostics.ts';

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

// ── Middleware ───────────────────────────────────────────────────────────────

type NextFn = () => void;

export function apiMiddleware(
  options: {
    legacyUpdateService?: typeof legacyUpdateService;
    wanderAdoptionService?: typeof wanderAdoptionService;
    wanderAdoptionPreflight?: typeof wanderAdoptionPreflight;
  } = {},
) {
  const makeLegacyUpdate = options.legacyUpdateService ?? legacyUpdateService;
  const makeWanderAdoption = options.wanderAdoptionService ?? wanderAdoptionService;
  const wanderPreflight = options.wanderAdoptionPreflight ?? wanderAdoptionPreflight;
  assertHomeCoordinator();
  startDeploymentNotifications();
  void recoverProjectReleases().catch((error) =>
    console.error('[releases] Recovery failed', error),
  );
  startComputerUpdateScheduler();
  startAgentScheduler();
  startMetricsCollector();
  // Single long-lived `docker events` subscriber keeps the container-status
  // cache warm without per-request polling. Auto-reconnects if docker daemon
  // restarts.
  startDockerEventStream();
  if (process.env.DEPLOY_SUPERVISOR_TOKEN && process.connected)
    process.once('disconnect', () => process.exit(1));
  const deploy = getSqlite()!;
  const integrity = startIntegrityChecks({ deploy: deploy.name, workspace: workspaceDb.name });
  const readiness = createReadiness({ deploy, workspace: workspaceDb, integrity: integrity.read });
  const handle = async (req: IncomingMessage, res: ServerResponse, next: NextFn) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/health/ready') {
      const result = readiness();
      res.setHeader('Cache-Control', 'no-store');
      return json(res, result, result.ok ? 200 : 503);
    }
    if (req.url === '/api/internal/coordinator-ready') {
      const token = process.env.DEPLOY_SUPERVISOR_TOKEN;
      if (!token || req.headers['x-deploy-supervisor'] !== token)
        return error(res, 'Not found', 404);
      return json(res, { token, version: process.env.DEPLOY_COORDINATOR_VERSION || '' });
    }
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

    if (!shortGitRoute(rawUrl, method) && (await npmRegistry.handle(req, res))) return;

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

    // `deploy.local/<repo>.git` is the short clone address; Git serves it like the hosted route.
    const shortGit = shortGitRoute(rawUrl, method);
    if (shortGit?.redirect) {
      res.writeHead(301, { Location: shortGit.redirect });
      res.end();
      return;
    }
    if (shortGit) req.url = shortGit.url;
    const workspacePath = shortGit ? '/api/workspace/git/' : path;

    observeRequest(req, res, path);
    const ctx: ApiRouteContext = {
      req,
      res,
      path,
      method,
      url,
      workspacePath,
      makeLegacyUpdate,
      makeWanderAdoption,
      wanderPreflight,
    };
    if (await v2Routes(ctx)) return;
    if (await workspaceRoutes(ctx)) return;
    if (await groffeeGuardRoutes(ctx)) return;
    if (await catalogRoutes(ctx)) return;
    if (await authRoutes(ctx)) return;
    if (await fleetRoutes(ctx)) return;
    if (await uploadRoutes(ctx)) return;
    if (await deploymentsRoutes(ctx)) return;
    if (await containersRoutes(ctx)) return;
    if (await healthRoutes(ctx)) return;
    if (await requestsRoutes(ctx)) return;
    if (await backupsRoutes(ctx)) return;
    if (await buildLogsRoutes(ctx)) return;
    try {
      // ── Not an API route — pass to next middleware ─────────────────────
      next();
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
  };
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: NextFn) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    const app = path.match(/^\/api\/deployments\/([^/]+)/)?.[1];
    if (!app || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || ''))
      return handle(req, res, next);
    let release: (() => unknown) | undefined;
    try {
      const auth = requireAuth(req, res);
      if (!auth) return;
      release = beginApplicationMutation(auth.username, decodeURIComponent(app));
      return await handle(req, res, next);
    } catch (err) {
      return error(res, (err as Error).message, (err as any).status || 500);
    } finally {
      release?.();
    }
  };
  return Object.assign(middleware, { close: integrity.stop });
}
