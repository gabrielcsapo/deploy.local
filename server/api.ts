import { mkdirSync, existsSync } from 'node:fs';
import { totalmem } from 'node:os';
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
import {
  classifyProject,
  ensureDockerfile,
  buildImage,
  runContainer,
  removeContainer,
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

function proxyToApp(
  req: IncomingMessage,
  res: ServerResponse,
  deployment: { name: string; port: number | null },
  targetPath: string,
  search: string,
  method: string,
  isRetry = false,
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

      // Compression decision. Skip the cost of parsing/checking when the
      // response is already compressed by the backend.
      const existingEncoding = proxyHeaders['content-encoding'];
      const status = proxyRes.statusCode!;
      let shouldCompress = false;
      if (!existingEncoding && status !== 204 && status !== 304) {
        const acceptEncoding = req.headers['accept-encoding'];
        if (acceptEncoding && acceptEncoding.includes('gzip')) {
          const contentType = proxyHeaders['content-type'] || '';
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

  proxyReq.on('error', () => {
    // Retry once on connection error (handles stale keep-alive sockets).
    // Only retry bodyless methods since the request stream is already consumed.
    if (!isRetry && (method === 'GET' || method === 'HEAD')) {
      const retryReq = proxyToApp(req, res, deployment, targetPath, search, method, true);
      retryReq.end();
      return;
    }

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
      emit({ type: 'request:logged', deploymentName: deployment.name, data: entry });
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

        // Stream the multipart body directly into `tar -xz` running in the
        // destination directory. Previously the upload was buffered to a temp
        // file, read fully back into memory, parsed in-process, written back
        // to disk, then extracted — a 500 MB upload could OOM the server.
        //
        // Busboy parses the multipart stream incrementally; the file part is
        // piped straight into a tar subprocess that decompresses + extracts on
        // the fly. The deployment name (a small text field) may arrive before
        // or after the file part, so we defer "ready to extract" until we've
        // seen both.
        const contentType = req.headers['content-type'] || '';
        if (!contentType.startsWith('multipart/form-data')) {
          return error(res, 'Expected multipart/form-data');
        }

        const fields: Record<string, string> = {};
        const uploadsDir = getUploadsDir();
        let deployDir: string | null = null;
        let tarProc: ReturnType<typeof spawn> | null = null;
        let extractFinish: Promise<void> | null = null;

        const ensureExtractor = async () => {
          if (tarProc || !fields.name) return;
          const name = fields.name.toLowerCase();
          deployDir = resolve(uploadsDir, name);
          // Use async rm (no fork) instead of execSync('rm -rf ...').
          if (existsSync(deployDir)) {
            await rm(deployDir, { recursive: true, force: true });
          }
          mkdirSync(deployDir, { recursive: true });
          tarProc = spawn('tar', ['-xzf', '-'], {
            cwd: deployDir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          extractFinish = new Promise<void>((resolveP, reject) => {
            tarProc!.on('close', (code) => {
              if (code === 0) resolveP();
              else reject(new Error(`tar exited with code ${code}`));
            });
            tarProc!.on('error', reject);
          });
        };

        const buffered: Buffer[] = []; // file bytes received before `name` field arrives
        let fileSeen = false;

        try {
          await new Promise<void>((resolveP, rejectP) => {
            const bb = Busboy({
              headers: req.headers as Record<string, string>,
              limits: { files: 1 },
            });

            bb.on('field', (fieldname, val) => {
              fields[fieldname] = val;
              // If file already started arriving, drain the buffered bytes now.
              if (fieldname === 'name' && fileSeen) {
                ensureExtractor()
                  .then(() => {
                    for (const chunk of buffered) tarProc!.stdin!.write(chunk);
                    buffered.length = 0;
                  })
                  .catch(rejectP);
              }
            });

            bb.on('file', (_fieldname, fileStream) => {
              fileSeen = true;
              fileStream.on('data', (chunk: Buffer) => {
                if (tarProc) {
                  tarProc.stdin!.write(chunk);
                } else {
                  buffered.push(chunk);
                }
              });
              fileStream.on('end', () => {
                if (tarProc) {
                  tarProc.stdin!.end();
                }
              });
            });

            const onClose = async () => {
              if (!fields.name) throw new Error('Missing deployment name');
              if (!tarProc) {
                // file finished before `name` field arrived — start extractor now
                await ensureExtractor();
                for (const chunk of buffered) tarProc!.stdin!.write(chunk);
                tarProc!.stdin!.end();
              }
              if (extractFinish) await extractFinish;
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
          return error(res, (uploadErr as Error).message || 'Upload failed');
        }

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
          buildResult = await buildImage(name, deployDir, (line, timestamp) => {
            accumulatedOutput += `[${timestamp}] ${line}\n`;
            emit({ type: 'build:output', deploymentName: name, data: { line, timestamp } });
            const now = Date.now();
            if (now - lastFlush > 2000) {
              updateBuildOutput(buildLogId, accumulatedOutput);
              lastFlush = now;
            }
          });

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
          const { id, containerName, extraPorts } = await runContainer(
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
          );
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

          addDeployEvent(name, { action: 'deploy', username, type, port, containerId: id });
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
        addDeployEvent(name, { action: 'delete', username: auth.username });
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
          addDeployEvent(name, { action, username: auth.username });
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
        addDeployEvent(name, { action: 'restart', username: auth.username });
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
        addDeployEvent(name, { action: 'recreate', username: auth.username });
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
        });

        addDeployEvent(name, { action: 'backup', username: auth.username });
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

        addDeployEvent(name, { action: 'restore', username: auth.username });
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
