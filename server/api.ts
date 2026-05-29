import { mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { totalmem, cpus } from 'node:os';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  type IncomingMessage,
  type ServerResponse,
  request as httpRequest,
  Agent,
} from 'node:http';
import { createGzip } from 'node:zlib';
import Busboy from 'busboy';
import { startMetricsCollector } from './metrics-collector.ts';
import { registerHost, unregisterHost, registerAllDeployments } from './mdns.ts';
import { appNotFoundPage, appStartingPage } from './error-page.ts';
import { getCaCertBuffer, certsExist, ensureCertCoversHost } from './certs.ts';
import type { Server as TlsServer } from 'node:tls';

// Accepts both `https.Server` and `http2.Http2SecureServer` (both extend
// `tls.Server`). We only call `setSecureContext` on it, which lives on the
// `tls.Server` base.
type SecureServer = TlsServer;
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
  updateBuildOutput,
  completeBuildLog,
  getBuildLogs,
  getActiveBuildLog,
  saveRuntimeLogs,
  updateCurrentBuildLogId,
  getDeploymentEnvVars,
  getDeploymentVolumes,
  getAllocatedMemory,
  getAllDeployments,
} from './store.ts';
import { emit } from './events.ts';
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
  getContainerStatusAsync,
  getAllContainerStatuses,
  captureContainerLogsAsync,
  streamLogs,
  getAvailablePort,
  getContainerInspectAsync,
  getContainerStats,
  restartContainer,
  recreateContainer,
  parseMemoryLimit,
  validateVolumeMounts,
  startDockerEventStream,
} from './docker.ts';
import {
  getVolumeDir,
  createBackup,
  restoreBackup,
  deleteBackupFile,
  deleteVolumes,
  getVolumeSize,
} from './volumes.ts';
import { readDeployConfig } from './deploy-config.ts';
import { startProxies, stopProxies } from './tcp-proxy.ts';

// Pre-container states where Docker has no container yet
const PRE_CONTAINER_STATES = new Set(['uploading', 'building', 'starting']);
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Async resolve status — avoids blocking the event loop during HTTP request handling. */
async function resolveStatusAsync(d: {
  name: string;
  status: string | null;
  updatedAt?: string | null;
}): Promise<string> {
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
  d: { name: string; status: string | null; updatedAt?: string | null },
  statusMap: Map<string, string>,
): string {
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

// ── HTTP Agent with connection pooling ──────────────────────────────────────

const proxyAgent = new Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 256,
  maxFreeSockets: 256,
  timeout: 30000,
  scheduling: 'fifo',
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200) {
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

// ── Reverse proxy helper ─────────────────────────────────────────────────

// ── Hot-path internals ──────────────────────────────────────────────────────
//
// The reverse proxy services every request to every deployed app on the
// network — `medius.local`, `compendus.local`, etc. all funnel through here.
// Every micro-allocation, every callback, every header-object spread runs
// per request, so this function is hand-tuned for hot-path performance:
//
//  - Outgoing proxy headers are *mutated* on the original headers object
//    rather than spread into a new one (~1 less malloc/GC per request).
//  - Outgoing response headers ditto; we set `access-control-allow-origin`
//    in-place on proxyRes.headers instead of cloning.
//  - The per-chunk `'data'` byte-counter is gone — we read `content-length`
//    from the response when present. Many of our backends emit it; the rare
//    chunked-encoding response just gets `responseSize=null`.
//  - `logRequest()` + `emit()` are deferred to `setImmediate` so they run
//    after the response has been flushed to the client. The user sees the
//    response sooner; the log row appears a tick later.
//  - The compression branch returns early when the response already has a
//    `content-encoding`, skipping the type/length checks.

// Per-request timeout for proxied responses. Backends that hang past this
// budget are treated as down (502) rather than blocking the client forever.
// Picked at 15s because human-noticeable but long enough for legitimate slow
// endpoints (image builds, ML inference) that take a few seconds.
const PROXY_RESPONSE_TIMEOUT_MS = 15_000;

// Cap retry attempts and grow the gap between them. Stale keep-alive sockets
// usually clear on the first retry; further retries against a truly-down
// backend are pointless and would just amplify thundering-herd pressure.
const PROXY_MAX_RETRIES = 2;
const PROXY_RETRY_BASE_MS = 25;
const PROXY_RETRY_CAP_MS = 200;

function proxyToApp(
  req: IncomingMessage,
  res: ServerResponse,
  deployment: { name: string; port: number | null },
  targetPath: string,
  search: string,
  method: string,
  retryCount = 0,
) {
  const startTime = Date.now();

  // Mutate request headers in place instead of spreading into a new object.
  // The same IncomingMessage isn't re-used after this function returns, so
  // mutation is safe and avoids one allocation per request.
  const outHeaders = req.headers;
  // Strip HTTP/2 pseudo-headers (`:method`, `:path`, `:scheme`, `:authority`)
  // before forwarding to the HTTP/1.1 backend. Node's http.request rejects
  // any header name starting with `:`. Cheap loop — for HTTP/1.1 requests
  // there's nothing to delete.
  for (const key in outHeaders) {
    if (key.charCodeAt(0) === 58 /* ':' */) delete outHeaders[key];
  }
  const originalHost = outHeaders.host || (req.headers[':authority'] as string | undefined) || '';
  const xff = outHeaders['x-forwarded-for'] as string | undefined;
  const remoteAddr = req.socket.remoteAddress || '';
  outHeaders.host = `localhost:${deployment.port}`;
  outHeaders['x-forwarded-host'] = originalHost;
  outHeaders['x-forwarded-proto'] =
    (xff && (outHeaders['x-forwarded-proto'] as string)) ||
    ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  outHeaders['x-forwarded-for'] = xff || remoteAddr;

  const proxyReq = httpRequest(
    {
      agent: proxyAgent,
      hostname: 'localhost',
      port: deployment.port,
      path: search ? targetPath + search : targetPath,
      method,
      headers: outHeaders,
    },
    (proxyRes) => {
      const proxyHeaders = proxyRes.headers;
      // Strip RFC 7230 §6.1 hop-by-hop headers + Node's `Keep-Alive` extension
      // before forwarding to the client. HTTP/2 explicitly forbids them in
      // responses (Node errors with ERR_HTTP2_INVALID_CONNECTION_HEADERS) and
      // they're meaningless across a proxy hop anyway. The deletes are no-ops
      // when the backend didn't set them.
      delete proxyHeaders.connection;
      delete proxyHeaders['keep-alive'];
      delete proxyHeaders['proxy-authenticate'];
      delete proxyHeaders['proxy-authorization'];
      delete proxyHeaders.te;
      delete proxyHeaders.trailer;
      delete proxyHeaders['transfer-encoding'];
      delete proxyHeaders.upgrade;
      // CORS for cross-origin XHR/fetch into deployed apps from other tabs.
      // Mutate the response headers in place — they're only consumed once here.
      proxyHeaders['access-control-allow-origin'] = '*';

      // Long-lived streams (SSE, or any backend that set `x-accel-buffering: no`)
      // need to flow through untouched: no gzip buffering, no idle timeout.
      const contentType = proxyHeaders['content-type'] || '';
      const isStream =
        contentType.includes('text/event-stream') || proxyHeaders['x-accel-buffering'] === 'no';
      if (isStream) {
        proxyReq.setTimeout(0);
      }

      // Compression decision. Skip the cost of parsing/checking when the
      // response is already compressed by the backend.
      const existingEncoding = proxyHeaders['content-encoding'];
      const status = proxyRes.statusCode!;
      let shouldCompress = false;
      if (!isStream && !existingEncoding && status !== 204 && status !== 304) {
        const acceptEncoding = req.headers['accept-encoding'];
        if (acceptEncoding && acceptEncoding.includes('gzip')) {
          const lenStr = proxyHeaders['content-length'];
          const len = lenStr ? +lenStr : 0;
          // Compress text-shaped payloads ≥1 KiB (or unknown length).
          if (
            (len === 0 || len >= 1024) &&
            (contentType.includes('text/') ||
              contentType.includes('application/json') ||
              contentType.includes('application/javascript'))
          ) {
            shouldCompress = true;
          }
        }
      }

      if (shouldCompress) {
        proxyHeaders['content-encoding'] = 'gzip';
        delete proxyHeaders['content-length'];
        res.writeHead(status, proxyHeaders);
        proxyRes.pipe(createGzip()).pipe(res);
      } else {
        res.writeHead(status, proxyHeaders);
        proxyRes.pipe(res);
      }

      // Defer logging until the response is flushed — the client sees data
      // first, the request log row gets buffered a tick later. Pre-capture
      // only the cheap-to-read bits; build the log entry inside setImmediate
      // so we don't pay for it on the hot path.
      const responseSize = proxyHeaders['content-length'] ? +proxyHeaders['content-length'] : null;
      const queryParams = search || null;
      const username = (req.headers['x-deploy-username'] as string | null) || null;
      const userAgent = req.headers['user-agent'] || null;
      const referrer = req.headers['referer'] || null;
      const requestSize = req.headers['content-length']
        ? +(req.headers['content-length'] as string)
        : 0;
      const ip = xff ? xff.split(',')[0].trim() : remoteAddr || 'unknown';
      const duration = Date.now() - startTime;

      setImmediate(() => {
        const entry = {
          method,
          path: targetPath,
          status,
          duration,
          timestamp: Date.now(),
          ip,
          userAgent,
          referrer,
          requestSize,
          responseSize,
          queryParams,
          username,
        };
        logRequest(deployment.name, entry);
        emit({ type: 'request:logged', deploymentName: deployment.name, data: entry });
      });
    },
  );

  // Fail fast on hung backends. setTimeout on the request fires if the socket
  // is idle for the given window — works for both "TCP connected but never
  // responding" and "response started but stalled mid-stream". On fire we
  // destroy the request, which triggers the 'error' handler below.
  proxyReq.setTimeout(PROXY_RESPONSE_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error('proxy_timeout'));
  });

  proxyReq.on('error', (err) => {
    const isTimeout = (err as Error & { message?: string }).message === 'proxy_timeout';
    // Only retry idempotent methods — the body of a non-GET/HEAD request was
    // piped to the upstream and is no longer replayable. Exponential backoff
    // before the next attempt: collapses thundering-herd from many concurrent
    // stale sockets to ~one retry per window.
    if (retryCount < PROXY_MAX_RETRIES && !isTimeout && (method === 'GET' || method === 'HEAD')) {
      const delay = Math.min(PROXY_RETRY_BASE_MS * Math.pow(2, retryCount), PROXY_RETRY_CAP_MS);
      setTimeout(() => {
        const retryReq = proxyToApp(
          req,
          res,
          deployment,
          targetPath,
          search,
          method,
          retryCount + 1,
        );
        retryReq.end();
      }, delay);
      return;
    }

    // Distinguish failure mode in logs so the dashboard can show "timed out"
    // vs. "connection refused" — both are 502 to the client but they mean
    // very different things operationally.
    const failureReason = isTimeout
      ? 'timeout'
      : (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
        ? 'refused'
        : 'error';

    setImmediate(() => {
      const duration = Date.now() - startTime;
      const entry = {
        method,
        path: targetPath,
        status: 502,
        duration,
        timestamp: Date.now(),
        ip: xff ? xff.split(',')[0].trim() : remoteAddr || 'unknown',
        userAgent: (req.headers['user-agent'] as string | null) || null,
        referrer: (req.headers['referer'] as string | null) || null,
        requestSize: req.headers['content-length'] ? +(req.headers['content-length'] as string) : 0,
        responseSize: 0,
        queryParams: search || null,
        username: (req.headers['x-deploy-username'] as string | null) || null,
      };
      logRequest(deployment.name, entry);
      emit({
        type: 'request:logged',
        deploymentName: deployment.name,
        data: { ...entry, failureReason },
      });
    });

    if (!res.headersSent) {
      appStartingPage(res, deployment.name);
    } else {
      res.end();
    }
  });

  return proxyReq;
}

// ── Middleware ───────────────────────────────────────────────────────────────

type NextFn = () => void;

let _httpsServer: SecureServer | undefined;

export function setHttpsServer(server: SecureServer) {
  _httpsServer = server;
}

export function apiMiddleware() {
  startMetricsCollector();
  // Single long-lived `docker events` subscriber keeps the container-status
  // cache warm without per-request polling. Auto-reconnects if docker daemon
  // restarts.
  startDockerEventStream();
  registerHost('deploy');
  registerHost('discover');
  registerAllDeployments();
  return async (req: IncomingMessage, res: ServerResponse, next: NextFn) => {
    // ── Hot-path: mDNS proxy for <name>.local ──
    // Hand-parse the URL to avoid the `new URL(...)` cost (≈3-8 µs/request)
    // when the request is just a proxied app hit. The slow API/dashboard
    // routes below still build a URL, but those run orders of magnitude
    // less frequently than the proxy path.
    //
    // For HTTP/2 requests, the `Host` header is replaced by the `:authority`
    // pseudo-header. Node's compat layer aliases :authority → host on
    // `req.headers`, but only for "real" HTTP/2 streams; some clients (h2load,
    // certain HTTP/2 ping frames) skip it. Read both so we degrade safely.
    const rawUrl = req.url!;
    const method = req.method;
    const hostHeader =
      req.headers.host || (req.headers[':authority'] as string | undefined) || 'deploy.local';
    const colonIdx = hostHeader.indexOf(':');
    const hostname = colonIdx === -1 ? hostHeader : hostHeader.substring(0, colonIdx);

    if (
      method !== 'OPTIONS' &&
      hostname.length > 6 && // ".local"
      hostname.endsWith('.local') &&
      hostname !== 'deploy.local' &&
      hostname !== 'discover.local'
    ) {
      const appName = hostname.substring(0, hostname.length - 6);
      // O(1) in-memory map lookup — see store.ts.
      const d = getDeployment(appName);
      if (!d) {
        return appNotFoundPage(res, appName);
      }
      const queryIdx = rawUrl.indexOf('?');
      const targetPath = queryIdx === -1 ? rawUrl : rawUrl.substring(0, queryIdx);
      const search = queryIdx === -1 ? '' : rawUrl.substring(queryIdx);
      const proxyReq = proxyToApp(req, res, d, targetPath, search, method!);
      req.pipe(proxyReq);
      return;
    }

    // ── Non-proxy paths: parse URL and continue with the slow path ──
    const url = new URL(rawUrl, `http://${hostHeader}`);
    const path = url.pathname;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
        return json(res, { message: 'Password changed' });
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

        const fields: Record<string, string> = {};
        const uploadsDir = getUploadsDir();
        const tmpFile = resolve(
          uploadsDir,
          `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`,
        );
        let deployDir: string | null = null;
        let fileFinished: Promise<void> | null = null;
        let sawFile = false;

        try {
          await new Promise<void>((resolveP, rejectP) => {
            const bb = Busboy({
              headers: req.headers as Record<string, string>,
              limits: { files: 1 },
            });

            bb.on('field', (fieldname, val) => {
              fields[fieldname] = val;
            });

            bb.on('file', (_fieldname, fileStream) => {
              sawFile = true;
              const out = createWriteStream(tmpFile);
              fileFinished = new Promise<void>((res, rej) => {
                out.on('finish', () => res());
                out.on('error', rej);
                fileStream.on('error', rej);
              });
              fileStream.pipe(out);
            });

            const onClose = async () => {
              if (!sawFile) throw new Error('No file uploaded');
              if (!fields.name) throw new Error('Missing deployment name');
              // Wait for all bytes to flush to disk before invoking tar.
              await fileFinished;

              const name = fields.name.toLowerCase();
              deployDir = resolve(uploadsDir, name);
              if (existsSync(deployDir)) {
                await rm(deployDir, { recursive: true, force: true });
              }
              mkdirSync(deployDir, { recursive: true });

              await new Promise<void>((res, rej) => {
                const proc = spawn('tar', ['-xzf', tmpFile], {
                  cwd: deployDir!,
                  stdio: ['ignore', 'pipe', 'pipe'],
                });
                proc.on('close', (code) => {
                  if (code === 0) res();
                  else rej(new Error(`tar exited with code ${code}`));
                });
                proc.on('error', rej);
              });
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
          await rm(tmpFile, { force: true }).catch(() => {});
          return error(res, (uploadErr as Error).message || 'Upload failed');
        }
        await rm(tmpFile, { force: true }).catch(() => {});

        if (!deployDir) {
          return error(res, 'No file uploaded');
        }

        const name = (fields.name || 'app').toLowerCase();

        // Read deploy.json config (if present)
        let deployConfig;
        try {
          deployConfig = readDeployConfig(deployDir);
        } catch (err: any) {
          return error(res, err.message);
        }

        // Classify and build
        const type = classifyProject(deployDir);
        if (!type) {
          return error(
            res,
            'Unknown project type. Need a Dockerfile, package.json, or index.html.',
          );
        }

        ensureDockerfile(deployDir, type);

        const deployStartedAtMs = Date.now();
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

        // Cache deployment lookup to avoid redundant DB queries
        const cachedDeployment = getDeployment(name);

        // Auto-backup existing deployment if autoBackup is enabled
        if (cachedDeployment && cachedDeployment.autoBackup) {
          try {
            console.log(`Creating auto-backup for ${name}...`);
            const backup = await createBackup(name, 'pre-deploy');
            saveBackup({
              deploymentName: name,
              filename: backup.filename,
              label: 'pre-deploy',
              sizeBytes: backup.sizeBytes,
              createdBy: username,
              createdAt: backup.timestamp,
              volumePaths: ['data', 'uploads'],
              relatedBuildLogId: cachedDeployment.currentBuildLogId ?? null,
              auto: true,
            });
            console.log(
              `Auto-backup created: ${backup.filename} (${(backup.sizeBytes / 1024 / 1024).toFixed(2)} MB, volume: ${(backup.volumeSizeBytes / 1024 / 1024).toFixed(2)} MB)`,
            );
          } catch (err) {
            console.error('Auto-backup failed:', err);
            // Continue deployment even if backup fails
          }
        }

        // Emit building status
        updateDeploymentStatus(name, 'building');
        emit({
          type: 'deployment:status',
          deploymentName: name,
          data: { status: 'building', username },
        });

        console.log(`Building ${name} (${type})...`);
        const buildLogId = createBuildLog(name);
        let accumulatedOutput = '';
        let lastFlush = Date.now();
        let buildResult: Awaited<ReturnType<typeof buildImage>> | null = null;
        try {
          const noCache = fields.noCache === '1' || fields.noCache === 'true';
          buildResult = await buildImage(
            name,
            deployDir,
            (line, timestamp) => {
              accumulatedOutput += `[${timestamp}] ${line}\n`;
              emit({ type: 'build:output', deploymentName: name, data: { line, timestamp } });
              const now = Date.now();
              if (now - lastFlush > 2000) {
                updateBuildOutput(buildLogId, accumulatedOutput);
                lastFlush = now;
              }
            },
            { noCache },
          );

          completeBuildLog(buildLogId, {
            output: buildResult.output,
            success: buildResult.success,
            duration: buildResult.duration,
          });

          emit({
            type: 'build:complete',
            deploymentName: name,
            data: { success: buildResult.success, duration: buildResult.duration },
          });
        } catch (buildErr) {
          // Ensure build log is always marked as failed if an error occurs
          completeBuildLog(buildLogId, {
            output: accumulatedOutput || 'Build failed due to an internal error',
            success: false,
            duration: Date.now() - lastFlush,
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
          emit({
            type: 'deployment:status',
            deploymentName: name,
            data: { status: 'failed', username },
          });
          return error(
            res,
            `Build failed after ${buildResult.duration}ms. Check build logs for details.`,
            500,
          );
        }

        // Capture runtime logs from the current container before it's replaced
        if (cachedDeployment?.currentBuildLogId) {
          const runtimeLogs = await captureContainerLogsAsync(name);
          if (runtimeLogs) {
            saveRuntimeLogs(cachedDeployment.currentBuildLogId, runtimeLogs);
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
          const storedEnvVars = getDeploymentEnvVars(name);
          const storedVolumes = getDeploymentVolumes(name);
          const memLimit = cachedDeployment?.memoryLimit || '4g';
          const cpuLimit = cachedDeployment?.cpuLimit || undefined;
          const gpuFlag = deployConfig.gpus ?? cachedDeployment?.gpuEnabled ?? false;
          const privilegedDocker =
            deployConfig.privilegedDocker ?? cachedDeployment?.privilegedDocker ?? false;
          // Validate any volumes declared in deploy.json before merging them in
          const declaredVolumes = (deployConfig.volumes || []).map((v) => ({
            hostPath: v.hostPath,
            containerPath: v.containerPath,
            readOnly: v.readOnly,
          }));
          if (declaredVolumes.length > 0) {
            const volErr = validateVolumeMounts(declaredVolumes, { privilegedDocker });
            if (volErr) {
              throw new Error(`deploy.json volumes invalid: ${volErr}`);
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
          // If deploy.json has no ports, preserve existing DB extra ports
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
          // 30s drain window so in-flight requests can finish.
          const canonicalName = `deploy-sh-${name.toLowerCase()}`;
          const prevName = `${canonicalName}-prev-${Date.now()}`;
          const hadPrevious = containerExists(canonicalName);
          if (hadPrevious) {
            try {
              renameContainerByName(canonicalName, prevName);
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
            removeContainerByName(canonicalName);
            if (hadPrevious && containerExists(prevName)) {
              try {
                renameContainerByName(prevName, canonicalName);
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
            directory: deployDir,
            extraPorts: extraPortsJson,
            createdAt: new Date().toISOString(),
          });
          recordContainerStart(name);

          // Switchover happened above (DB now points at the new container).
          // Drain the previous container for 30s so in-flight requests against
          // its old port can finish, then remove it. Fire-and-forget — the
          // deploy response returns immediately.
          if (hadPrevious) {
            const drainMs = 30_000;
            setTimeout(() => {
              try {
                removeContainerByName(prevName);
                console.log(`[deploy] Drained and removed ${prevName}`);
              } catch (err) {
                console.warn(`[deploy] Failed to remove ${prevName} after drain:`, err);
              }
            }, drainMs).unref();
          }

          if (extraPorts.length > 0) {
            startProxies(name, extraPorts);
          } else {
            stopProxies(name);
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
          if (deployConfig.gpus !== undefined) deployConfigSettings.gpuEnabled = deployConfig.gpus;
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
          registerHost(name);

          // Regenerate TLS cert if this hostname isn't covered yet
          const allNames = getAllDeployments().map((d) => d.name);
          ensureCertCoversHost(name, allNames, _httpsServer);

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
        stopProxies(name);
        removeContainer(name);
        unregisterHost(name);
        deleteVolumes(name);
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
          const volError = validateVolumeMounts(body.volumes, {
            privilegedDocker: effectivePrivilegedDocker,
          });
          if (volError) return error(res, volError, 400);
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
        if (needsRecreation && d.port && d.status === 'running') {
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
          if (extraPorts.length > 0) {
            startProxies(name, extraPorts);
          } else {
            stopProxies(name);
          }
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

        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Transfer-Encoding': 'chunked',
          'Access-Control-Allow-Origin': '*',
        });

        const proc = streamLogs(name);
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
        const stats = getContainerStats(name);
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
        restartContainer(name);
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
        const name = recreateMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        if (!d.port) return error(res, 'Deployment has no port assigned', 400);

        const volumeDir = getVolumeDir(name);
        const envVars = getDeploymentEnvVars(name);
        const customVolumes = getDeploymentVolumes(name);
        const extraPortsConfig = d.extraPorts ? JSON.parse(d.extraPorts) : undefined;
        const { id, containerName, extraPorts } = await recreateContainer(
          name,
          d.port,
          volumeDir,
          d.directory || null,
          envVars,
          d.memoryLimit || undefined,
          customVolumes,
          d.gpuEnabled || false,
          extraPortsConfig,
          d.privilegedDocker || false,
        );
        saveDeployment({
          name,
          username: auth.username,
          port: d.port,
          containerId: id,
          containerName,
          directory: d.directory || undefined,
          extraPorts: extraPorts.length > 0 ? JSON.stringify(extraPorts) : null,
        });
        if (extraPorts.length > 0) {
          stopProxies(name);
          startProxies(name, extraPorts);
        }
        addDeployEvent(name, { action: 'recreate', username: auth.username, source: 'ui' });
        updateDeploymentStatus(name, 'running');
        emit({
          type: 'deployment:status',
          deploymentName: name,
          data: { status: 'running', username: auth.username },
        });
        return json(res, { message: `Recreated ${name}` });
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

        const result = await createBackup(name, label);
        saveBackup({
          deploymentName: name,
          filename: result.filename,
          label,
          sizeBytes: result.sizeBytes,
          createdBy: auth.username,
          createdAt: result.timestamp,
          volumePaths: ['data', 'uploads'],
          relatedBuildLogId: d.currentBuildLogId ?? null,
          auto: false,
        });

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
        const volumeSize = getVolumeSize(name);

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

        restoreBackup(name, filename);

        // Restart container to pick up restored data
        restartContainer(name);
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
            ? { output: activeBuild.output, timestamp: activeBuild.timestamp }
            : null,
        });
      }

      // ── Not an API route — pass to next middleware ─────────────────────
      next();
    } catch (err: unknown) {
      console.error(err);
      error(res, (err as Error).message || 'Internal server error', 500);
    }
  };
}
