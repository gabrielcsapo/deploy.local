/** Docker-only server telemetry on the edge's existing HTTP listener.
 * TCP peers are checked against Docker bridge subnets, never X-Forwarded-For.
 * Docker Desktop/Mac reaches the host through loopback.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BlockList, isIP } from 'node:net';
import { getRequestsSqlite, requestsDbFile } from './requests-db.ts';
import { registerTelemetryRelease, issueTelemetryToken } from './telemetry.ts';
import { serverTelemetryHandler } from './telemetry-http.ts';
const exec = promisify(execFile);
export interface DockerNetwork {
  Name: string;
  Driver: string;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
}
export function collectorNetwork(platform: string, networks: DockerNetwork[]) {
  const peers = new BlockList();
  if (platform === 'darwin') {
    peers.addAddress('127.0.0.1');
    return {
      url: 'http://host.docker.internal/__deploy',
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
    url: `http://${gateway}/__deploy`,
    allowed: (ip: string) => peers.check(ip.replace(/^::ffff:/, '')),
  };
}
let dbFile: string | undefined;
const credentials = new Map<string, string>();
type RemoteEnvironment = (name: string) => Promise<Record<string, string>>;
let remoteEnvironment: RemoteEnvironment | undefined;
/** Standalone workers must never issue credentials into their own requests.db. */
export function configureRemoteTelemetry(environment: RemoteEnvironment | undefined) {
  remoteEnvironment = environment;
}
export async function remoteContainerTelemetryEnvironment(name: string) {
  return remoteEnvironment ? remoteEnvironment(name) : {};
}
/** Generated after user env so apps cannot replace the attribution credential. */
export async function containerTelemetryEnvironment(
  name: string | undefined,
  resolveEndpoint: () => Promise<string> = async () =>
    collectorNetwork(process.platform, process.platform === 'darwin' ? [] : await dockerNetworks())
      .url,
): Promise<Record<string, string>> {
  if (!name) return {};
  if (remoteEnvironment) return remoteEnvironment(name);
  // Release workers resolve the edge endpoint without starting a listener.
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
  return {
    // The documented names, for any app (Docs › Performance). Keep them.
    DEPLOY_TELEMETRY_URL: endpoint,
    DEPLOY_TELEMETRY_TOKEN: token,
    // The names react-flight-router reads on its own.
    RFR_TELEMETRY_URL: endpoint,
    RFR_TELEMETRY_TOKEN: token,
  };
}
export async function dockerNetworks() {
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
/** Owns the peer allowlist and refresh timer, but opens no listening socket.
 * Discovery failure disables ingestion without preventing the edge from booting.
 */
export async function createTelemetryCollector({
  platform = process.platform,
  networks = dockerNetworks,
}: { platform?: string; networks?: () => Promise<DockerNetwork[]> } = {}) {
  let network: ReturnType<typeof collectorNetwork> | undefined;
  try {
    network = collectorNetwork(platform, platform === 'darwin' ? [] : await networks());
  } catch (error) {
    console.warn('[telemetry] collector unavailable:', error);
  }
  let refreshing: Promise<void> | undefined;
  let lastRefresh = 0;
  const refreshNetworks = () => {
    if (platform === 'darwin') return Promise.resolve();
    if (refreshing) return refreshing;
    if (Date.now() - lastRefresh < 1000) return Promise.resolve();
    lastRefresh = Date.now();
    refreshing = networks()
      .then((list) => {
        network = collectorNetwork(platform, list);
      })
      .catch(() => {})
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
  const handler = serverTelemetryHandler(async (ip) => {
    if (network?.allowed(ip)) return true;
    // A release can create a bridge between periodic refreshes. Refresh once
    // before rejecting its first batch; LAN peers still fail the subnet check.
    await refreshNetworks();
    return network?.allowed(ip) ?? false;
  });
  const refresh =
    platform === 'darwin'
      ? undefined
      : setInterval(() => {
          void refreshNetworks();
        }, 30_000);
  refresh?.unref();
  return {
    handler,
    close: () => {
      credentials.clear();
      if (refresh) clearInterval(refresh);
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
