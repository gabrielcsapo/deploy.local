import { createServer, connect } from 'node:net';
import type { Server } from 'node:net';
import { getAllDeployments, logRequest } from './store.ts';
import { emit } from './events.ts';
import type { ExtraPortMapping } from './docker.ts';

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
      let bytesFromClient = 0;
      let bytesFromTarget = 0;
      let targetConnected = false;

      console.log(`[TCP Proxy] ${name}:${p.container} — client connected from ${ip}`);

      const target = connect({ port: p.host, host: '127.0.0.1' });

      target.on('connect', () => {
        targetConnected = true;
        console.log(`[TCP Proxy] ${name}:${p.container} — target connected to :${p.host}`);
        client.pipe(target);
        target.pipe(client);
      });

      client.on('data', (chunk) => {
        bytesFromClient += chunk.length;
      });
      target.on('data', (chunk) => {
        bytesFromTarget += chunk.length;
      });

      function logConnection(status: number) {
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
          requestSize: bytesFromClient,
          responseSize: bytesFromTarget,
          queryParams: null,
          username: null,
        };
        logRequest(name, entry);
        emit({ type: 'request:logged', deploymentName: name, data: entry });
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

/**
 * Start TCP proxies for all existing deployments (startup recovery).
 * Note: Containers with extra ports are already recreated by startAllContainers()
 * with fresh random Docker host ports. This function starts proxies for any
 * remaining deployments that are already running (e.g. they weren't restarted).
 */
export function startAllProxies() {
  const deployments = getAllDeployments();
  console.log(`[TCP Proxy] Checking ${deployments.length} deployments for extra ports...`);

  let proxyCount = 0;
  for (const d of deployments) {
    if (!d.extraPorts) continue;
    try {
      const ports: ExtraPortMapping[] = JSON.parse(d.extraPorts);
      if (ports.length > 0) {
        console.log(
          `[TCP Proxy] ${d.name}: found ${ports.length} extra port(s) — ${JSON.stringify(ports)}`,
        );
        startProxies(d.name, ports);
        proxyCount++;
      }
    } catch {
      console.error(`[TCP Proxy] ${d.name}: invalid extraPorts JSON: ${d.extraPorts}`);
    }
  }

  if (proxyCount === 0) {
    console.log('[TCP Proxy] No deployments with extra ports found');
  }
}
