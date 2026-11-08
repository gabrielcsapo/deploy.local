/** Docker-only collector: bridge gateway on Linux, loopback on Docker Desktop/Mac.
 * No public API route, no wildcard bind, no published Docker port. Linux also
 * checks the TCP peer against Docker bridge subnets (never X-Forwarded-For).
 * https://docs.docker.com/desktop/features/networking/networking-how-tos/
 * https://docs.docker.com/reference/cli/dockerd/#configure-host-gateway-ip
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BlockList, isIP } from 'node:net';
import { createServer } from 'node:http';
import { getRequestsSqlite, requestsDbFile } from './requests-db.ts';
import { registerTelemetryRelease, issueTelemetryToken } from './telemetry.ts';
import { serverTelemetryHandler } from './telemetry-http.ts';
const exec = promisify(execFile);
const PORT = 5359;
interface DockerNetwork {
  Name: string;
  Driver: string;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
}
export function collectorNetwork(platform: string, networks: DockerNetwork[]) {
  const peers = new BlockList();
  if (platform === 'darwin') {
    peers.addAddress('127.0.0.1');
    return {
      bind: '127.0.0.1',
      url: `http://host.docker.internal:${PORT}`,
      allowed: (ip: string) => peers.check(ip.replace(/^::ffff:/, '')),
    };
  }
  const gateway = networks
    .find((n) => n.Name === 'bridge' && n.Driver === 'bridge')
    ?.IPAM?.Config?.find((c) => isIP(c.Gateway ?? '') === 4)?.Gateway;
  if (!gateway) throw new Error('No Docker bridge gateway; telemetry stays disabled');
  for (const network of networks.filter((n) => n.Driver === 'bridge'))
    for (const config of network.IPAM?.Config ?? []) {
      const [address, prefix] = config.Subnet?.split('/') ?? [];
      if (
        isIP(address ?? '') === 4 &&
        Number.isInteger(Number(prefix)) &&
        Number(prefix) >= 8 &&
        Number(prefix) <= 32
      )
        peers.addSubnet(address, Number(prefix), 'ipv4');
    }
  return {
    bind: gateway,
    url: `http://${gateway}:${PORT}`,
    allowed: (ip: string) => peers.check(ip.replace(/^::ffff:/, '')),
  };
}
let url: string | undefined;
let dbFile: string | undefined;
const credentials = new Map<string, string>();
/** Generated after user env so apps cannot replace the attribution credential. */
export async function containerTelemetryEnvironment(
  name: string | undefined,
  resolveEndpoint: () => Promise<string> = async () =>
    url ??
    collectorNetwork(process.platform, process.platform === 'darwin' ? [] : await dockerNetworks())
      .url,
): Promise<Record<string, string>> {
  if (!name) return {};
  // Release workers have their own module state; the listener lives in bootServer.
  const endpoint = await resolveEndpoint();
  const file = requestsDbFile();
  if (dbFile !== file) {
    credentials.clear();
    dbFile = file;
  }
  let token = credentials.get(name);
  if (!token) {
    token = issueTelemetryToken(getRequestsSqlite(), name);
    credentials.set(name, token);
  }
  return { DEPLOY_TELEMETRY_URL: endpoint, DEPLOY_TELEMETRY_TOKEN: token };
}
async function dockerNetworks() {
  const { stdout: ids } = await exec(
    'docker',
    ['network', 'ls', '--filter', 'driver=bridge', '--format', '{{.ID}}'],
    { timeout: 3000 },
  );
  if (!ids.trim()) return [];
  const { stdout } = await exec('docker', ['network', 'inspect', ...ids.trim().split(/\s+/)], {
    timeout: 3000,
  });
  return JSON.parse(stdout) as DockerNetwork[];
}
export async function startTelemetryCollector() {
  let network = collectorNetwork(
    process.platform,
    process.platform === 'darwin' ? [] : await dockerNetworks(),
  );
  let refreshing: Promise<void> | undefined;
  let lastRefresh = 0;
  const refreshNetworks = () => {
    if (process.platform === 'darwin') return Promise.resolve();
    if (refreshing) return refreshing;
    if (Date.now() - lastRefresh < 1000) return Promise.resolve();
    lastRefresh = Date.now();
    refreshing = dockerNetworks()
      .then((list) => {
        network = collectorNetwork(process.platform, list);
      })
      .catch(() => {})
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
  const server = createServer(
    serverTelemetryHandler(async (ip) => {
      if (network.allowed(ip)) return true;
      // A release can create a bridge between periodic refreshes. Refresh once
      // before rejecting its first batch; LAN peers still fail the subnet check.
      await refreshNetworks();
      return network.allowed(ip);
    }),
  );
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, network.bind, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (error) => console.error('[telemetry] collector error:', error));
  url = network.url;
  const refresh =
    process.platform === 'darwin'
      ? undefined
      : setInterval(() => {
          void refreshNetworks();
        }, 30_000);
  refresh?.unref();
  server.unref();
  return {
    close: () => {
      url = undefined;
      credentials.clear();
      if (refresh) clearInterval(refresh);
      server.close();
    },
  };
}

/** Analytics failures must never fail an app activation. Later release persists retry. */
export function recordTelemetryRelease(name: string, id: string, at = Date.now()) {
  try {
    registerTelemetryRelease(getRequestsSqlite(), name, id, at);
  } catch (error) {
    console.warn('[telemetry] could not record release:', error);
  }
}
