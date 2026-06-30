/**
 * Minimal Docker Engine API client over the daemon's unix socket.
 *
 * Why: every `docker ...` CLI invocation fork+execs a Go binary — momentarily
 * tens of MB RSS and ~30-100ms — and the steady-state paths (status polls,
 * stats sampling, restart counts, event stream, daemon ping) used to do this
 * constantly. Talking HTTP to the socket makes each of those a ~1ms local
 * round-trip with zero process churn.
 *
 * Deliberately NOT here:
 *  - `docker build` — BuildKit progress output is far better via the CLI.
 *  - `docker run` — translating the run flag surface (gpus → DeviceRequests,
 *    --cpus → NanoCpus, port bindings, binds, restart policy) is the most
 *    error-prone mapping with the lowest call frequency (once per deploy,
 *    dwarfed by the build it follows).
 *  - `docker logs`/`docker cp` — user-initiated, not steady-state churn, and
 *    the logs endpoint needs stream demultiplexing for non-TTY containers.
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// ── Socket resolution (moved from docker.ts; CLI context is authoritative) ──

let cachedDockerSocketPath: string | null = null;

export function getDockerSocketPath(): string {
  if (cachedDockerSocketPath) return cachedDockerSocketPath;

  const host = process.env.DOCKER_HOST;
  if (host?.startsWith('unix://')) {
    cachedDockerSocketPath = host.slice('unix://'.length);
    return cachedDockerSocketPath;
  }

  // Ask the CLI which socket the active context resolves to. One fork, once.
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

// ── Request helpers ──────────────────────────────────────────────────────────

export class DockerApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

/** One-shot JSON request. Resolves with the parsed body ('' for 204s). */
export function dockerRequest<T = unknown>(opts: RequestOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const req = http.request(
      {
        socketPath: getDockerSocketPath(),
        method: opts.method,
        path: opts.path,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            let message = raw;
            try {
              message = (JSON.parse(raw) as { message?: string }).message ?? raw;
            } catch {
              /* non-JSON error body */
            }
            reject(new DockerApiError(status, message.trim() || `HTTP ${status}`));
            return;
          }
          if (!raw) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            resolve(raw as T);
          }
        });
      },
    );
    req.setTimeout(opts.timeoutMs ?? 10_000, () => req.destroy(new Error('docker API timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Long-lived NDJSON stream (events, stats?stream=true). Calls onLine for each
 * parsed JSON object; onClose fires once when the stream ends or errors.
 * Returns an abort function.
 */
export function dockerStream(
  path: string,
  onLine: (obj: unknown) => void,
  onClose: (err?: Error) => void,
): () => void {
  const req = http.request({ socketPath: getDockerSocketPath(), method: 'GET', path }, (res) => {
    if ((res.statusCode ?? 0) >= 400) {
      res.resume();
      finish(new DockerApiError(res.statusCode ?? 0, `stream failed: HTTP ${res.statusCode}`));
      return;
    }
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          onLine(JSON.parse(line));
        } catch {
          // partial/garbled line — skip
        }
      }
    });
    res.on('end', () => finish());
    res.on('error', (err) => finish(err));
  });

  let finished = false;
  function finish(err?: Error) {
    if (finished) return;
    finished = true;
    onClose(err);
  }

  req.on('error', (err) => finish(err));
  req.end();

  return () => {
    finished = true; // suppress onClose for caller-initiated aborts
    req.destroy();
  };
}

// ── Typed endpoints ──────────────────────────────────────────────────────────

export async function pingDaemon(): Promise<boolean> {
  try {
    await dockerRequest({ method: 'GET', path: '/_ping', timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

export interface ApiContainerSummary {
  Id: string;
  /** Names come slash-prefixed: "/deploy-sh-myapp" */
  Names: string[];
  State: string; // running | exited | created | paused | restarting | dead
  Status: string; // human string, e.g. "Up 2 hours"
}

/** All containers (any state) whose name contains `deploy-sh-`. */
export function listDeployContainers(): Promise<ApiContainerSummary[]> {
  const filters = encodeURIComponent(JSON.stringify({ name: ['deploy-sh-'] }));
  return dockerRequest<ApiContainerSummary[]>({
    method: 'GET',
    path: `/containers/json?all=true&filters=${filters}`,
  });
}

export interface ApiContainerInspect {
  Id: string;
  Created: string;
  Platform: string;
  RestartCount: number;
  State: { Status: string; FinishedAt: string };
  Config: { Image: string; Env: string[] };
  NetworkSettings: { Ports: Record<string, unknown> };
}

export async function inspectContainer(containerName: string): Promise<ApiContainerInspect | null> {
  try {
    return await dockerRequest<ApiContainerInspect>({
      method: 'GET',
      path: `/containers/${encodeURIComponent(containerName)}/json`,
    });
  } catch (err) {
    if (err instanceof DockerApiError && err.status === 404) return null;
    throw err;
  }
}

// Lifecycle — thin POST/DELETE wrappers. 304 (already started/stopped) is not
// an error for our callers; the Engine API returns it as a status code which
// dockerRequest surfaces as success (<400... 304 is <400, body empty). 404s
// propagate as DockerApiError for callers that care.

export async function apiStartContainer(containerName: string): Promise<void> {
  await dockerRequest({
    method: 'POST',
    path: `/containers/${encodeURIComponent(containerName)}/start`,
  });
}

export async function apiStopContainer(containerName: string): Promise<void> {
  // Engine default kill-after matches `docker stop` (10s); stopping a
  // container can legitimately take that long, so widen the HTTP timeout.
  await dockerRequest({
    method: 'POST',
    path: `/containers/${encodeURIComponent(containerName)}/stop`,
    timeoutMs: 30_000,
  });
}

export async function apiRestartContainer(containerName: string): Promise<void> {
  await dockerRequest({
    method: 'POST',
    path: `/containers/${encodeURIComponent(containerName)}/restart`,
    timeoutMs: 30_000,
  });
}

export async function apiRenameContainer(oldName: string, newName: string): Promise<void> {
  await dockerRequest({
    method: 'POST',
    path: `/containers/${encodeURIComponent(oldName)}/rename?name=${encodeURIComponent(newName)}`,
  });
}

export async function apiRemoveContainer(containerName: string): Promise<void> {
  await dockerRequest({
    method: 'DELETE',
    path: `/containers/${encodeURIComponent(containerName)}?force=true`,
    timeoutMs: 30_000,
  });
}

// ── Streaming stats registry ─────────────────────────────────────────────────
// One GET /containers/{id}/stats?stream=true connection per running deploy-sh
// container. The daemon pushes a sample every ~1s; we keep only the latest.
// Replaces `docker stats --no-stream`, which forked the CLI and blocked ~1s
// sampling CPU deltas on every call.

export interface LiveContainerStats {
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
  /** Cores visible to the container (= the Docker VM's core count on macOS). */
  onlineCpus: number;
  /** ms epoch of the sample */
  sampledAt: number;
}

interface RawStatsSample {
  name?: string;
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { inactive_file?: number; cache?: number };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{ op?: string; value?: number }> | null;
  };
  pids_stats?: { current?: number };
}

function parseStatsSample(containerName: string, s: RawStatsSample): LiveContainerStats | null {
  // The first sample after a (re)start can arrive with empty precpu — skip it.
  const cpuTotal = s.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const cpuPrev = s.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const sysTotal = s.cpu_stats?.system_cpu_usage ?? 0;
  const sysPrev = s.precpu_stats?.system_cpu_usage ?? 0;
  const cpuDelta = cpuTotal - cpuPrev;
  const sysDelta = sysTotal - sysPrev;
  const onlineCpus = s.cpu_stats?.online_cpus || 1;
  const cpuPercent = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * onlineCpus * 100 : 0;

  // Match `docker stats` semantics: usage minus page cache (cgroup v2 keeps
  // it in inactive_file; v1 in cache).
  const memUsageRaw = s.memory_stats?.usage ?? 0;
  const memCache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
  const memUsageBytes = Math.max(0, memUsageRaw - memCache);
  const memLimitBytes = s.memory_stats?.limit ?? 0;
  const memPercent = memLimitBytes > 0 ? (memUsageBytes / memLimitBytes) * 100 : 0;

  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const iface of Object.values(s.networks ?? {})) {
    netRxBytes += iface.rx_bytes ?? 0;
    netTxBytes += iface.tx_bytes ?? 0;
  }

  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  for (const entry of s.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = (entry.op ?? '').toLowerCase();
    if (op === 'read') blockReadBytes += entry.value ?? 0;
    else if (op === 'write') blockWriteBytes += entry.value ?? 0;
  }

  return {
    containerName,
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memUsageBytes,
    memLimitBytes,
    memPercent: Math.round(memPercent * 100) / 100,
    netRxBytes,
    netTxBytes,
    blockReadBytes,
    blockWriteBytes,
    pids: s.pids_stats?.current ?? 0,
    onlineCpus,
    sampledAt: Date.now(),
  };
}

/**
 * One-shot stats sample. `stream=false` makes the daemon collect two samples
 * ~1s apart so the CPU delta is meaningful — same latency as the old
 * `docker stats --no-stream`, but no CLI fork. Used as a fallback where the
 * streaming registry isn't running (RSC action worker threads).
 */
export async function fetchStatsOnce(containerName: string): Promise<LiveContainerStats | null> {
  try {
    const sample = await dockerRequest<RawStatsSample>({
      method: 'GET',
      path: `/containers/${encodeURIComponent(containerName)}/stats?stream=false`,
      timeoutMs: 15_000,
    });
    return parseStatsSample(containerName, sample);
  } catch {
    return null;
  }
}

const statsSubscriptions = new Map<string, () => void>(); // containerName -> abort
const latestStats = new Map<string, LiveContainerStats>();
let statsMonitorRunning = false;
let statsResyncTimer: ReturnType<typeof setInterval> | null = null;

function subscribeStats(containerName: string) {
  if (statsSubscriptions.has(containerName)) return;
  const abort = dockerStream(
    `/containers/${encodeURIComponent(containerName)}/stats?stream=true`,
    (obj) => {
      const sample = parseStatsSample(containerName, obj as RawStatsSample);
      if (sample) latestStats.set(containerName, sample);
    },
    () => {
      // Stream closed: container stopped/removed or daemon went away. Drop
      // the cache entry; the periodic resync re-subscribes if it's running.
      statsSubscriptions.delete(containerName);
      latestStats.delete(containerName);
    },
  );
  statsSubscriptions.set(containerName, abort);
}

function unsubscribeStats(containerName: string) {
  statsSubscriptions.get(containerName)?.();
  statsSubscriptions.delete(containerName);
  latestStats.delete(containerName);
}

/** Reconcile stats subscriptions with the set of currently-running containers. */
async function resyncStatsSubscriptions() {
  try {
    const containers = await listDeployContainers();
    const running = new Set(
      containers
        .filter((c) => c.State === 'running')
        .map((c) => c.Names[0]?.replace(/^\//, ''))
        .filter((n): n is string => !!n),
    );
    for (const name of running) subscribeStats(name);
    for (const name of [...statsSubscriptions.keys()]) {
      if (!running.has(name)) unsubscribeStats(name);
    }
  } catch {
    // daemon unreachable — streams have already closed themselves; the next
    // resync tick re-establishes everything once it's back.
  }
}

/**
 * Start the stats monitor. Idempotent. Event-driven via onContainerEvent
 * (start/die) with a 60s resync sweep as the safety net.
 */
export function startStatsMonitor() {
  if (statsMonitorRunning) return;
  statsMonitorRunning = true;
  void resyncStatsSubscriptions();
  statsResyncTimer = setInterval(() => void resyncStatsSubscriptions(), 60_000);
  statsResyncTimer.unref?.();
}

export function stopStatsMonitor() {
  statsMonitorRunning = false;
  if (statsResyncTimer) {
    clearInterval(statsResyncTimer);
    statsResyncTimer = null;
  }
  for (const name of [...statsSubscriptions.keys()]) unsubscribeStats(name);
}

/** Latest sample per running deploy-sh container. Synchronous Map read. */
export function getLiveStats(): LiveContainerStats[] {
  return [...latestStats.values()];
}

/** Hook for the docker event stream: keep subscriptions exact between resyncs. */
export function onContainerLifecycleEvent(containerName: string, action: string) {
  if (!statsMonitorRunning) return;
  if (action === 'start' || action === 'unpause' || action === 'restart') {
    subscribeStats(containerName);
  } else if (action === 'die' || action === 'stop' || action === 'kill' || action === 'destroy') {
    unsubscribeStats(containerName);
  }
}
