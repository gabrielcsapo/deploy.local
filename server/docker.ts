import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer, createConnection, type AddressInfo, type Socket } from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { DeployConfig } from './deploy-config.ts';
import { readDeployConfig } from './deploy-config.ts';
import {
  getDockerSocketPath,
  pingDaemon,
  listDeployContainers,
  inspectContainer,
  apiStartContainer,
  apiStopContainer,
  apiRestartContainer,
  apiRenameContainer,
  apiRemoveContainer,
  dockerStream,
  startStatsMonitor,
  getLiveStats,
  fetchStatsOnce,
  onContainerLifecycleEvent,
} from './docker-api.ts';

const execFileAsync = promisify(execFile);

// Enable BuildKit by default for all Docker operations
process.env.DOCKER_BUILDKIT = '1';

// ── TTL cache with single-flight ────────────────────────────────────────────
// Used to amortize `docker ps` / `docker stats` invocations across many
// concurrent callers. Both `docker ps` and `docker stats` are fork+exec and,
// in the case of stats, sample CPU over ~1 second — calling them per-request
// blocks the event loop. The cache collapses bursts into one shell-out.
class TtlCache<T> {
  private value: T | null = null;
  private expires = 0;
  private inflight: Promise<T> | null = null;
  private fetcher: () => Promise<T>;
  private ttlMs: number;

  constructor(fetcher: () => Promise<T>, ttlMs: number) {
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
  }

  async get(): Promise<T> {
    const now = Date.now();
    if (this.value !== null && now < this.expires) return this.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetcher()
      .then((v) => {
        this.value = v;
        this.expires = Date.now() + this.ttlMs;
        this.inflight = null;
        return v;
      })
      .catch((err) => {
        this.inflight = null;
        throw err;
      });
    return this.inflight;
  }

  invalidate() {
    this.expires = 0;
  }

  set(value: T) {
    this.value = value;
    this.expires = Date.now() + this.ttlMs;
  }
}

// ── Daemon reachability ─────────────────────────────────────────────────────

/**
 * Cheap daemon liveness probe — GET /_ping on the unix socket. Used by the
 * metrics collector to surface "Docker is down" instead of silently serving
 * stale data.
 */
export function pingDocker(): Promise<boolean> {
  return pingDaemon();
}

// ── Memory helpers ──────────────────────────────────────────────────────────

/** Parse a Docker memory limit string (e.g. '128m', '4g') into bytes. Returns null if invalid. */
export function parseMemoryLimit(limit: string): number | null {
  const match = limit.trim().match(/^(\d+(?:\.\d+)?)\s*([bkmgt])$/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
    t: 1024 * 1024 * 1024 * 1024,
  };
  return Math.round(val * multipliers[unit]);
}

// ── Port allocation ─────────────────────────────────────────────────────────

export function getAvailablePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(preferred ?? 0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', () => {
      if (preferred) {
        // Preferred port taken, fall back to random
        const srv2 = createServer();
        srv2.listen(0, () => {
          const port = (srv2.address() as AddressInfo).port;
          srv2.close(() => resolve(port));
        });
        srv2.on('error', reject);
      } else {
        reject(new Error('Failed to find available port'));
      }
    });
  });
}

// ── Project classification ──────────────────────────────────────────────────

export function classifyProject(dir: string): string | null {
  if (existsSync(resolve(dir, 'Dockerfile'))) return 'docker';
  if (existsSync(resolve(dir, 'package.json'))) return 'node';
  if (existsSync(resolve(dir, 'index.html'))) return 'static';
  return null;
}

// ── Dockerfile generation ───────────────────────────────────────────────────

function generateNodeDockerfile(dir: string) {
  const content = `# syntax=docker/dockerfile:1.7
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/root/.local/share/pnpm/store \
    corepack enable && if [ -f pnpm-lock.yaml ]; then pnpm install --prod --frozen-lockfile; elif [ -f yarn.lock ]; then yarn install --production --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY . .
CMD ["npm", "start"]
`;
  writeFileSync(resolve(dir, 'Dockerfile'), content);
}

function generateStaticDockerfile(dir: string) {
  // Inline a tiny static file server
  const serverCode = `
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let filePath = path.join('/app/public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(process.env.PORT || 3000);
`;
  writeFileSync(resolve(dir, '_static_server.js'), serverCode);

  const content = `FROM node:22-alpine
WORKDIR /app
COPY . /app/public
COPY _static_server.js /app/_static_server.js
CMD ["node", "/app/_static_server.js"]
`;
  writeFileSync(resolve(dir, 'Dockerfile'), content);
}

function ensureDockerignore(dir: string) {
  if (existsSync(resolve(dir, '.dockerignore'))) return;
  writeFileSync(resolve(dir, '.dockerignore'), `node_modules\n.git\n*.tar.gz\n.env\n`);
}

export function ensureDockerfile(dir: string, type: string) {
  if (existsSync(resolve(dir, 'Dockerfile'))) return;
  if (type === 'node') generateNodeDockerfile(dir);
  if (type === 'static') generateStaticDockerfile(dir);
  ensureDockerignore(dir);
}

// ── Docker build & run ──────────────────────────────────────────────────────

export interface BuildResult {
  tag: string;
  output: string;
  success: boolean;
  duration: number;
}

// Hard cap on docker build wall-clock. 15 min covers heavy multi-stage builds
// (full Rust/Java compiles, base image pulls) without giving a stuck `RUN`
// that's waiting for stdin enough rope to block deploys indefinitely.
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
let buildxAvailable: boolean | null = null;
const BUILDX_BUILDER = 'deploy-local';

function hasBuildx(): boolean {
  if (buildxAvailable === null) {
    if (spawnSync('docker', ['buildx', 'version'], { stdio: 'ignore' }).status !== 0) {
      buildxAvailable = false;
    } else if (
      spawnSync('docker', ['buildx', 'inspect', BUILDX_BUILDER], { stdio: 'ignore' }).status === 0
    ) {
      buildxAvailable = true;
    } else {
      // A dedicated docker-container builder supports portable local cache
      // import/export even when Docker's default builder does not.
      buildxAvailable =
        spawnSync(
          'docker',
          ['buildx', 'create', '--name', BUILDX_BUILDER, '--driver', 'docker-container'],
          { stdio: 'ignore' },
        ).status === 0;
    }
  }
  return buildxAvailable;
}

export function buildImage(
  name: string,
  dir: string,
  onLine?: (line: string, timestamp: string) => void,
  options?: { noCache?: boolean; timeoutMs?: number },
): Promise<BuildResult> {
  const tag = `deploy-sh-${name.toLowerCase()}`;
  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ?? BUILD_TIMEOUT_MS;

  // Default path reuses the previous build's image as a layer cache. When the
  // caller asks for `noCache`, skip --cache-from (so nothing is pulled forward)
  // and add --no-cache (so even local intermediates are ignored). This is the
  // escape hatch for cases where a prior build cached a corrupted COPY layer
  // and subsequent builds keep replaying it.
  const dataDir = process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
  const cacheDir = resolve(dataDir, 'build-cache', name.toLowerCase());
  mkdirSync(cacheDir, { recursive: true });
  const useBuildx = hasBuildx();
  let buildArgs: string[];
  if (useBuildx) {
    buildArgs = ['buildx', 'build', '--builder', BUILDX_BUILDER, '--load'];
    if (options?.noCache) {
      buildArgs.push('--no-cache');
    } else {
      if (existsSync(resolve(cacheDir, 'index.json'))) {
        buildArgs.push('--cache-from', `type=local,src=${cacheDir}`);
      }
      buildArgs.push('--cache-to', `type=local,dest=${cacheDir},mode=max`);
    }
    buildArgs.push('-t', tag, '.');
  } else {
    buildArgs = options?.noCache
      ? ['build', '--no-cache', '-t', tag, '.']
      : ['build', '--cache-from', tag, '-t', tag, '.'];
  }

  return new Promise((resolve) => {
    const proc = spawn('docker', buildArgs, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;

    function handleData(data: Buffer) {
      const str = data.toString();
      process.stdout.write(data);
      const ts = new Date().toISOString();
      for (const line of str.split('\n')) {
        if (line) {
          output += `[${ts}] ${line}\n`;
          if (onLine) onLine(line, ts);
        }
      }
    }

    proc.stdout?.on('data', handleData);
    proc.stderr?.on('data', handleData);

    // Kill the build if it exceeds the wall-clock budget. SIGTERM first to
    // give docker a chance to clean up its buildkit session; SIGKILL 5s
    // later as a hard floor in case docker is wedged.
    const killTimer = setTimeout(() => {
      timedOut = true;
      const msg = `Build exceeded ${Math.round(timeoutMs / 1000)}s timeout — killing docker build`;
      console.warn(`[Docker] ${msg}`);
      const ts = new Date().toISOString();
      output += `[${ts}] ${msg}\n`;
      if (onLine) onLine(msg, ts);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000).unref();
    }, timeoutMs);
    killTimer.unref();

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      const duration = Date.now() - startTime;
      const success = code === 0 && !timedOut;
      resolve({ tag, output, success, duration });
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      const duration = Date.now() - startTime;
      const failOutput = `Failed to start docker build: ${err.message}`;
      resolve({ tag, output: failOutput, success: false, duration });
    });
  });
}

// Canonical definition lives with the TCP proxy that consumes the mappings.
export type { ExtraPortMapping } from './tcp-proxy.ts';
import type { ExtraPortMapping } from './tcp-proxy.ts';

function buildEnvFlags(envVars?: Record<string, string>): string[] {
  if (!envVars) return [];
  const flags: string[] = [];
  for (const [k, v] of Object.entries(envVars)) {
    flags.push('-e', `${k}=${v}`);
  }
  return flags;
}

// ── Volume mount helpers ────────────────────────────────────────────────────

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

// Always-blocked host paths. Even with privilegedDocker, these can never be mounted.
const FORBIDDEN_HOST_PATHS = ['/etc', '/proc', '/sys', '/dev', '/boot'];
// Host paths that are blocked unless the deployment has explicit elevated permissions.
const PRIVILEGED_HOST_PATHS = ['/var/run/docker.sock'];
const RESERVED_CONTAINER_PATHS = ['/app/data', '/app/uploads'];

export function validateVolumeMounts(
  volumes: VolumeMount[],
  options?: { privilegedDocker?: boolean },
): string | null {
  const privilegedDocker = options?.privilegedDocker === true;
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i];

    if (!v.hostPath.startsWith('/')) {
      return `Volume ${i + 1}: host path must be absolute (start with /)`;
    }
    if (!v.containerPath.startsWith('/')) {
      return `Volume ${i + 1}: container path must be absolute (start with /)`;
    }
    if (v.hostPath.includes('..')) {
      return `Volume ${i + 1}: host path must not contain ".."`;
    }
    if (v.containerPath.includes('..')) {
      return `Volume ${i + 1}: container path must not contain ".."`;
    }
    if (!existsSync(v.hostPath)) {
      return `Volume ${i + 1}: host path "${v.hostPath}" does not exist`;
    }
    for (const fp of FORBIDDEN_HOST_PATHS) {
      if (v.hostPath === fp || v.hostPath.startsWith(fp + '/')) {
        return `Volume ${i + 1}: mounting "${fp}" is not allowed`;
      }
    }
    for (const fp of PRIVILEGED_HOST_PATHS) {
      if ((v.hostPath === fp || v.hostPath.startsWith(fp + '/')) && !privilegedDocker) {
        return `Volume ${i + 1}: mounting "${fp}" requires privilegedDocker to be enabled for this deployment`;
      }
    }
    if (RESERVED_CONTAINER_PATHS.includes(v.containerPath)) {
      return `Volume ${i + 1}: container path "${v.containerPath}" is reserved for managed volumes`;
    }
  }
  return null;
}

function buildCustomVolumeFlags(customVolumes?: VolumeMount[]): string[] {
  if (!customVolumes || customVolumes.length === 0) return [];
  const flags: string[] = [];
  for (const v of customVolumes) {
    const suffix = v.readOnly ? ':ro' : '';
    flags.push('-v', `${v.hostPath}:${v.containerPath}${suffix}`);
  }
  return flags;
}

async function ensureDockerNetworks(networks: NonNullable<DeployConfig['docker']>['networks']) {
  for (const network of networks) {
    try {
      await execFileAsync('docker', ['network', 'inspect', network.name]);
      continue;
    } catch {
      const args = ['network', 'create'];
      if (network.driver) args.push('--driver', network.driver);
      if (network.subnet) args.push('--subnet', network.subnet);
      for (const [key, value] of Object.entries(network.labels)) {
        args.push('--label', `${key}=${value}`);
      }
      args.push(network.name);
      try {
        await execFileAsync('docker', args);
        console.log(`[Docker] Created network ${network.name}`);
      } catch (err) {
        // Another concurrent deploy may have created it between inspect and
        // create. Re-inspect before treating the operation as failed.
        try {
          await execFileAsync('docker', ['network', 'inspect', network.name]);
        } catch {
          throw err;
        }
      }
    }
  }
}

export async function runContainer(
  imageTag: string,
  name: string,
  port: number,
  volumeDir?: string,
  config?: DeployConfig,
  envVars?: Record<string, string>,
  memoryLimit?: string,
  customVolumes?: VolumeMount[],
  gpuEnabled?: boolean,
  privilegedDocker?: boolean,
  cpuLimit?: string,
  containerNameOverride?: string,
  options?: {
    /** When true, do NOT remove an existing container with the target name.
     *  Used by blue/green where the old container has already been renamed
     *  out of the way. */
    skipExistingRemoval?: boolean;
    /** When set, copy SSH host keys from this container name instead of
     *  the target containerName (which may not exist yet in blue/green). */
    sshKeysSourceContainer?: string;
  },
) {
  const containerName = containerNameOverride ?? `deploy-sh-${name.toLowerCase()}`;
  const appPort = config?.port ?? 3000;
  const configuredNetworks = config?.docker?.networks ?? [];
  await ensureDockerNetworks(configuredNetworks);

  // Persist SSH host keys from the old container before destroying it.
  // This prevents "REMOTE HOST IDENTIFICATION HAS CHANGED" errors on recreate.
  const sshKeysDir = volumeDir ? join(volumeDir, '.ssh-host-keys') : null;
  const sshSource = options?.sshKeysSourceContainer ?? containerName;
  if (sshKeysDir && config?.ports?.length) {
    try {
      mkdirSync(sshKeysDir, { recursive: true });
      await execFileAsync('docker', ['cp', `${sshSource}:/etc/ssh/.`, `${sshKeysDir}/`]);
      console.log(`[Docker] Saved SSH host keys for ${name}`);
    } catch {
      // Old container doesn't exist or has no /etc/ssh/ — skip
    }
  }

  // Remove old container with same name if it exists — skipped for blue/green
  // since the orchestrator has already renamed it to a temporary name.
  if (!options?.skipExistingRemoval) {
    await removeContainerByName(containerName);
  }

  // Build volume mount flags
  const volumeArgs: string[] = [];
  if (volumeDir) {
    const dataVolume = resolve(volumeDir, 'data');
    const uploadsVolume = resolve(volumeDir, 'uploads');

    // Ensure directories exist
    mkdirSync(dataVolume, { recursive: true });
    mkdirSync(uploadsVolume, { recursive: true });

    volumeArgs.push('-v', `${dataVolume}:/app/data`, '-v', `${uploadsVolume}:/app/uploads`);

    // Mount persisted SSH host keys if they exist (preserves fingerprints across recreations)
    if (sshKeysDir && existsSync(sshKeysDir) && readdirSync(sshKeysDir).length > 0) {
      volumeArgs.push('-v', `${sshKeysDir}:/etc/ssh`);
      console.log(`[Docker] Mounting persisted SSH host keys for ${name}`);
    }
  }

  // Build extra port flags
  const extraPorts: ExtraPortMapping[] = [];
  const extraPortArgs: string[] = [];
  if (config?.ports?.length) {
    for (const p of config.ports) {
      // Always use a random host port so the TCP proxy can bind to the container port on 0.0.0.0
      const hostPort = await getAvailablePort();
      const protocol = p.protocol || 'tcp';
      extraPortArgs.push('-p', `${hostPort}:${p.container}/${protocol}`);
      extraPorts.push({ container: p.container, host: hostPort, protocol });
    }
  }

  // Build user env var flags
  const envFlags = buildEnvFlags(envVars);
  const customVolumeFlags = buildCustomVolumeFlags(customVolumes);

  const gpuFlags = gpuEnabled ? ['--gpus', 'all'] : [];

  // Privileged Docker: mount host Docker socket so the container can spawn sibling containers.
  // Skip if the user already added it explicitly via customVolumes (avoids -v conflicts).
  const dockerSocketAlreadyMounted = (customVolumes || []).some(
    (v) => v.hostPath === '/var/run/docker.sock',
  );
  const privilegedDockerFlags =
    privilegedDocker && !dockerSocketAlreadyMounted
      ? ['-v', '/var/run/docker.sock:/var/run/docker.sock']
      : [];

  // CPU + restart policy: bound any single container's CPU share so a runaway
  // app can't starve the others, and auto-recover from crashes (Docker will
  // restart the container after non-zero exit, but not after explicit `docker
  // stop`). Health checks are added separately via HEALTHCHECK in Dockerfile or
  // via deploy-sh's own reconciler loop.
  const cpuFlags = cpuLimit ? ['--cpus', cpuLimit] : ['--cpus', '2.0'];
  const restartFlags = ['--restart', 'unless-stopped'];
  const networkFlags =
    configuredNetworks.length > 0 ? ['--network', configuredNetworks[0].name] : [];
  const customRunArgs = config?.docker?.runArgs ?? [];

  const args = [
    'run',
    '-d',
    '-m',
    memoryLimit || '4g',
    ...cpuFlags,
    ...restartFlags,
    ...gpuFlags,
    ...networkFlags,
    '--name',
    containerName,
    '-p',
    `${port}:${appPort}`,
    '-e',
    `PORT=${appPort}`,
    ...envFlags,
    ...extraPortArgs,
    ...volumeArgs,
    ...customVolumeFlags,
    ...privilegedDockerFlags,
    '--label',
    `deploy-sh.app=${name.toLowerCase()}`,
    ...customRunArgs,
    imageTag,
  ];

  await execFileAsync('docker', args);

  for (const network of configuredNetworks.slice(1)) {
    await execFileAsync('docker', ['network', 'connect', network.name, containerName]);
  }

  // Get the container ID
  const info = await inspectContainer(containerName);
  const id = info?.Id ?? '';

  return { id, containerName, extraPorts };
}

// ── Blue/green helpers ──────────────────────────────────────────────────────
// Zero-downtime deploys require the old container to keep serving while the
// new one comes up. We rename the existing container out of the way (instead
// of removing it) so the new container can take the canonical name and the
// reverse proxy can switch over atomically by updating deployment.port. The
// old container is removed after a drain window.

/** Returns true if a Docker container with the exact name exists (any state). */
export async function containerExists(name: string): Promise<boolean> {
  try {
    return (await inspectContainer(name)) !== null;
  } catch {
    return false;
  }
}

/** Rename a container. Throws if the source doesn't exist or the dest is taken. */
export async function renameContainerByName(oldName: string, newName: string): Promise<void> {
  await apiRenameContainer(oldName, newName);
}

/** Force-remove a container by exact name. Silent on missing. */
export async function removeContainerByName(name: string): Promise<void> {
  try {
    await apiRemoveContainer(name);
  } catch {
    // ignore
  }
}

/**
 * Remove leftover blue/green drain containers (`deploy-sh-<app>-prev-<ts>`).
 * The drain removal is a setTimeout in the deploy path — if the server dies
 * inside the 30s window, the renamed container survives with
 * `--restart unless-stopped` and runs forever. Called on startup.
 */
export async function sweepOrphanedPrevContainers(): Promise<string[]> {
  try {
    const containers = await listDeployContainers();
    const orphans = containers
      .map((c) => c.Names[0]?.replace(/^\//, ''))
      .filter((n): n is string => !!n && /^deploy-sh-.+-prev-\d+$/.test(n));
    for (const name of orphans) {
      try {
        await apiRemoveContainer(name);
        console.log(`[Docker] Removed orphaned blue/green container ${name}`);
      } catch (err) {
        console.warn(`[Docker] Failed to remove orphaned container ${name}:`, err);
      }
    }
    return orphans;
  } catch {
    return [];
  }
}

/**
 * TCP-probe a port until it accepts connections or the deadline passes.
 * The container's main process binds before serving traffic, so a successful
 * connect is a reasonable proxy for "ready". Most app frameworks (express,
 * fastify, etc.) listen() before the event loop hits user code.
 */
export function healthCheckPort(port: number, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = createConnection({ port, host: '127.0.0.1' });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (ok) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 250);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      // Hard cap a single connect attempt at 1s so a slow accept doesn't burn
      // the whole deadline on one probe.
      setTimeout(() => done(false), 1000);
    }
    attempt();
  });
}

export async function stopContainer(name: string): Promise<void> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    // Just stop the container, don't remove it (so we can restart later)
    await apiStopContainer(containerName);
  } catch {
    // ignore if already stopped or doesn't exist
  }
}

export async function startContainer(name: string): Promise<void> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  // Start a previously-stopped container (preserves its volumes/config).
  await apiStartContainer(containerName);
}

export async function removeContainer(name: string): Promise<void> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    await apiRemoveContainer(containerName);
  } catch {
    // ignore if already gone
  }
}

/** Container status via the Engine API. 'stopped' when the container doesn't exist. */
export async function getContainerStatusAsync(name: string): Promise<string> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    const info = await inspectContainer(containerName);
    return info?.State?.Status || 'stopped';
  } catch {
    return 'stopped';
  }
}

export function streamLogs(name: string) {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  return spawn('docker', ['logs', '-f', containerName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function getContainerLogs(name: string, tail = 1000): Promise<string> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['logs', '--tail', String(Number(tail)), '--timestamps', containerName],
      { maxBuffer: 50 * 1024 * 1024 },
    );
    // docker logs writes the container's stderr stream to stderr; both are log content.
    return stdout + stderr;
  } catch {
    return '';
  }
}

/**
 * Async version of captureContainerLogs — uses spawn + stream collection to avoid
 * blocking the event loop with a potentially large synchronous buffer allocation.
 */
export function captureContainerLogsAsync(name: string): Promise<string> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  return new Promise((resolve) => {
    const proc = spawn('docker', ['logs', '--tail', '50000', containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));

    proc.on('close', () => {
      if (chunks.length === 0) {
        resolve('');
        return;
      }
      const raw = Buffer.concat(chunks).toString();
      const ts = new Date().toISOString();
      const result = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => `[${ts}] ${line}`)
        .join('\n');
      resolve(result);
    });

    proc.on('error', () => {
      resolve('');
    });
  });
}

export interface ContainerInspect {
  id: string;
  image: string;
  created: string;
  started: number | null;
  finished: string;
  status: string;
  restartCount: number;
  platform: string;
  ports: Record<string, unknown>;
  env: string[];
}

/** Async — safe in HTTP request handlers and RSC action workers alike. */
export async function getContainerInspectAsync(name: string): Promise<ContainerInspect | null> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    const info = await inspectContainer(containerName);
    if (!info) return null;
    return {
      id: info.Id,
      image: info.Config?.Image,
      created: info.Created,
      started: null, // populated by callers from DB (deployments.containerStartedAt)
      finished: info.State?.FinishedAt,
      status: info.State?.Status,
      restartCount: info.RestartCount || 0,
      platform: info.Platform,
      ports: info.NetworkSettings?.Ports || {},
      env: (info.Config?.Env || []).filter(
        (e: string) =>
          !e.startsWith('PATH=') && !e.startsWith('NODE_VERSION=') && !e.startsWith('YARN_'),
      ),
    };
  } catch {
    return null;
  }
}

export interface ContainerStats {
  cpu: string;
  mem: string;
  memPerc: string;
  net: string;
  block: string;
  pids: string;
}

export async function getContainerStats(name: string): Promise<ContainerStats | null> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  // Prefer the streaming registry (instant, main process); fall back to a
  // one-shot API sample (~1s, no fork) in contexts where the monitor isn't
  // running, e.g. RSC action worker threads.
  const live =
    getLiveStats().find((s) => s.containerName === containerName) ??
    (await fetchStatsOnce(containerName));
  if (!live) return null;
  return {
    cpu: `${live.cpuPercent.toFixed(2)}%`,
    mem: `${formatBytesBin(live.memUsageBytes)} / ${formatBytesBin(live.memLimitBytes)}`,
    memPerc: `${live.memPercent.toFixed(2)}%`,
    net: `${formatBytesBin(live.netRxBytes)} / ${formatBytesBin(live.netTxBytes)}`,
    block: `${formatBytesBin(live.blockReadBytes)} / ${formatBytesBin(live.blockWriteBytes)}`,
    pids: String(live.pids),
  };
}

// Binary-unit formatter matching `docker stats` display strings ("1.94GiB").
function formatBytesBin(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(2)}${unit}`;
}

export interface RawContainerStats {
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  timestamp: number;
}

export async function getContainerStatsRaw(name: string): Promise<RawContainerStats | null> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  const live =
    getLiveStats().find((s) => s.containerName === containerName) ??
    (await fetchStatsOnce(containerName));
  if (!live) return null;
  return {
    cpuPercent: live.cpuPercent,
    memUsageBytes: live.memUsageBytes,
    memLimitBytes: live.memLimitBytes,
    memPercent: live.memPercent,
    netRxBytes: live.netRxBytes,
    netTxBytes: live.netTxBytes,
    blockReadBytes: live.blockReadBytes,
    blockWriteBytes: live.blockWriteBytes,
    pids: live.pids,
    timestamp: live.sampledAt,
  };
}

export interface AllContainerStatsEntry {
  containerName: string;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  onlineCpus: number;
}

/**
 * Live per-container stats from the streaming registry (one stats stream per
 * running container, latest ~1s sample kept in memory). Replaces the old
 * `docker stats --no-stream` fork that blocked ~1s per sample behind a 15s
 * TTL cache. Starting the monitor is idempotent and lazy.
 */
export async function getAllContainerStats(): Promise<AllContainerStatsEntry[]> {
  startStatsMonitor();
  return getLiveStats().map((s) => ({
    containerName: s.containerName,
    cpuPercent: s.cpuPercent,
    memUsageBytes: s.memUsageBytes,
    memLimitBytes: s.memLimitBytes,
    memPercent: s.memPercent,
    netRxBytes: s.netRxBytes,
    netTxBytes: s.netTxBytes,
    blockReadBytes: s.blockReadBytes,
    blockWriteBytes: s.blockWriteBytes,
    pids: s.pids,
    onlineCpus: s.onlineCpus,
  }));
}

// Internal: GET /containers/json on the Engine API. Cached by `statusCache`
// and invalidated by the docker events subscriber (see `startDockerEventStream`).
async function getAllContainerStatusesUncached(): Promise<Map<string, string>> {
  try {
    const containers = await listDeployContainers();
    const map = new Map<string, string>();
    for (const c of containers) {
      const containerName = c.Names[0]?.replace(/^\//, '');
      if (!containerName?.startsWith('deploy-sh-')) continue;
      map.set(containerName.replace('deploy-sh-', ''), c.State);
    }
    return map;
  } catch {
    return new Map();
  }
}

// 5s TTL is short because the event-stream subscriber invalidates this on
// any state change — the TTL only matters when events aren't flowing
// (e.g. docker daemon restart) or for cold reads.
const statusCache = new TtlCache(getAllContainerStatusesUncached, 5_000);

/**
 * Get statuses for all deploy-sh containers. Async + cached + event-driven.
 * Returns a Map of lowercase app name -> Docker state string.
 */
export function getAllContainerStatuses(): Promise<Map<string, string>> {
  return statusCache.get();
}

/**
 * RestartCount for all deploy-sh containers — one list call plus parallel
 * per-container inspects over the unix socket (each ~1ms, no fork). Includes
 * stopped containers, since a crash-looped container that finally died still
 * has a non-zero count we want to consider. Consumed by the crash-loop
 * tracker on the metrics-collector tick.
 */
export async function getAllContainerRestartCounts(): Promise<Map<string, number>> {
  try {
    const containers = await listDeployContainers();
    const names = containers
      .map((c) => c.Names[0]?.replace(/^\//, ''))
      .filter((n): n is string => !!n && n.startsWith('deploy-sh-'));
    if (names.length === 0) return new Map();

    const map = new Map<string, number>();
    await Promise.all(
      names.map(async (containerName) => {
        const info = await inspectContainer(containerName).catch(() => null);
        if (info) {
          map.set(containerName.replace(/^deploy-sh-/, ''), info.RestartCount || 0);
        }
      }),
    );
    return map;
  } catch {
    return new Map();
  }
}

/** Force a refresh on next read. Used by lifecycle/upload paths after a known mutation. */
export function invalidateContainerStatusCache() {
  statusCache.invalidate();
}

// ── Docker event stream subscriber ──────────────────────────────────────────
// Subscribe to the Engine API's /events stream for our deploy-sh-* containers
// so the status cache stays hot without polling. One long-lived HTTP stream
// on the unix socket replaces the previous `docker events` child process.

let dockerEventAbort: (() => void) | null = null;
let dockerEventRestartTimer: ReturnType<typeof setTimeout> | null = null;
type StatusListener = (name: string, status: string) => void;
const statusListeners = new Set<StatusListener>();

export function onContainerStatusChange(listener: StatusListener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

interface DockerApiEvent {
  Action?: string;
  Actor?: { Attributes?: { name?: string } };
}

export function startDockerEventStream() {
  if (dockerEventAbort) return;
  const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
  dockerEventAbort = dockerStream(
    `/events?filters=${filters}`,
    (obj) => {
      const ev = obj as DockerApiEvent;
      const containerName = ev.Actor?.Attributes?.name;
      if (!containerName || !containerName.startsWith('deploy-sh-')) return;
      // API actions can carry suffixes ("exec_create: sh") — take the verb.
      const action = (ev.Action ?? '').split(':')[0].trim();
      // Any change is a reason to drop the cache — next read will refresh.
      statusCache.invalidate();
      // Keep the streaming-stats registry's subscriptions exact.
      onContainerLifecycleEvent(containerName, action);
      // Notify listeners with the docker state derived from the action verb.
      const state = actionToState(action);
      if (state) {
        const name = containerName.replace('deploy-sh-', '');
        for (const listener of statusListeners) {
          try {
            listener(name, state);
          } catch {
            // listener errors must not break the event loop
          }
        }
      }
    },
    () => {
      // Stream dropped (daemon restart, socket hiccup). Wait 2s before
      // reconnecting so we don't busy-loop while docker is unreachable.
      dockerEventAbort = null;
      if (dockerEventRestartTimer) return;
      dockerEventRestartTimer = setTimeout(() => {
        dockerEventRestartTimer = null;
        startDockerEventStream();
      }, 2000);
    },
  );
}

export function stopDockerEventStream() {
  if (dockerEventRestartTimer) {
    clearTimeout(dockerEventRestartTimer);
    dockerEventRestartTimer = null;
  }
  if (dockerEventAbort) {
    dockerEventAbort();
    dockerEventAbort = null;
  }
}

function actionToState(action: string): string | null {
  switch (action) {
    case 'start':
    case 'unpause':
    case 'restart':
      return 'running';
    case 'die':
    case 'stop':
    case 'kill':
    case 'oom':
      return 'exited';
    case 'destroy':
      return 'stopped';
    case 'pause':
      return 'paused';
    case 'create':
      return 'created';
    default:
      return null;
  }
}

export async function restartContainer(name: string): Promise<void> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  await apiRestartContainer(containerName);
}

export async function recreateContainer(
  name: string,
  port: number,
  volumeDir: string | null,
  directory: string | null,
  envVars: Record<string, string>,
  memoryLimit?: string,
  customVolumes?: VolumeMount[],
  gpuEnabled?: boolean,
  extraPortsConfig?: Array<{ container: number; protocol?: string }>,
  privilegedDocker?: boolean,
  cpuLimit?: string,
) {
  const imageTag = `deploy-sh-${name.toLowerCase()}`;
  let config: DeployConfig = {};
  if (directory) {
    try {
      config = readDeployConfig(directory);
    } catch {
      // ignore missing config
    }
  }
  // UI-provided extra ports override deploy.json ports
  if (extraPortsConfig) {
    config.ports = extraPortsConfig;
  }
  return runContainer(
    imageTag,
    name,
    port,
    volumeDir || undefined,
    config,
    envVars,
    memoryLimit,
    customVolumes,
    gpuEnabled,
    privilegedDocker,
    cpuLimit,
  );
}

// Docker socket resolution lives in docker-api.ts (getDockerSocketPath),
// shared by the exec PTY plumbing below and the Engine API client.

export interface DockerExecSession extends EventEmitter {
  /** Write user input to the PTY's stdin. Returns false if the session is closed. */
  write(data: string | Buffer): boolean;
  /** Resize the PTY. Safe to call before the session is fully established. */
  resize(cols: number, rows: number): void;
  /** Tear down the session. */
  kill(): void;
  readonly closed: boolean;
}

/**
 * Open an interactive exec session against the container backing `name`.
 *
 * Uses the Docker HTTP API with `Tty: true` and a hijacked connection so the
 * shell runs under a real PTY — `stty` reports the right size, `top`/`vim`/
 * `htop` render correctly, signals propagate, and resize is a first-class
 * operation rather than an escape-sequence hack.
 */
export function execContainer(name: string, cols = 80, rows = 24): DockerExecSession {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  const session = new EventEmitter() as DockerExecSession;
  let socket: Socket | null = null;
  let execId: string | null = null;
  let closed = false;
  let pendingResize: { cols: number; rows: number } | null = null;

  Object.defineProperty(session, 'closed', { get: () => closed });

  function close(info: { code?: number | null; error?: string } = {}) {
    if (closed) return;
    closed = true;
    socket?.destroy();
    socket = null;
    session.emit('exit', { code: info.code ?? null, error: info.error });
  }

  session.write = (data) => {
    if (!socket || closed) return false;
    return socket.write(data);
  };

  session.kill = () => close({ code: null });

  session.resize = (newCols, newRows) => {
    if (closed) return;
    if (!execId) {
      // Session still starting — apply once we have an exec id.
      pendingResize = { cols: newCols, rows: newRows };
      return;
    }
    const req = http.request({
      socketPath: getDockerSocketPath(),
      method: 'POST',
      path: `/exec/${execId}/resize?h=${newRows}&w=${newCols}`,
      headers: { 'Content-Length': '0' },
    });
    req.on('error', () => {
      /* resize is best-effort; the next keystroke will repaint */
    });
    req.end();
  };

  (async () => {
    try {
      execId = await dockerExecCreate(containerName, cols, rows);
      if (closed) return;
      socket = await dockerExecStart(execId);
      if (closed) {
        socket.destroy();
        return;
      }
      // Belt-and-braces resize after start: older daemons ignore ConsoleSize,
      // and we may have queued a resize while the session was opening.
      const finalSize = pendingResize ?? { cols, rows };
      pendingResize = null;
      session.resize(finalSize.cols, finalSize.rows);

      socket.on('data', (chunk: Buffer) => session.emit('data', chunk));
      socket.on('end', () => close({ code: 0 }));
      socket.on('close', () => close({ code: 0 }));
      socket.on('error', (err) => close({ code: 1, error: err.message }));
    } catch (err) {
      close({ code: 1, error: (err as Error).message });
    }
  })();

  return session;
}

function dockerExecCreate(containerName: string, cols: number, rows: number): Promise<string> {
  const body = JSON.stringify({
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    // ConsoleSize is honored by Docker API >= 1.42; older daemons ignore it
    // and we follow up with an explicit /resize call after start.
    ConsoleSize: [rows, cols],
    Env: [`COLUMNS=${cols}`, `LINES=${rows}`, 'TERM=xterm-256color'],
    // Prefer bash for readline/history; fall back to sh if it isn't there.
    Cmd: [
      '/bin/sh',
      '-c',
      'if command -v bash >/dev/null 2>&1; then exec bash; else exec /bin/sh; fi',
    ],
  });
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        socketPath: getDockerSocketPath(),
        method: 'POST',
        path: `/containers/${encodeURIComponent(containerName)}/exec`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode !== 201) {
            reject(new Error(`docker exec create failed: ${res.statusCode} ${raw}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw) as { Id: string };
            resolvePromise(parsed.Id);
          } catch (err) {
            reject(err as Error);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function dockerExecStart(execId: string): Promise<Socket> {
  const body = JSON.stringify({ Detach: false, Tty: true });
  return new Promise((resolvePromise, reject) => {
    const req = http.request({
      socketPath: getDockerSocketPath(),
      method: 'POST',
      path: `/exec/${execId}/start`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Connection: 'Upgrade',
        Upgrade: 'tcp',
      },
    });
    req.on('upgrade', (_res, sock: Socket, head: Buffer) => {
      if (head.length) sock.unshift(head);
      resolvePromise(sock);
    });
    req.on('response', (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => reject(new Error(`docker exec start failed: ${res.statusCode} ${raw}`)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
