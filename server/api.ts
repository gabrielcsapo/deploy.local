import { mkdirSync, createWriteStream, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { totalmem, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  type IncomingMessage,
  type ServerResponse,
  request as httpRequest,
  Agent,
} from 'node:http';
import { createGzip } from 'node:zlib';
import { startMetricsCollector } from './metrics-collector.ts';
import { registerHost, unregisterHost, registerAllDeployments } from './mdns.ts';
import { appNotFoundPage, appStartingPage } from './error-page.ts';
import { getCaCertBuffer, certsExist, ensureCertCoversHost } from './certs.ts';
import type { Server as HttpsServer } from 'node:https';
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

function getAuth(req: IncomingMessage) {
  const username = req.headers['x-deploy-username'] as string | undefined;
  const token = req.headers['x-deploy-token'] as string | undefined;
  return { username, token };
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

// ── Multipart parser (minimal) ──────────────────────────────────────────────

function parseMultipart(buffer: Buffer, contentType: string) {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1].trim();
  const parts: Record<string, string | { filename: string; data: Buffer }> = {};

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(boundaryBuffer) + boundaryBuffer.length;

  while (start < buffer.length) {
    // Skip \r\n after boundary
    if (buffer[start] === 0x0d) start += 2;
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break; // --

    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;

    const headers = buffer.subarray(start, headerEnd).toString();
    const bodyStart = headerEnd + 4;

    const nextBoundary = buffer.indexOf(boundaryBuffer, bodyStart);
    const bodyEnd = nextBoundary === -1 ? buffer.length : nextBoundary - 2; // -2 for \r\n

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    if (nameMatch) {
      const name = nameMatch[1];
      if (filenameMatch) {
        parts[name] = { filename: filenameMatch[1], data: buffer.subarray(bodyStart, bodyEnd) };
      } else {
        parts[name] = buffer.subarray(bodyStart, bodyEnd).toString().trim();
      }
    }

    start = nextBoundary + boundaryBuffer.length;
  }

  return parts;
}

// ── Reverse proxy helper ─────────────────────────────────────────────────

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
  // Get the original host and protocol from the incoming request
  const originalHost = req.headers.host || '';
  const protocol =
    (req.headers['x-forwarded-proto'] as string) ||
    ((req.socket as any).encrypted ? 'https' : 'http');

  // Extract metadata for enhanced logging
  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const userAgent = req.headers['user-agent'] || null;
  const referrer = req.headers['referer'] || null;
  const queryParams = search || null;
  const username = (req.headers['x-deploy-username'] as string | null) || null;
  const requestSize = parseInt(req.headers['content-length'] as string, 10) || 0;

  let responseSize = 0;

  const proxyReq = httpRequest(
    {
      agent: proxyAgent,
      hostname: 'localhost',
      port: deployment.port,
      path: targetPath + (search || ''),
      method,
      headers: {
        ...req.headers,
        host: `localhost:${deployment.port}`,
        'x-forwarded-host': originalHost,
        'x-forwarded-proto': protocol,
        'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
      },
    },
    (proxyRes) => {
      const duration = Date.now() - startTime;

      // Count actual bytes in response stream
      let bytesReceived = 0;
      proxyRes.on('data', (chunk) => {
        bytesReceived += chunk.length;
      });

      // Log the request when response is complete
      proxyRes.on('end', () => {
        responseSize = bytesReceived;
        const entry = {
          method,
          path: targetPath,
          status: proxyRes.statusCode!,
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

      const headers = {
        ...proxyRes.headers,
        'Access-Control-Allow-Origin': '*',
      };

      // Support compression if client accepts it and response isn't already compressed
      const acceptEncoding = req.headers['accept-encoding'] || '';
      const contentType = proxyRes.headers['content-type'] || '';
      const contentLength = parseInt(proxyRes.headers['content-length'] || '0', 10);
      const shouldCompress =
        acceptEncoding.includes('gzip') &&
        !proxyRes.headers['content-encoding'] &&
        (contentLength === 0 || contentLength >= 1024) &&
        (contentType.includes('text/') ||
          contentType.includes('application/json') ||
          contentType.includes('application/javascript'));

      if (shouldCompress) {
        headers['content-encoding'] = 'gzip';
        delete headers['content-length'];
        res.writeHead(proxyRes.statusCode!, headers);
        proxyRes.pipe(createGzip()).pipe(res);
      } else {
        res.writeHead(proxyRes.statusCode!, headers);
        proxyRes.pipe(res);
      }
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

    const duration = Date.now() - startTime;
    const entry = {
      method,
      path: targetPath,
      status: 502,
      duration,
      timestamp: Date.now(),
      ip,
      userAgent,
      referrer,
      requestSize,
      responseSize: 0,
      queryParams,
      username,
    };
    logRequest(deployment.name, entry);
    emit({ type: 'request:logged', deploymentName: deployment.name, data: entry });

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

let _httpsServer: HttpsServer | undefined;

export function setHttpsServer(server: HttpsServer) {
  _httpsServer = server;
}

export function apiMiddleware() {
  startMetricsCollector();
  registerHost('deploy');
  registerHost('discover');
  registerAllDeployments();
  return async (req: IncomingMessage, res: ServerResponse, next: NextFn) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

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

    const host = req.headers.host || '';
    const hostname = host.split(':')[0];

    // ── discover.local — redirect root to /discover ─────────────────────
    if (hostname === 'discover.local' && (path === '/' || path === '')) {
      res.writeHead(302, { Location: '/discover' });
      res.end();
      return;
    }

    // ── mDNS-based app proxy (<name>.local:PORT) ──────────────────────────
    if (
      hostname.endsWith('.local') &&
      hostname !== 'deploy.local' &&
      hostname !== 'discover.local'
    ) {
      const appName = hostname.slice(0, -'.local'.length);
      console.log(`[mDNS Proxy] Request for ${hostname} -> app name: ${appName}`);
      const d = getDeployment(appName);
      if (!d) {
        console.log(`[mDNS Proxy] Deployment not found: ${appName}`);
        return appNotFoundPage(res, appName);
      }
      console.log(`[mDNS Proxy] Found deployment: ${d.name}, port: ${d.port}, status: ${d.status}`);

      const proxyReq = proxyToApp(req, res, d, path, url.search, method!);
      // Stream the request body instead of buffering
      req.pipe(proxyReq);
      return;
    }

    try {
      // ── Public discover API ──────────────────────────────────────────────

      if (path === '/api/discover' && method === 'GET') {
        const allDeps = getDiscoverableDeployments();
        const statusMap = getAllContainerStatuses();
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
        return json(res, { token: result.token }, 201);
      }

      if (path === '/api/login' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.username || !body.password) {
          return error(res, 'Username and password required');
        }
        const result = loginUser(body.username as string, body.password as string);
        if ('error' in result) return error(res, result.error!, result.status!);
        return json(res, { token: result.token });
      }

      if (path === '/api/logout' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        logoutUser(auth.username, auth.token);
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

        // Stream the request body to a temporary file on disk instead of
        // buffering the entire upload in memory (prevents large heap allocations
        // for 100MB+ deployments).
        const tempPath = join(
          tmpdir(),
          `deploy-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        const tempWs = createWriteStream(tempPath);
        await new Promise<void>((resolve, reject) => {
          req.pipe(tempWs);
          tempWs.on('finish', resolve);
          tempWs.on('error', reject);
          req.on('error', reject);
        });

        // Read the temp file back for multipart parsing, then delete it
        let body: Buffer;
        try {
          body = readFileSync(tempPath);
        } finally {
          try {
            unlinkSync(tempPath);
          } catch {
            /* ignore */
          }
        }

        const contentType = req.headers['content-type'] || '';
        const parts = parseMultipart(body, contentType);

        if (!parts || !parts.file || typeof parts.file === 'string') {
          return error(res, 'No file uploaded');
        }

        const name = ((typeof parts.name === 'string' ? parts.name : null) || 'app').toLowerCase();
        const uploadsDir = getUploadsDir();
        const deployDir = resolve(uploadsDir, name);

        // Clean and recreate deploy dir
        if (existsSync(deployDir)) {
          execSync(`rm -rf ${JSON.stringify(deployDir)}`);
        }
        mkdirSync(deployDir, { recursive: true });

        // Write tarball and extract
        const tarPath = resolve(deployDir, 'upload.tar.gz');
        const ws = createWriteStream(tarPath);
        ws.write(parts.file.data);
        ws.end();
        await new Promise<void>((resolve) => ws.on('finish', resolve));

        execSync(`tar -xzf upload.tar.gz`, { cwd: deployDir, stdio: 'pipe' });
        execSync(`rm upload.tar.gz`, { cwd: deployDir, stdio: 'pipe' });

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
        const statusMap = getAllContainerStatuses();
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
