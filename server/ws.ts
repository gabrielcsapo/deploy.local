import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticate } from './store.ts';
import { streamLogs, execContainer } from './docker.ts';
import { on as onEvent } from './events.ts';
import type { ChildProcess } from 'node:child_process';

interface AuthedSocket extends WebSocket {
  username: string;
  subscriptions: Set<string>;
  logProcess?: ChildProcess;
  execProcess?: ChildProcess;
}

// Shared log streams — one docker logs process per deployment
const logStreams = new Map<string, { proc: ChildProcess; clients: Set<AuthedSocket> }>();

let wss: WebSocketServer | null = null;

export function setupWebSocket(server: HttpServer) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Only handle /ws path
    if (url.pathname !== '/ws') return;

    const username = url.searchParams.get('username');
    const token = url.searchParams.get('token');

    if (!authenticate(username, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      const client = ws as AuthedSocket;
      client.username = username!;
      client.subscriptions = new Set();
      wss!.emit('connection', client, req);
    });
  });

  wss.on('connection', (ws: AuthedSocket) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.subscribe) {
          ws.subscriptions.add(msg.subscribe);
          // Start log streaming if subscribing to logs channel
          if (msg.subscribe.endsWith(':logs')) {
            const name = msg.subscribe.replace(':logs', '').replace('deployment:', '');
            startLogStream(name, ws);
          }
        }
        if (msg.unsubscribe) {
          ws.subscriptions.delete(msg.unsubscribe);
          if (msg.unsubscribe.endsWith(':logs')) {
            const name = msg.unsubscribe.replace(':logs', '').replace('deployment:', '');
            stopLogStream(name, ws);
          }
        }
        // Exec session: start (with optional initial dimensions)
        if (msg.exec) {
          const cols = typeof msg.cols === 'number' ? msg.cols : 80;
          const rows = typeof msg.rows === 'number' ? msg.rows : 24;
          startExecSession(msg.exec, ws, cols, rows);
        }
        // Exec session: input
        if (msg['exec:input'] != null) {
          ws.execProcess?.stdin?.write(msg['exec:input']);
        }
        // Exec session: resize PTY
        if (msg['exec:resize'] != null) {
          const { cols, rows } = msg['exec:resize'];
          if (typeof cols === 'number' && typeof rows === 'number' && ws.execProcess?.stdin?.writable) {
            // Resize the PTY inside the container via stty + SIGWINCH
            ws.execProcess.stdin.write(`stty cols ${cols} rows ${rows} 2>/dev/null\n`);
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

  // Listen to event bus and broadcast to subscribed clients
  onEvent((event) => {
    if (!wss) return;

    for (const client of wss.clients) {
      const ws = client as AuthedSocket;
      if (ws.readyState !== WebSocket.OPEN) continue;

      // Check if client is subscribed to a matching channel
      const channels = [
        'deployments', // global channel
        `deployment:${event.deploymentName}`, // per-deployment channel
      ];

      for (const channel of channels) {
        if (ws.subscriptions.has(channel)) {
          ws.send(JSON.stringify(event));
          break; // Only send once per event per client
        }
      }
    }
  });
}

function startLogStream(name: string, ws: AuthedSocket) {
  const existing = logStreams.get(name);
  if (existing) {
    existing.clients.add(ws);
    return;
  }

  const proc = streamLogs(name);
  const clients = new Set<AuthedSocket>([ws]);
  logStreams.set(name, { proc, clients });

  function broadcast(data: Buffer) {
    const raw = data.toString();
    const ts = new Date().toISOString();
    const timestamped = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => `[${ts}] ${l}`)
      .join('\n') + '\n';
    const msg = JSON.stringify({
      type: 'container:logs',
      deploymentName: name,
      data: { line: timestamped },
    });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  proc.stdout?.on('data', broadcast);
  proc.stderr?.on('data', broadcast);

  proc.on('close', () => {
    logStreams.delete(name);
  });
}

function stopLogStream(name: string, ws: AuthedSocket) {
  const stream = logStreams.get(name);
  if (!stream) return;
  stream.clients.delete(ws);
  if (stream.clients.size === 0) {
    stream.proc.kill();
    logStreams.delete(name);
  }
}

function startExecSession(deploymentName: string, ws: AuthedSocket, cols = 80, rows = 24) {
  // Kill any existing exec session
  cleanupExecSession(ws);

  try {
    const proc = execContainer(deploymentName, cols, rows);
    ws.execProcess = proc;

    function send(data: Buffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec:output', data: { output: data.toString() } }));
      }
    }

    proc.stdout?.on('data', send);
    proc.stderr?.on('data', send);

    proc.on('close', (code) => {
      ws.execProcess = undefined;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec:exit', data: { code } }));
      }
    });

    proc.on('error', (err) => {
      ws.execProcess = undefined;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec:exit', data: { code: 1, error: err.message } }));
      }
    });
  } catch {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exec:exit', data: { code: 1, error: 'Failed to start exec session' } }));
    }
  }
}

function cleanupExecSession(ws: AuthedSocket) {
  if (ws.execProcess) {
    ws.execProcess.kill();
    ws.execProcess = undefined;
  }
}
