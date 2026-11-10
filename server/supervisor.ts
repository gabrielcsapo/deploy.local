import { processMetrics, slowProcessLine, type ProcessMetrics } from './process-metrics.ts';
import { CoordinatorExecutor, serveCoordinatorExecutor } from './v2/coordinator-executor.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
/**
 * deploy.local supervisor — the production entry point.
 *
 * Spawns and supervises the control plane, edge, and Git storage service:
 *   1. control (dist/server.js, DEPLOY_ROLE=control) — API, builds, dashboard,
 *      Docker orchestration. Crashy surface area; restarting it never
 *      interrupts app traffic.
 *   2. edge (dist/edge.js) — TLS, reverse proxy, mDNS, TCP proxies. Tiny
 *      dependency surface; restarts in well under a second if it ever dies.
 *
 *   3. repositories (dist/workspace-repository-worker.js) — durable Git import/fetch.
 *      Independent from both request handling and ordinary-user coding workers.
 *
 * Restart policy: exponential backoff 250ms → 5s per child, reset after 60s
 * of healthy uptime. SIGTERM/SIGINT forward to all children; the supervisor
 * exits when asked to, never on a child crash.
 *
 * Deliberately dependency-free and tiny — this process must not crash.
 */

import { SupervisorRelay } from './supervisor-relay.ts';
import { rotateLogIfLarge } from './log-rotation.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer, type Socket, type Server } from 'node:net';
import { mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

interface ChildSpec {
  name: string;
  entry: string;
  cwd?: string;
  env: Record<string, string>;
}

const children: Array<{
  spec: ChildSpec;
  proc: ChildProcess | null;
  backoffMs: number;
  startedAt: number;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  /** When this process last sent a heartbeat; 0 until its first one. */
  lastBeat: number;
  metrics: ProcessMetrics | null;
}> = [];

let shuttingDown = false;
const switching = new Set<string>();
let updateServer: Server | undefined;

// ── Status socket ────────────────────────────────────────────────────────────
// Event stream for external observers (the macOS menu bar app) — NDJSON over
// a unix socket instead of periodically rewriting a status file, so idle
// steady state costs zero disk writes and observers learn of changes
// immediately. Liveness is free: the kernel closes the socket the moment the
// supervisor dies.
//
// Messages to subscribers:
//   {type:'status', supervisorPid, startedAt, children:[...]}  — on connect +
//     every child start/exit
//   {type:'fleet', ...}  — container count/consumption, published into this
//     socket by the control plane's metrics collector and relayed verbatim
//     (latest message replayed to new subscribers)
//   {type:'deployment', ...} — live notifications only, never replayed

const dataDir = resolve(process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data'));
const SOCK_PATH = resolve(dataDir, 'supervisor.sock');
const supervisorStartedAt = Date.now();

const subscribers = new Set<Socket>();
const relay = new SupervisorRelay(broadcast);
let statusServer: Server | null = null;

function statusLine(): string {
  return (
    JSON.stringify({
      type: 'status',
      supervisorPid: process.pid,
      startedAt: supervisorStartedAt,
      children: children.map((c) => ({
        name: c.spec.name,
        pid: c.proc?.pid ?? null,
        state: c.proc ? 'running' : shuttingDown ? 'stopped' : 'restarting',
        startedAt: c.startedAt,
        restarts: c.restarts,
        lastExit: c.lastExit,
        metrics: c.metrics,
      })),
    }) + '\n'
  );
}

function broadcast(line: string) {
  for (const sock of subscribers) {
    try {
      sock.write(line);
    } catch {
      sock.destroy();
    }
  }
}

function pushStatus() {
  if (subscribers.size > 0) broadcast(statusLine());
}

function startStatusSocket() {
  try {
    mkdirSync(dataDir, { recursive: true });
    unlinkSync(SOCK_PATH);
  } catch {
    // no stale socket — fine
  }
  const server = createNetServer((sock) => {
    subscribers.add(sock);
    const drop = () => {
      subscribers.delete(sock);
    };
    sock.on('close', drop);
    sock.on('error', drop);

    // Inbound lines are fleet/deployment publishes from the control plane; subscribers
    // (menu bar) never send. Cap the line buffer so a misbehaving client
    // can't grow memory.
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.length > 65_536) {
        sock.destroy();
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx + 1);
        buf = buf.slice(idx + 1);
        relay.receive(line);
      }
    });

    try {
      sock.write(statusLine());
      if (relay.fleetLine) sock.write(relay.fleetLine);
    } catch {
      sock.destroy();
    }
  });
  server.on('error', (err) => {
    // Status reporting is best-effort; supervision continues without it.
    console.error('[supervisor] status socket error:', (err as Error).message);
  });
  server.listen(SOCK_PATH, () => {
    // Under the systemd service the supervisor runs as root, so the socket is
    // created root-owned 0755. Linux enforces write permission on connect() to
    // a unix socket (unlike BSD/macOS, which ignores it), so the user-session
    // menu bar app would be refused. Open it to any local user — this is a
    // read-mostly status stream, the inbound path only relays fleet/deployment lines.
    try {
      chmodSync(SOCK_PATH, 0o666);
    } catch {
      // best-effort — status reporting must never break supervision
    }
    console.log(`[supervisor] status socket on ${SOCK_PATH}`);
  });
  server.unref();
  statusServer = server;
}

const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 5000;
const HEALTHY_RESET_MS = 60_000;

// ── Watchdog ─────────────────────────────────────────────────────────────────
// Restart-on-exit misses a child that is alive but wedged. Children send a heartbeat from
// their event loop (supervisor-heartbeat.ts); one that goes quiet for this long is killed, and
// the exit handler restarts it. SIGKILL, because a blocked event loop never runs a SIGTERM
// handler. A child is watched from its first heartbeat, so builds that predate heartbeats
// (a rollback target) are left alone.
const WATCHDOG_STALE_MS = Number(process.env.DEPLOY_WATCHDOG_STALE_MS) || 60_000;
const WATCHDOG_TICK_MS = Math.min(5000, Math.ceil(WATCHDOG_STALE_MS / 2));

function startWatchdog() {
  let lastTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    // A late tick means this process was suspended (machine sleep, SIGSTOP) and so were the
    // children: their heartbeats are old for the same reason. Start the clock again.
    const suspended = now - lastTick > WATCHDOG_TICK_MS * 3;
    lastTick = now;
    for (const child of children) {
      if (!child.proc || !child.lastBeat) continue;
      if (suspended) {
        child.lastBeat = now;
        continue;
      }
      const quiet = now - child.lastBeat;
      if (quiet < WATCHDOG_STALE_MS) continue;
      console.error(
        `[supervisor] ${child.spec.name} (pid ${child.proc.pid}) sent no heartbeat for ${Math.round(quiet / 1000)}s — killing it to restart`,
      );
      child.lastBeat = 0;
      child.proc.kill('SIGKILL');
    }
  }, WATCHDOG_TICK_MS);
  timer.unref();
}

function start(child: (typeof children)[number]) {
  if (shuttingDown) return;
  const { spec } = child;
  child.startedAt = Date.now();
  const proc = spawn(process.execPath, [spec.entry], {
    env: { ...process.env, ...spec.env, DEPLOY_DATA_DIR: dataDir },
    cwd: spec.cwd,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.proc = proc;
  child.lastBeat = 0;
  child.metrics = null;
  console.log(`[supervisor] started ${spec.name} (pid ${proc.pid})`);
  pushStatus();
  proc.on('message', (message: { type?: string; metrics?: unknown } | null) => {
    if (message?.type !== 'heartbeat' || child.proc !== proc) return;
    child.lastBeat = Date.now();
    const sample = processMetrics(message.metrics);
    if (!sample || (child.metrics && sample.sampledAt <= child.metrics.sampledAt)) return;
    child.metrics = sample;
    const line = slowProcessLine(spec.name, proc.pid, sample);
    if (line) console.warn(line);
    pushStatus();
  });

  const prefix = (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      if (line) console.log(`[${spec.name}] ${line}`);
    }
  };
  proc.stdout?.on('data', prefix);
  proc.stderr?.on('data', prefix);

  proc.on('exit', (code, signal) => {
    child.proc = null;
    child.lastExit = { code, signal, at: Date.now() };
    child.restarts++;
    pushStatus();
    if (shuttingDown || switching.has(spec.name)) return;
    const uptime = Date.now() - child.startedAt;
    if (uptime > HEALTHY_RESET_MS) child.backoffMs = BACKOFF_MIN_MS;
    console.error(
      `[supervisor] ${spec.name} exited (code=${code} signal=${signal}) after ${Math.round(uptime / 1000)}s — restarting in ${child.backoffMs}ms`,
    );
    setTimeout(() => {
      if (!switching.has(spec.name) && !child.proc) start(child);
    }, child.backoffMs);
    child.backoffMs = Math.min(child.backoffMs * 2, BACKOFF_MAX_MS);
  });
}

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[supervisor] ${signal} received, stopping children...`);
  pushStatus();
  statusServer?.close();
  updateServer?.close();
  try {
    unlinkSync(SOCK_PATH);
  } catch {
    // already gone
  }
  for (const child of children) {
    child.proc?.kill(signal);
  }
  // Children handle their own graceful shutdown; force-exit as a backstop.
  const timer = setTimeout(() => process.exit(0), 15_000);
  timer.unref();
  let remaining = children.filter((c) => c.proc).length;
  if (remaining === 0) process.exit(0);
  for (const child of children) {
    child.proc?.on('exit', () => {
      remaining--;
      if (remaining === 0) process.exit(0);
    });
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Control first: it creates/migrates the DB and generates certs on first
// boot; the edge polls for both before serving.
const specs: ChildSpec[] = [
  { name: 'pipelines', entry: resolve(here, 'workspace-pipeline-worker.js'), env: {} },
  { name: 'repositories', entry: resolve(here, 'workspace-repository-worker.js'), env: {} },
  {
    name: 'control',
    entry: resolve(here, 'server.js'),
    env: { DEPLOY_ROLE: 'control', DEPLOY_SUPERVISOR_TOKEN: randomUUID() },
  },
  {
    name: 'edge',
    entry: resolve(here, 'edge.js'),
    env: {},
  },
];

const updater = new CoordinatorExecutor({
  root: dataDir,
  entry: resolve(here, 'server.js'),
  switchBuild: async (entry, version, id, cwd) => {
    const child = children.find((child) => child.spec.name === 'control');
    if (!child) throw new Error('Coordinator supervision is unavailable');
    switching.add('control');
    try {
      if (child.proc) {
        const previous = child.proc;
        await new Promise<void>((resolve, reject) => {
          const force = setTimeout(() => previous.kill('SIGKILL'), 15_000);
          const deadline = setTimeout(
            () => reject(new Error('Previous coordinator did not stop')),
            20_000,
          );
          previous.once('exit', () => {
            clearTimeout(force);
            clearTimeout(deadline);
            resolve();
          });
          previous.kill('SIGTERM');
        });
      }
      const token = randomUUID();
      child.spec.entry = entry;
      child.spec.cwd = cwd;
      child.spec.env = {
        DEPLOY_ROLE: 'control',
        DEPLOY_SUPERVISOR_TOKEN: token,
        DEPLOY_COORDINATOR_VERSION: version || '',
        DEPLOY_COORDINATOR_RELEASE: id || '',
      };
      start(child);
      const replacement = child.proc;
      let healthySince = 0;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (!replacement || child.proc !== replacement)
          throw new Error('Replacement coordinator exited during startup');
        try {
          const response = await fetch(
            `http://127.0.0.1:${process.env.CONTROL_PORT || 7843}/api/internal/coordinator-ready`,
            { headers: { 'x-deploy-supervisor': token }, signal: AbortSignal.timeout(2000) },
          );
          const body = await response.json();
          if (!response.ok || body.token !== token || body.version !== (version || ''))
            throw new Error('Coordinator readiness mismatch');
          healthySince ||= Date.now();
          if (Date.now() - healthySince >= 30_000) return;
        } catch {
          healthySince = 0;
        }
        await delay(1000);
      }
      throw new Error('Replacement coordinator did not pass sustained startup');
    } finally {
      switching.delete('control');
    }
  },
});
await updater.recover();
specs.find((spec) => spec.name === 'control')!.entry = updater.currentEntry;
specs.find((spec) => spec.name === 'control')!.cwd = updater.currentCwd;
specs.find((spec) => spec.name === 'control')!.env.DEPLOY_COORDINATOR_VERSION =
  updater.currentVersion || '';
specs.find((spec) => spec.name === 'control')!.env.DEPLOY_COORDINATOR_RELEASE =
  updater.currentId || '';
updateServer = await serveCoordinatorExecutor(updater);
startStatusSocket();

for (const spec of specs) {
  const child = {
    spec,
    proc: null,
    backoffMs: BACKOFF_MIN_MS,
    startedAt: 0,
    restarts: 0,
    lastExit: null,
    lastBeat: 0,
    metrics: null,
  };
  children.push(child);
  start(child);
}
startWatchdog();

// The service manager appends this process's output to files under <data>/logs
// (scripts/service.mjs) and nothing else bounds them.
function rotateLogs() {
  rotateLogIfLarge({ fd: 1, path: resolve(dataDir, 'logs', 'server.log') });
  rotateLogIfLarge({ fd: 2, path: resolve(dataDir, 'logs', 'server.err.log') });
}
rotateLogs();
setInterval(rotateLogs, 10 * 60_000).unref();
