import { execSync, execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import type { DeployConfig } from './deploy-config.ts';
import { readDeployConfig } from './deploy-config.ts';

const execFileAsync = promisify(execFile);

// Enable BuildKit by default for all Docker operations
process.env.DOCKER_BUILDKIT = '1';

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

export function buildImage(
  name: string,
  dir: string,
  onLine?: (line: string, timestamp: string) => void,
): Promise<BuildResult> {
  const tag = `deploy-sh-${name.toLowerCase()}`;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn('docker', ['build', '--cache-from', tag, '-t', tag, '.'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';

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

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;

      if (code === 0) {
        resolve({ tag, output, success: true, duration });
      } else {
        resolve({ tag, output, success: false, duration });
      }
    });

    proc.on('error', (err) => {
      const duration = Date.now() - startTime;
      const output = `Failed to start docker build: ${err.message}`;
      resolve({ tag, output, success: false, duration });
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

const FORBIDDEN_HOST_PATHS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/var/run/docker.sock'];
const RESERVED_CONTAINER_PATHS = ['/app/data', '/app/uploads'];

export function validateVolumeMounts(volumes: VolumeMount[]): string | null {
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
) {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  const appPort = config?.port ?? 3000;

  // Persist SSH host keys from old container before destroying it.
  // This prevents "REMOTE HOST IDENTIFICATION HAS CHANGED" errors on recreation.
  const sshKeysDir = volumeDir ? join(volumeDir, '.ssh-host-keys') : null;
  if (sshKeysDir && config?.ports?.length) {
    try {
      mkdirSync(sshKeysDir, { recursive: true });
      execSync(`docker cp ${containerName}:/etc/ssh/. ${sshKeysDir}/`, { stdio: 'pipe' });
      console.log(`[Docker] Saved SSH host keys for ${name}`);
    } catch {
      // Old container doesn't exist or has no /etc/ssh/ — skip
    }
  }

  // Remove old container with same name if it exists
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: 'pipe' });
  } catch {
    // ignore
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

  const args = [
    'run',
    '-d',
    '-m',
    memoryLimit || '4g',
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
  started: string;
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
      started: info.State?.StartedAt,
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
      started: info.State?.StartedAt,
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

export function getAllContainerStats(): AllContainerStatsEntry[] {
  try {
    const raw = execSync(
      `docker stats --no-stream --format '{"name":"{{.Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","memPerc":"{{.MemPerc}}","net":"{{.NetIO}}","block":"{{.BlockIO}}","pids":"{{.PIDs}}"}'`,
      { stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000 },
    )
      .toString()
      .trim();

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

/**
 * Get statuses for all deploy-sh containers in a single `docker ps` call.
 * Returns a Map of lowercase app name -> Docker state string.
 */
export function getAllContainerStatuses(): Map<string, string> {
  try {
    const raw = execSync(
      `docker ps -a --filter "name=deploy-sh-" --format '{{.Names}}\t{{.State}}'`,
      { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 },
    )
      .toString()
      .trim();

    const map = new Map<string, string>();
    if (!raw) return map;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [containerName, state] = line.split('\t');
      // Extract app name: deploy-sh-<name> -> <name>
      const name = containerName.replace('deploy-sh-', '');
      map.set(name, state);
    }
    return map;
  } catch {
    return new Map();
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
  );
}

export function execContainer(name: string, cols = 80, rows = 24) {
  const containerName = `deploy-sh-${name.toLowerCase()}`;
  // Use script(1) with -c flag (portable across GNU and BusyBox) to allocate
  // a PTY so the shell behaves interactively. Falls back to sh -i if unavailable.
  // Set initial terminal dimensions with stty after PTY allocation.
  const initCmd = ['script -q -c /bin/sh /dev/null 2>/dev/null || exec /bin/sh -i'].join(' && ');
  const proc = spawn(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `COLUMNS=${cols}`,
      '-e',
      `LINES=${rows}`,
      '-e',
      'TERM=xterm-256color',
      containerName,
      '/bin/sh',
      '-c',
      initCmd,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  // Set the PTY dimensions after the shell starts
  proc.stdin?.write(`stty cols ${cols} rows ${rows} 2>/dev/null\n`);
  return proc;
}
