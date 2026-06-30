/**
 * WebSocket/upgrade forwarding for proxied apps.
 *
 * Before this existed, the only 'upgrade' listener was the dashboard's /ws
 * handler (ws.ts), which silently ignored every other upgrade — so a deployed
 * app's own WebSocket endpoints hung until client timeout, and an app path
 * that happened to be `/ws` got hijacked by dashboard auth.
 *
 * This tunnels upgrades for app hosts (`<name>.local`) straight to the
 * container as raw TCP: re-serialize the request line + headers, replay the
 * already-read `head` bytes, then pipe both directions. No `ws` dependency,
 * works for any subprotocol.
 */

import { connect } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export interface UpgradeRoute {
  name: string;
  port: number | null;
}

export interface UpgradeProxyDeps {
  /** Resolve an app name (hostname minus ".local") to its backend port. */
  getRoute: (appName: string) => UpgradeRoute | null;
}

/** Hostnames that belong to the dashboard/control plane, never to apps. */
const DASHBOARD_HOSTS = new Set(['deploy.local', 'discover.local']);

function parseHostname(req: IncomingMessage): string {
  const hostHeader =
    req.headers.host || (req.headers[':authority'] as string | undefined) || 'deploy.local';
  const colonIdx = hostHeader.indexOf(':');
  return colonIdx === -1 ? hostHeader : hostHeader.substring(0, colonIdx);
}

/** True when the hostname routes to a deployed app (not the dashboard). */
export function isAppHost(hostname: string, deps: UpgradeProxyDeps): boolean {
  if (DASHBOARD_HOSTS.has(hostname)) return false;
  if (!hostname.endsWith('.local') || hostname.length <= 6) return false;
  return deps.getRoute(hostname.substring(0, hostname.length - 6)) != null;
}

/**
 * Tunnel an upgrade request to a backend port. Writes the original request
 * line + raw headers, replays `head`, then pipes bytes both ways.
 */
export function tunnelUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number) {
  const upstream = connect({ port, host: '127.0.0.1' });

  upstream.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    // rawHeaders preserves original casing and duplicates (Sec-WebSocket-*)
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}

/**
 * Attach the app upgrade proxy to a server. Coordinates with the dashboard
 * /ws handler (ws.ts), which scopes itself to non-app hosts:
 *  - app host → tunnel to the container
 *  - dashboard host + /ws → leave for ws.ts
 *  - anything else → destroy (previously these hung forever)
 */
export function attachAppUpgradeProxy(
  server: {
    on(event: 'upgrade', cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  },
  deps: UpgradeProxyDeps,
) {
  server.on('upgrade', (req, socket, head) => {
    const hostname = parseHostname(req);

    if (isAppHost(hostname, deps)) {
      const route = deps.getRoute(hostname.substring(0, hostname.length - 6));
      if (route?.port) {
        tunnelUpgrade(req, socket, head, route.port);
      } else {
        socket.destroy();
      }
      return;
    }

    // Dashboard host: /ws is handled by ws.ts's own 'upgrade' listener.
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/ws') {
      socket.destroy();
    }
  });
}
