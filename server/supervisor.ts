/**
 * deploy.local supervisor — the production entry point.
 *
 * Spawns and babysits the two halves of the system:
 *   1. control (dist/server.js, DEPLOY_ROLE=control) — API, builds, dashboard,
 *      Docker orchestration. Crashy surface area; restarting it never
 *      interrupts app traffic.
 *   2. edge (dist/edge.js) — TLS, reverse proxy, mDNS, TCP proxies. Tiny
 *      dependency surface; restarts in well under a second if it ever dies.
 *
 * Restart policy: exponential backoff 250ms → 5s per child, reset after 60s
 * of healthy uptime. SIGTERM/SIGINT forward to both children; the supervisor
 * exits when asked to, never on a child crash.
 *
 * Deliberately dependency-free and tiny — this process must not crash.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer, type Socket, type Server } from 'node:net';
import { mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

interface ChildSpec {
  name: string;
  entry: string;
  env: Record<string, string>;
}

const children: Array<{
  spec: ChildSpec;
  proc: ChildProcess | null;
  backoffMs: number;
  startedAt: number;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
}> = [];

let shuttingDown = false;

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

const dataDir = process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
const SOCK_PATH = resolve(dataDir, 'supervisor.sock');
const supervisorStartedAt = Date.now();

const subscribers = new Set<Socket>();
let lastFleetLine: string | null = null;
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

    // Inbound lines are fleet publishes from the control plane; subscribers
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
        try {
          if ((JSON.parse(line) as { type?: string }).type === 'fleet') {
            lastFleetLine = line;
            broadcast(line);
          }
        } catch {
          // ignore malformed lines — must not hurt supervision
        }
      }
    });

    try {
      sock.write(statusLine());
      if (lastFleetLine) sock.write(lastFleetLine);
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
    // read-mostly status stream, the inbound path only relays 'fleet' lines.
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

function start(child: (typeof children)[number]) {
  if (shuttingDown) return;
  const { spec } = child;
  child.startedAt = Date.now();
  const proc = spawn(process.execPath, [spec.entry], {
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.proc = proc;
  console.log(`[supervisor] started ${spec.name} (pid ${proc.pid})`);
  pushStatus();

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
    if (shuttingDown) return;
    const uptime = Date.now() - child.startedAt;
    if (uptime > HEALTHY_RESET_MS) child.backoffMs = BACKOFF_MIN_MS;
    console.error(
      `[supervisor] ${spec.name} exited (code=${code} signal=${signal}) after ${Math.round(uptime / 1000)}s — restarting in ${child.backoffMs}ms`,
    );
    setTimeout(() => start(child), child.backoffMs);
    child.backoffMs = Math.min(child.backoffMs * 2, BACKOFF_MAX_MS);
  });
}

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[supervisor] ${signal} received, stopping children...`);
  pushStatus();
  statusServer?.close();
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
  {
    name: 'control',
    entry: resolve(here, 'server.js'),
    env: { DEPLOY_ROLE: 'control' },
  },
  {
    name: 'edge',
    entry: resolve(here, 'edge.js'),
    env: {},
  },
];

startStatusSocket();

for (const spec of specs) {
  const child = {
    spec,
    proc: null,
    backoffMs: BACKOFF_MIN_MS,
    startedAt: 0,
    restarts: 0,
    lastExit: null,
  };
  children.push(child);
  start(child);
}
