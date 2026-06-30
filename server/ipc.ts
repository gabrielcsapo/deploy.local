/**
 * Control-plane ↔ edge IPC.
 *
 * Topology: the edge is the stable process, so it LISTENS on a unix socket
 * (`.deploy-data/edge.sock`); everything else DIALS. Framing is
 * newline-delimited JSON. The DB is the source of truth — these messages are
 * hints (cache invalidation, cert reload) plus the edge→control event feed
 * for the dashboard's live request log.
 *
 * The IPC server runs in BOTH topologies: standalone in the edge process, or
 * embedded in single-process mode. That makes `notifyRouteChanged()` work
 * from any thread — in particular RSC action workers, whose DB mutations
 * previously never reached the main thread's route cache at all. Senders
 * lazily dial the socket on first use; messages queue until connected.
 */

import { createServer, connect, type Server, type Socket } from 'node:net';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeployEvent } from './events.ts';

export type ControlToEdge =
  | { t: 'hello'; pid: number; v: 1; events?: boolean }
  | { t: 'route:changed'; name: string }
  | { t: 'cert:reload' }
  | { t: 'ping'; id: number };

export type EdgeToControl =
  | { t: 'hello'; pid: number; v: 1 }
  | { t: 'event'; event: DeployEvent }
  | { t: 'pong'; id: number };

const MAX_LINE_BYTES = 1024 * 1024;
const PENDING_QUEUE_CAP = 1000;

export function getEdgeSockPath(): string {
  const dataDir = process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
  return resolve(dataDir, 'edge.sock');
}

/** Handlers the edge implements for messages from the control plane. */
export interface EdgeHandlers {
  onRouteChanged(name: string): void;
  onCertReload(): void;
  /** Fired when a client identifies itself — edge resyncs missed state. */
  onControlConnected?(): void;
}

// ── NDJSON helpers ───────────────────────────────────────────────────────────

function attachLineParser(socket: Socket, onMessage: (obj: unknown) => void) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE_BYTES) {
      buf = ''; // poisoned line — drop and resync at the next newline
      return;
    }
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // unparseable line — skip
      }
    }
  });
}

function writeMessage(socket: Socket, msg: unknown) {
  try {
    socket.write(JSON.stringify(msg) + '\n');
  } catch {
    // socket died mid-write; reconnect machinery handles it
  }
}

// ── Edge side: IPC server ────────────────────────────────────────────────────

interface EdgeClient {
  socket: Socket;
  wantsEvents: boolean;
}

export interface EdgeIpcServer {
  /** Forward an event (request:logged etc.) to event-subscribed clients. */
  sendEvent(event: DeployEvent): void;
  close(): void;
}

export function startEdgeIpcServer(sockPath: string, handlers: EdgeHandlers): EdgeIpcServer {
  // Unlink a stale socket from a previous run; harmless if absent.
  try {
    unlinkSync(sockPath);
  } catch {
    /* not there */
  }

  const clients = new Set<EdgeClient>();

  const server: Server = createServer((socket) => {
    const client: EdgeClient = { socket, wantsEvents: false };
    clients.add(client);
    writeMessage(socket, { t: 'hello', pid: process.pid, v: 1 } satisfies EdgeToControl);
    attachLineParser(socket, (obj) => {
      const msg = obj as ControlToEdge;
      switch (msg.t) {
        case 'hello':
          client.wantsEvents = msg.events === true;
          handlers.onControlConnected?.();
          break;
        case 'route:changed':
          handlers.onRouteChanged(msg.name);
          break;
        case 'cert:reload':
          handlers.onCertReload();
          break;
        case 'ping':
          writeMessage(socket, { t: 'pong', id: msg.id } satisfies EdgeToControl);
          break;
      }
    });
    const drop = () => clients.delete(client);
    socket.on('close', drop);
    socket.on('error', drop);
  });

  server.on('error', (err) => {
    console.error('[ipc] edge server error:', err);
  });
  server.listen(sockPath, () => {
    console.log(`[ipc] edge listening on ${sockPath}`);
  });

  return {
    sendEvent(event) {
      let payload: string | null = null;
      for (const client of clients) {
        if (!client.wantsEvents) continue;
        payload ??= JSON.stringify({ t: 'event', event } satisfies EdgeToControl) + '\n';
        try {
          client.socket.write(payload);
        } catch {
          /* dropped client */
        }
      }
    },
    close() {
      for (const client of clients) client.socket.destroy();
      server.close();
      try {
        unlinkSync(sockPath);
      } catch {
        /* already gone */
      }
    },
  };
}

// ── Dialing side: reconnecting client ────────────────────────────────────────

export interface EdgeIpcClient {
  send(msg: ControlToEdge): void;
  close(): void;
}

export function connectEdgeIpc(
  sockPath: string,
  opts: {
    /** Receive events forwarded from the edge (request:logged). */
    onEvent?: (event: DeployEvent) => void;
    onConnect?: () => void;
  } = {},
): EdgeIpcClient {
  let socket: Socket | null = null;
  let connected = false;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let loggedWaiting = false;
  const pending: ControlToEdge[] = [];

  function dial() {
    if (closed) return;
    const s = connect(sockPath);
    // Notification side-channel only — must never keep a process alive by
    // itself (long-running servers hold their own handles; tests must exit).
    s.unref();
    socket = s;

    s.on('connect', () => {
      connected = true;
      loggedWaiting = false;
      writeMessage(s, {
        t: 'hello',
        pid: process.pid,
        v: 1,
        events: opts.onEvent != null,
      } satisfies ControlToEdge);
      for (const msg of pending.splice(0)) writeMessage(s, msg);
      opts.onConnect?.();
    });

    attachLineParser(s, (obj) => {
      const msg = obj as EdgeToControl;
      if (msg.t === 'event') opts.onEvent?.(msg.event);
      // hello/pong need no action on this side
    });

    const scheduleReconnect = () => {
      if (socket === s) {
        socket = null;
        connected = false;
      }
      if (closed || reconnectTimer) return;
      if (!loggedWaiting) {
        loggedWaiting = true;
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        dial();
      }, 1000);
      reconnectTimer.unref?.();
    };

    s.on('error', scheduleReconnect);
    s.on('close', scheduleReconnect);
  }

  dial();

  return {
    send(msg) {
      if (connected && socket) {
        writeMessage(socket, msg);
      } else if (pending.length < PENDING_QUEUE_CAP) {
        pending.push(msg);
      }
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.destroy();
    },
  };
}

// ── Fire-and-forget notifications (any thread/process) ──────────────────────
// Store mutators call these unconditionally. A lazy shared client dials the
// edge socket on first use; if no edge is running (unit tests), messages
// queue up to the cap and are dropped — the DB is still the source of truth
// and the edge resyncs on connect.

let lazyClient: EdgeIpcClient | null = null;

function lazySend(msg: ControlToEdge) {
  if (!lazyClient) {
    lazyClient = connectEdgeIpc(getEdgeSockPath());
  }
  lazyClient.send(msg);
}

export function notifyRouteChanged(name: string) {
  lazySend({ t: 'route:changed', name });
}

export function notifyCertReload() {
  lazySend({ t: 'cert:reload' });
}

/** Test/reset hook: drop the lazy client so the next notify re-dials. */
export function _resetIpcClient() {
  lazyClient?.close();
  lazyClient = null;
}
