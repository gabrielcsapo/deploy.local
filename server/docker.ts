import { execSync, execFileSync, execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer, createConnection, type AddressInfo, type Socket } from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { DeployConfig } from './deploy-config.ts';
import { readDeployConfig } from './deploy-config.ts';

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
  const content = `FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN npm install --production
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
  const buildArgs = options?.noCache
    ? ['build', '--no-cache', '-t', tag, '.']
    : ['build', '--cache-from', tag, '-t', tag, '.'];

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

export interface ExtraPortMapping {
  container: number;
  host: number;
  protocol: string;
}

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

  // Persist SSH host keys from the old container before destroying it.
  // This prevents "REMOTE HOST IDENTIFICATION HAS CHANGED" errors on recreate.
  const sshKeysDir = volumeDir ? join(volumeDir, '.ssh-host-keys') : null;
  const sshSource = options?.sshKeysSourceContainer ?? containerName;
  if (sshKeysDir && config?.ports?.length) {
    try {
      mkdirSync(sshKeysDir, { recursive: true });
      execSync(`docker cp ${sshSource}:/etc/ssh/. ${sshKeysDir}/`, { stdio: 'pipe' });
      console.log(`[Docker] Saved SSH host keys for ${name}`);
    } catch {
      // Old container doesn't exist or has no /etc/ssh/ — skip
    }
  }

  // Remove old container with same name if it exists — skipped for blue/green
  // since the orchestrator has already renamed it to a temporary name.
  if (!options?.skipExistingRemoval) {
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: 'pipe' });
    } catch {
      // ignore
    }
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

  const args = [
    'run',
    '-d',
    '-m',
    memoryLimit || '4g',
    ...cpuFlags,
    ...restartFlags,
    ...gpuFlags,
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
    imageTag,
  ];

  execFileSync('docker', args, { stdio: 'pipe' });

  // Get the container ID
  const id = execSync(`docker inspect --format='{{.Id}}' ${containerName}`, {
    stdio: 'pipe',
  })
    .toString()
    .trim();

  return { id, containerName, extraPorts };
}

// ── Blue/green helpers ──────────────────────────────────────────────────────
// Zero-downtime deploys require the old container to keep serving while the
// new one comes up. We rename the existing container out of the way (instead
// of removing it) so the new container can take the canonical name and the
// reverse proxy can switch over atomically by updating deployment.port. The
// old container is removed after a drain window.

/** Returns true if a Docker container with the exact name exists (any state). */
export function containerExists(name: string): boolean {
  try {
    execSync(`docker inspect --format='{{.Id}}' ${name}`, {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Rename a container. Throws if the source doesn't exist or the dest is taken. */
export function renameContainerByName(oldName: string, newName: string) {
  execFileSync('docker', ['rename', oldName, newName], { stdio: 'pipe' });
}

/** Force-remove a container by exact name. Silent on missing. */
export function removeContainerByName(name: string) {
  try {
    execSync(`docker rm -f ${name}`, { stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    // ignore
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

export function stopContainer(name: string) {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    // Just stop the container, don't remove it (so we can restart later)
    execSync(`docker stop ${containerName}`, { stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    // ignore if already stopped or doesn't exist
  }
}

export function removeContainer(name: string) {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    // ignore if already gone
  }
}

export function getContainerStatus(name: string): string {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    const status = execSync(`docker inspect --format='{{.State.Status}}' ${containerName}`, {
      stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr to suppress "No such container" errors
    })
      .toString()
      .trim();
    return status;
  } catch {
    // Container doesn't exist - silently return stopped
    return 'stopped';
  }
}

/** Async version of getContainerStatus — use in HTTP request handlers to avoid blocking the event loop. */
export async function getContainerStatusAsync(name: string): Promise<string> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '--format={{.State.Status}}',
      containerName,
    ]);
    return stdout.trim();
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

export function getContainerLogs(name: string, tail = 1000): string {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    return execSync(`docker logs --tail ${Number(tail)} --timestamps ${containerName}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    }).toString();
  } catch {
    return '';
  }
}

export function captureContainerLogs(name: string): string {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    const raw = execSync(`docker logs --tail 50000 ${containerName}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    }).toString();
    const ts = new Date().toISOString();
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => `[${ts}] ${line}`)
      .join('\n');
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

export function getContainerInspect(name: string): ContainerInspect | null {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    const raw = execSync(`docker inspect ${containerName}`, {
      stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr to suppress "No such container" errors
    }).toString();
    const info = JSON.parse(raw)[0];
    return {
      id: info.Id,
      image: info.Config?.Image || info.Image,
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

/** Async version of getContainerInspect — use in HTTP request handlers to avoid blocking the event loop. */
export async function getContainerInspectAsync(name: string): Promise<ContainerInspect | null> {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', containerName]);
    const info = JSON.parse(stdout)[0];
    return {
      id: info.Id,
      image: info.Config?.Image || info.Image,
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

export function getContainerStats(name: string): ContainerStats | null {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  try {
    const raw = execSync(
      `docker stats --no-stream --format '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","memPerc":"{{.MemPerc}}","net":"{{.NetIO}}","block":"{{.BlockIO}}","pids":"{{.PIDs}}"}' ${containerName}`,
      { stdio: ['pipe', 'pipe', 'ignore'] }, // Ignore stderr to suppress "No such container" errors
    )
      .toString()
      .trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseBytes(str: string): number {
  const match = str.trim().match(/^([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB|TB|TiB)$/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    B: 1,
    kB: 1000,
    KiB: 1024,
    MB: 1e6,
    MiB: 1024 * 1024,
    GB: 1e9,
    GiB: 1024 * 1024 * 1024,
    TB: 1e12,
    TiB: 1024 * 1024 * 1024 * 1024,
  };
  return Math.round(val * (multipliers[unit] || 1));
}

function parsePair(str: string): [number, number] {
  const parts = str.split('/').map((s) => s.trim());
  return [parseBytes(parts[0]), parseBytes(parts[1] || '0')];
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

export function getContainerStatsRaw(name: string): RawContainerStats | null {
  const stats = getContainerStats(name);
  if (!stats) return null;
  const [memUsage, memLimit] = parsePair(stats.mem);
  const [netRx, netTx] = parsePair(stats.net);
  const [blockRead, blockWrite] = parsePair(stats.block);
  return {
    cpuPercent: parseFloat(stats.cpu) || 0,
    memUsageBytes: memUsage,
    memLimitBytes: memLimit,
    memPercent: parseFloat(stats.memPerc) || 0,
    netRxBytes: netRx,
    netTxBytes: netTx,
    blockReadBytes: blockRead,
    blockWriteBytes: blockWrite,
    pids: parseInt(stats.pids, 10) || 0,
    timestamp: Date.now(),
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
}

// Internal: actually shell out to `docker stats`. Cached by `statsCache` so
// concurrent callers within the TTL window share the result.
async function getAllContainerStatsUncached(): Promise<AllContainerStatsEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      [
        'stats',
        '--no-stream',
        '--format',
        '{"name":"{{.Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","memPerc":"{{.MemPerc}}","net":"{{.NetIO}}","block":"{{.BlockIO}}","pids":"{{.PIDs}}"}',
      ],
      { timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
    );
    const raw = stdout.trim();
    if (!raw) return [];

    return raw
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => {
        const s = JSON.parse(line);
        const [memUsage, memLimit] = parsePair(s.mem);
        const [netRx, netTx] = parsePair(s.net);
        const [blockRead, blockWrite] = parsePair(s.block);
        return {
          containerName: s.name as string,
          cpuPercent: parseFloat(s.cpu) || 0,
          memUsageBytes: memUsage,
          memLimitBytes: memLimit,
          memPercent: parseFloat(s.memPerc) || 0,
          netRxBytes: netRx,
          netTxBytes: netTx,
          blockReadBytes: blockRead,
          blockWriteBytes: blockWrite,
          pids: parseInt(s.pids, 10) || 0,
        };
      })
      .filter((entry) => entry.containerName.startsWith('deploy-sh-'));
  } catch {
    return [];
  }
}

// `docker stats --no-stream` samples CPU for ~1s; 15s TTL means at most one
// sample per 15s shared by every caller (HTTP handlers + metrics collector).
const statsCache = new TtlCache(getAllContainerStatsUncached, 15_000);

/**
 * Async, cached. Drop-in replacement for the old sync version.
 * Returns up-to-15s-stale stats so HTTP handlers don't pay the ~1s sample cost.
 */
export function getAllContainerStats(): Promise<AllContainerStatsEntry[]> {
  return statsCache.get();
}

// Internal: shell out to `docker ps`. Cached by `statusCache` and invalidated
// by the docker events subscriber (see `startDockerEventStream`).
async function getAllContainerStatusesUncached(): Promise<Map<string, string>> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '-a', '--filter', 'name=deploy-sh-', '--format', '{{.Names}}\t{{.State}}'],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    );
    const map = new Map<string, string>();
    const raw = stdout.trim();
    if (!raw) return map;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [containerName, state] = line.split('\t');
      const name = containerName.replace('deploy-sh-', '');
      map.set(name, state);
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
 * Batched RestartCount fetch for all deploy-sh containers. One `docker
 * inspect` call returns the field for every running deployment; consumed by
 * the crash-loop tracker on the metrics-collector tick.
 */
export async function getAllContainerRestartCounts(): Promise<Map<string, number>> {
  try {
    // List containers first so we know what to inspect — including stopped
    // ones, since a crash-looped container that finally died still has a
    // non-zero count we want to consider.
    const { stdout: psOut } = await execFileAsync(
      'docker',
      ['ps', '-a', '--filter', 'name=deploy-sh-', '--format', '{{.Names}}'],
      { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
    );
    const names = psOut
      .trim()
      .split('\n')
      .filter((n) => n.startsWith('deploy-sh-'));
    if (names.length === 0) return new Map();

    const { stdout: inspectOut } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{.Name}}\t{{.RestartCount}}', ...names],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    );

    const map = new Map<string, number>();
    for (const line of inspectOut.trim().split('\n')) {
      if (!line) continue;
      const [rawName, rawCount] = line.split('\t');
      // Docker prefixes inspect's .Name with a leading slash
      const normalized = rawName.replace(/^\/?/, '').replace(/^deploy-sh-/, '');
      const n = parseInt(rawCount, 10);
      if (!isNaN(n)) map.set(normalized, n);
    }
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
// Subscribe to `docker events` for our deploy-sh-* containers so we can keep
// the status cache hot without polling. One long-lived child process replaces
// what was previously a `docker ps` shell-out per request handler.

let dockerEventProc: ChildProcess | null = null;
let dockerEventRestartTimer: ReturnType<typeof setTimeout> | null = null;
type StatusListener = (name: string, status: string) => void;
const statusListeners = new Set<StatusListener>();

export function onContainerStatusChange(listener: StatusListener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function startDockerEventStream() {
  if (dockerEventProc) return;
  const proc = spawn(
    'docker',
    [
      'events',
      '--filter',
      'type=container',
      '--filter',
      'label=',
      '--format',
      '{{.Actor.Attributes.name}}\t{{.Action}}\t{{.Status}}',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  dockerEventProc = proc;

  let buf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const [containerName, action] = line.split('\t');
      if (!containerName || !containerName.startsWith('deploy-sh-')) continue;
      // Any change is a reason to drop the cache — next read will refresh.
      statusCache.invalidate();
      // Notify listeners with the docker state derived from the action verb.
      // Action verbs we care about: start, die, stop, kill, destroy, create, restart.
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
    }
  });

  const restart = () => {
    dockerEventProc = null;
    if (dockerEventRestartTimer) return;
    // Wait 2s before reconnecting so we don't busy-loop if docker is unreachable.
    dockerEventRestartTimer = setTimeout(() => {
      dockerEventRestartTimer = null;
      startDockerEventStream();
    }, 2000);
  };
  proc.on('close', restart);
  proc.on('error', () => {
    /* close fires next */
  });
}

export function stopDockerEventStream() {
  if (dockerEventRestartTimer) {
    clearTimeout(dockerEventRestartTimer);
    dockerEventRestartTimer = null;
  }
  if (dockerEventProc) {
    dockerEventProc.removeAllListeners('close');
    dockerEventProc.kill();
    dockerEventProc = null;
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

export function restartContainer(name: string) {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  execSync(`docker restart ${containerName}`, { stdio: 'pipe' });
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

// Resolve the active Docker daemon's unix socket. The CLI's context machinery
// is authoritative — Docker Desktop, Colima, OrbStack, and rootless installs
// all put the socket in different places, and DOCKER_HOST may override any of
// them. Cache the result so we don't fork a CLI per exec session.
let cachedDockerSocketPath: string | null = null;
function getDockerSocketPath(): string {
  if (cachedDockerSocketPath) return cachedDockerSocketPath;

  const host = process.env.DOCKER_HOST;
  if (host?.startsWith('unix://')) {
    cachedDockerSocketPath = host.slice('unix://'.length);
    return cachedDockerSocketPath;
  }

  // Ask the CLI which socket the active context resolves to.
  try {
    const out = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (out.startsWith('unix://')) {
      cachedDockerSocketPath = out.slice('unix://'.length);
      return cachedDockerSocketPath;
    }
  } catch {
    /* fall through to known defaults */
  }

  // Common fallbacks, in priority order.
  const candidates = [
    '/var/run/docker.sock',
    `${process.env.HOME ?? ''}/.docker/run/docker.sock`,
    `${process.env.HOME ?? ''}/.colima/default/docker.sock`,
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) {
      cachedDockerSocketPath = p;
      return cachedDockerSocketPath;
    }
  }
  cachedDockerSocketPath = '/var/run/docker.sock';
  return cachedDockerSocketPath;
}

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

function dockerExecCreate(
  containerName: string,
  cols: number,
  rows: number,
): Promise<string> {
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
      res.on('end', () =>
        reject(new Error(`docker exec start failed: ${res.statusCode} ${raw}`)),
      );
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
