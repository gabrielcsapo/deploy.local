import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { authenticate } from '../store.ts';
import { workerAuthentication } from './credentials.ts';
import { terminalRelay } from './terminal-service.ts';
import type { TerminalRelay } from './terminal-relay.ts';

const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: 65536,
  perMessageDeflate: false,
});
export const terminalSocketPaths = new Set(['/ws/terminal', '/ws/terminal/worker']);
export function acceptTerminalBrowser(
  socket: WebSocket,
  req: IncomingMessage,
  relay: TerminalRelay,
  auth = authenticate,
) {
  const timer = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.on('error', () => {});
  socket.once('message', (raw, binary) => {
    clearTimeout(timer);
    try {
      const msg = JSON.parse(raw.toString());
      if (
        binary ||
        typeof msg.auth?.username !== 'string' ||
        typeof msg.auth?.token !== 'string' ||
        !auth(msg.auth.username, msg.auth.token)
      )
        throw new Error('Unauthorized');
      if (typeof msg.workerId !== 'string') throw new Error('Computer required');
      relay.start(msg.auth.username, msg.workerId, socket, msg.cols, msg.rows, {
        // The edge replaces its audit header; trust it only on the loopback hop.
        ip: terminalClientIp(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
      });
    } catch (error) {
      socket.send(
        JSON.stringify({ type: 'exec:exit', code: null, error: (error as Error).message }),
      );
      socket.close(1008);
    }
  });
}
export function handleTerminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const url = new URL(req.url!, 'http://localhost');
  if (!terminalSocketPaths.has(url.pathname)) return false;
  if (url.pathname === '/ws/terminal') {
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
      } catch {
        socket.destroy();
        return true;
      }
    }
    sockets.handleUpgrade(req, socket, head, (ws) => acceptTerminalBrowser(ws, req, terminalRelay));
  } else {
    const identity = workerAuthentication(req);
    if (!identity) {
      socket.destroy();
      return true;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      const timer = setTimeout(() => ws.close(1008, 'Assignment timeout'), 5000);
      timer.unref();
      ws.once('close', () => clearTimeout(timer));
      ws.once('message', (raw, binary) => {
        clearTimeout(timer);
        try {
          if (binary) throw new Error('Assignment required');
          // Enrollment may rotate the credential between upgrade and assignment.
          const current = workerAuthentication(req);
          if (
            !current ||
            current.owner !== identity.owner ||
            current.workerId !== identity.workerId
          )
            throw new Error('Worker credential changed');
          terminalRelay.attachWorker(current, JSON.parse(raw.toString()), ws);
        } catch {
          ws.close(1008, 'Terminal assignment mismatch');
        }
      });
    });
  }
  return true;
}

export function terminalClientIp(req: IncomingMessage) {
  const address = req.socket.remoteAddress || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
    ? String(req.headers['x-deploy-terminal-client-ip'] || address).slice(0, 100)
    : address;
}
