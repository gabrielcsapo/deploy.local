import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticate, getDeployment, getNode } from './store.ts';
import { streamContainerLogs, execContainerByName, type DockerExecSession } from './docker.ts';
import { createAgentExecSession } from './agent-exec.ts';
import {
  resolveApplicationInstanceTarget,
  type ApplicationInstanceSelector,
  type ApplicationInstanceTarget,
} from './application-instance-target.ts';
import { on as onEvent, type DeployEvent } from './events.ts';
import type { ChildProcess } from 'node:child_process';

// Skip-send threshold for slow consumers. A client that can't drain its
// socket (sleepy laptop tailing a chatty container) otherwise buffers
// unboundedly in this process's memory.
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

// `Http2SecureServer` emits `'upgrade'` for HTTP/1.1 connections when
// `allowHTTP1: true` is set, which is how the `ws` library establishes a
// WebSocket. Accepting both server types here lets the same hook work in
// either mode without duplicating logic.
type UpgradableServer = HttpServer | Http2SecureServer;

interface AuthedSocket extends WebSocket {
  username?: string;
  authenticated: boolean;
  subscriptions: Set<string>;
  logProcess?: ChildProcess;
  execSession?: DockerExecSession;
  authTimer?: ReturnType<typeof setTimeout>;
  logSubscriptions: Map<string, string>;
}

// Shared log streams — one docker logs process per resolved graph container.
const logStreams = new Map<string, { proc: ChildProcess; clients: Set<AuthedSocket> }>();

let wss: WebSocketServer | null = null;

/**
 * Shared upgrade handler: dashboard /ws only. App-host upgrades (a deployed
 * app's own WebSocket endpoints — including a path that happens to be /ws)
 * are tunneled to the container by the upgrade proxy (edge/upgrade-proxy.ts);
 * grabbing them here would 401-destroy them against dashboard auth.
 */
function handleDashboardUpgrade(
  req: IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
) {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return;

  const hostname = (req.headers.host || '').split(':')[0];
  if (
    hostname.endsWith('.local') &&
    hostname !== 'deploy.local' &&
    hostname !== 'discover.local' &&
    getDeployment(hostname.slice(0, -'.local'.length))
  ) {
    return; // app host — the upgrade proxy owns this connection
  }

  wss!.handleUpgrade(req, socket, head, (ws) => {
    const client = ws as AuthedSocket;
    client.authenticated = false;
    client.subscriptions = new Set();
    client.logSubscriptions = new Map();
    wss!.emit('connection', client, req);
  });
}

export function setupWebSocket(server: UpgradableServer) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', handleDashboardUpgrade);

  wss.on('connection', (ws: AuthedSocket) => {
    ws.authTimer = setTimeout(() => {
      if (!ws.authenticated) ws.close(1008, 'Authentication timeout');
    }, 5_000);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!ws.authenticated) {
          const username = msg.auth?.username;
          const token = msg.auth?.token;
          if (
            typeof username !== 'string' ||
            typeof token !== 'string' ||
            !authenticate(username, token)
          ) {
            ws.close(1008, 'Unauthorized');
            return;
          }
          ws.username = username;
          ws.authenticated = true;
          clearTimeout(ws.authTimer);
          ws.authTimer = undefined;
          ws.send(JSON.stringify({ type: 'auth:ok', deploymentName: '', data: {} }));
          return;
        }
        if (msg.subscribe) {
          ws.subscriptions.add(msg.subscribe);
          if (parseLogSubscription(msg.subscribe)) startLogStream(msg.subscribe, ws);
        }
        if (msg.unsubscribe) {
          ws.subscriptions.delete(msg.unsubscribe);
          if (parseLogSubscription(msg.unsubscribe)) stopLogStream(msg.unsubscribe, ws);
        }
        // Exec session: start (with optional initial dimensions)
        if (msg.exec) {
          const cols = typeof msg.cols === 'number' ? msg.cols : 80;
          const rows = typeof msg.rows === 'number' ? msg.rows : 24;
          const request = parseExecRequest(msg.exec, msg);
          if (request) startExecSession(request.deploymentName, request.selector, ws, cols, rows);
        }
        // Exec session: input
        if (msg['exec:input'] != null) {
          ws.execSession?.write(msg['exec:input']);
        }
        // Exec session: resize PTY (Docker /exec/{id}/resize on the daemon)
        if (msg['exec:resize'] != null) {
          const { cols, rows } = msg['exec:resize'];
          if (typeof cols === 'number' && typeof rows === 'number') {
            ws.execSession?.resize(cols, rows);
          }
        }
        // Exec session: end
        if (msg['exec:end']) {
          cleanupExecSession(ws);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clearTimeout(ws.authTimer);
      // Clean up exec session
      cleanupExecSession(ws);
      // Clean up log streams for this client
      for (const [name, stream] of logStreams) {
        stream.clients.delete(ws);
        if (stream.clients.size === 0) {
          stream.proc.kill();
          logStreams.delete(name);
        }
      }
    });
  });

  // Listen to event bus and broadcast to subscribed clients.
  // request:logged fires once per proxied request — at even modest RPS,
  // per-event sends mean hundreds of stringify+send calls per second per
  // dashboard tab. Those are coalesced into one batch event per deployment
  // every 500ms; everything else broadcasts immediately.
  onEvent((event) => {
    if (event.type === 'request:logged') {
      enqueueRequestLogged(event);
      return;
    }
    broadcastEvent(event);
  });
}

function broadcastEvent(event: DeployEvent) {
  if (!wss) return;

  // Serialized lazily — events with zero subscribers never pay the stringify,
  // and events with N subscribers pay it once instead of N times.
  let payload: string | null = null;
  const globalChannel = 'deployments';
  const deploymentChannel = `deployment:${event.deploymentName}`;

  for (const client of wss.clients) {
    const ws = client as AuthedSocket;
    if (ws.readyState !== WebSocket.OPEN || !ws.authenticated) continue;
    if (ws.bufferedAmount >= MAX_WS_BUFFERED_BYTES) continue;
    if (ws.subscriptions.has(globalChannel) || ws.subscriptions.has(deploymentChannel)) {
      payload ??= JSON.stringify(event);
      ws.send(payload);
    }
  }
}

// ── request:logged batching ─────────────────────────────────────────────────

const REQUEST_LOG_BATCH_MS = 500;
// Per-deployment cap per flush window. The dashboard live feed shows ~30
// entries; shipping thousands per window during a load test helps nobody.
const REQUEST_LOG_BATCH_CAP = 200;

const requestLogBatches = new Map<string, Array<Record<string, unknown>>>();
let requestLogFlushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueRequestLogged(event: DeployEvent) {
  let list = requestLogBatches.get(event.deploymentName);
  if (!list) {
    list = [];
    requestLogBatches.set(event.deploymentName, list);
  }
  if (list.length < REQUEST_LOG_BATCH_CAP) list.push(event.data);
  if (!requestLogFlushTimer) {
    requestLogFlushTimer = setTimeout(flushRequestLogBatches, REQUEST_LOG_BATCH_MS);
    requestLogFlushTimer.unref?.();
  }
}

function flushRequestLogBatches() {
  requestLogFlushTimer = null;
  for (const [deploymentName, entries] of requestLogBatches) {
    broadcastEvent({
      type: 'request:logged:batch',
      deploymentName,
      data: { entries },
    });
  }
  requestLogBatches.clear();
}

/** Attach the same WebSocket upgrade handler to an additional server (e.g. HTTP). */
export function attachWebSocketUpgrade(server: UpgradableServer) {
  if (!wss) throw new Error('setupWebSocket must be called before attachWebSocketUpgrade');
  server.on('upgrade', handleDashboardUpgrade);
}

interface LogSubscription {
  deploymentName: string;
  selector: ApplicationInstanceSelector;
}

function parseLogSubscription(channel: unknown): LogSubscription | null {
  if (typeof channel !== 'string') return null;
  const match = channel.match(/^deployment:([^:]+):logs(?:\?(.*))?$/);
  if (!match) return null;
  const query = new URLSearchParams(match[2] || '');
  return {
    deploymentName: decodeURIComponent(match[1]),
    selector: {
      siteId: query.get('siteId') || undefined,
      component: query.get('component') || undefined,
      instanceId: query.get('instanceId') || undefined,
    },
  };
}

function startLogStream(channel: string, ws: AuthedSocket) {
  const subscription = parseLogSubscription(channel);
  if (!subscription) return;
  const deployment = getDeployment(subscription.deploymentName);
  if (!deployment || deployment.username !== ws.username) {
    return;
  }
  let target: ApplicationInstanceTarget;
  try {
    target = resolveApplicationInstanceTarget(subscription.deploymentName, subscription.selector);
  } catch {
    return;
  }
  // Remote logs are fetched through authenticated agent jobs by the client.
  // Never spawn `docker logs` on the coordinator for a remote-owned app.
  if (target.nodeId !== 'coordinator') return;
  const streamKey = `${target.nodeId}:${target.containerName}`;
  ws.logSubscriptions.set(channel, streamKey);
  const existing = logStreams.get(streamKey);
  if (existing) {
    existing.clients.add(ws);
    return;
  }

  const proc = streamContainerLogs(target.containerName);
  const clients = new Set<AuthedSocket>([ws]);
  logStreams.set(streamKey, { proc, clients });

  function broadcast(data: Buffer) {
    const raw = data.toString();
    const ts = new Date().toISOString();
    const timestamped =
      raw
        .split('\n')
        .filter(Boolean)
        .map((l) => `[${ts}] ${l}`)
        .join('\n') + '\n';
    const msg = JSON.stringify({
      type: 'container:logs',
      deploymentName: target.deploymentName,
      data: {
        line: timestamped,
        siteId: target.siteId,
        component: target.component,
        instanceId: target.instanceId,
      },
    });
    for (const client of clients) {
      // Drop frames for clients that can't keep up rather than buffering a
      // chatty container's log stream into process memory.
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < MAX_WS_BUFFERED_BYTES) {
        client.send(msg);
      }
    }
  }

  proc.stdout?.on('data', broadcast);
  proc.stderr?.on('data', broadcast);

  proc.on('close', () => {
    logStreams.delete(streamKey);
  });
}

function stopLogStream(channel: string, ws: AuthedSocket) {
  const streamKey = ws.logSubscriptions.get(channel);
  ws.logSubscriptions.delete(channel);
  if (!streamKey) return;
  const stream = logStreams.get(streamKey);
  if (!stream) return;
  stream.clients.delete(ws);
  if (stream.clients.size === 0) {
    stream.proc.kill();
    logStreams.delete(streamKey);
  }
}

function parseExecRequest(
  exec: unknown,
  envelope: Record<string, unknown>,
): { deploymentName: string; selector: ApplicationInstanceSelector } | null {
  if (typeof exec === 'string') {
    return {
      deploymentName: exec,
      selector: {
        siteId: typeof envelope.siteId === 'string' ? envelope.siteId : undefined,
        component: typeof envelope.component === 'string' ? envelope.component : undefined,
        instanceId: typeof envelope.instanceId === 'string' ? envelope.instanceId : undefined,
      },
    };
  }
  if (!exec || typeof exec !== 'object' || Array.isArray(exec)) return null;
  const request = exec as Record<string, unknown>;
  const deploymentName =
    typeof request.deploymentName === 'string'
      ? request.deploymentName
      : typeof request.name === 'string'
        ? request.name
        : null;
  if (!deploymentName) return null;
  return {
    deploymentName,
    selector: {
      siteId: typeof request.siteId === 'string' ? request.siteId : undefined,
      component: typeof request.component === 'string' ? request.component : undefined,
      instanceId: typeof request.instanceId === 'string' ? request.instanceId : undefined,
    },
  };
}

function startExecSession(
  deploymentName: string,
  selector: ApplicationInstanceSelector,
  ws: AuthedSocket,
  cols = 80,
  rows = 24,
) {
  // Kill any existing exec session
  cleanupExecSession(ws);

  try {
    const deployment = getDeployment(deploymentName);
    if (!deployment || deployment.username !== ws.username) {
      throw new Error('Deployment not found');
    }
    const target = resolveApplicationInstanceTarget(deploymentName, selector);
    if (target.nodeId !== 'coordinator' && !getNode(target.nodeId)?.online) {
      throw new Error('Deployment node is offline');
    }
    const session =
      target.nodeId === 'coordinator'
        ? execContainerByName(target.containerName, cols, rows)
        : createAgentExecSession(target.nodeId, deploymentName, cols, rows, target.containerName);
    ws.execSession = session;

    session.on('data', (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec:output', data: { output: chunk.toString() } }));
      }
    });

    session.on('exit', (info: { code: number | null; error?: string }) => {
      if (ws.execSession === session) ws.execSession = undefined;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec:exit', data: info }));
      }
    });
  } catch (error) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'exec:exit',
          data: {
            code: 1,
            error: error instanceof Error ? error.message : 'Failed to start exec session',
          },
        }),
      );
    }
  }
}

function cleanupExecSession(ws: AuthedSocket) {
  if (ws.execSession) {
    ws.execSession.kill();
    ws.execSession = undefined;
  }
}
