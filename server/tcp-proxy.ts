// NOTE: keep this module dependency-light (no store.ts import) — the edge
// process loads it, and store.ts runs DB migrations on open, which only the
// control plane may do. Logging/event hooks are injected by the topology
// entry (store/events in single-process mode, edge writers in split mode).
import { createServer, connect } from 'node:net';
import type { Server } from 'node:net';

export interface ExtraPortMapping {
  container: number;
  host: number;
  protocol: string;
}

interface TcpProxyHooks {
  logRequest: (name: string, entry: Record<string, unknown>) => void;
  emit: (event: { type: string; deploymentName: string; data: Record<string, unknown> }) => void;
}

let hooks: TcpProxyHooks = {
  logRequest: () => {},
  emit: () => {},
};

export function setTcpProxyHooks(h: TcpProxyHooks) {
  hooks = h;
}

// Active TCP proxy servers keyed by deployment name
const activeProxies = new Map<string, Server[]>();

/**
 * Start TCP proxy servers for a deployment's extra ports.
 * Each proxy listens on the container port and forwards to the Docker-assigned host port.
 * Stops any existing proxies for this deployment first.
 */
export function startProxies(name: string, extraPorts: ExtraPortMapping[]) {
  stopProxies(name);

  const servers: Server[] = [];

  for (const p of extraPorts) {
    if (p.protocol !== 'tcp') continue;

    const server = createServer((client) => {
      const startTime = Date.now();
      const ip = client.remoteAddress || 'unknown';
      let targetConnected = false;
      let logged = false;

      console.log(`[TCP Proxy] ${name}:${p.container} — client connected from ${ip}`);

      const target = connect({ port: p.host, host: '127.0.0.1' });

      target.on('connect', () => {
        targetConnected = true;
        console.log(`[TCP Proxy] ${name}:${p.container} — target connected to :${p.host}`);
        client.pipe(target);
        target.pipe(client);
      });

      function logConnection(status: number) {
        if (logged) return;
        logged = true;
        const duration = Date.now() - startTime;
        const entry = {
          method: 'TCP',
          path: `:${p.container}`,
          status,
          duration,
          timestamp: Date.now(),
          ip,
          userAgent: null,
          referrer: null,
          requestSize: client.bytesRead,
          responseSize: target.bytesRead,
          queryParams: null,
          username: null,
        };
        hooks.logRequest(name, entry);
        hooks.emit({ type: 'request:logged', deploymentName: name, data: entry });
      }

      target.on('error', (err) => {
        console.error(`[TCP Proxy] ${name}:${p.container} — target error: ${err.message}`);
        logConnection(502);
        client.destroy();
      });
      client.on('error', (err) => {
        console.error(`[TCP Proxy] ${name}:${p.container} — client error: ${err.message}`);
        target.destroy();
      });
      client.on('close', () => {
        console.log(`[TCP Proxy] ${name}:${p.container} — client disconnected from ${ip}`);
        if (targetConnected) {
          logConnection(200);
        }
        target.destroy();
      });
      target.on('close', () => target.destroy());
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[TCP Proxy] ${name}:${p.container} — port already in use, skipping`);
      } else {
        console.error(`[TCP Proxy] ${name}:${p.container} error:`, err.message);
      }
    });

    server.listen(p.container, '0.0.0.0', () => {
      console.log(`[TCP Proxy] ${name} :${p.container} → :${p.host}`);
    });

    servers.push(server);
  }

  if (servers.length > 0) {
    activeProxies.set(name, servers);
  }
}

/**
 * Stop all TCP proxy servers for a deployment.
 */
export function stopProxies(name: string) {
  const servers = activeProxies.get(name);
  if (!servers) return;

  for (const server of servers) {
    server.close();
  }
  activeProxies.delete(name);
  console.log(`[TCP Proxy] ${name} — stopped all proxies`);
}

/**
 * Stop all TCP proxy servers (for shutdown).
 */
export function stopAllProxies() {
  for (const [name] of activeProxies) {
    stopProxies(name);
  }
}

// startAllProxies was removed: startup proxy recovery is owned by the edge
// route table (edge/routes.ts reloadAll/reconcile), which derives extra-port
// state from the deployments table.
