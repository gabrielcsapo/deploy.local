/** Container-to-computer relay. No raw records are persisted on the worker. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectorNetwork, dockerNetworks, type DockerNetwork } from './telemetry-runtime.ts';
import { readTelemetryBody, TelemetryRateLimit } from './telemetry-http.ts';
import { validateServerBatch } from './telemetry.ts';

export function relayNetwork(
  platform: string,
  networks: DockerNetwork[],
  port: number,
  macHost = 'host.lima.internal',
) {
  const network = collectorNetwork(platform, networks);
  return {
    bind: platform === 'darwin' ? '127.0.0.1' : '0.0.0.0',
    url:
      platform === 'darwin'
        ? `http://${macHost}:${port}/__deploy`
        : network.url.replace('/__deploy', `:${port}/__deploy`),
    allowed: network.allowed,
  };
}

export function createTelemetryRelay(options: {
  coordinatorUrl: string;
  nodeId: string;
  secret: string;
  allowedPeer: (ip: string) => boolean | Promise<boolean>;
  fetch?: typeof fetch;
  maxBatches?: number;
  maxBytes?: number;
  timeoutMs?: number;
}) {
  const transport = options.fetch ?? fetch;
  const maxBatches = options.maxBatches ?? 32;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const queue: Array<{ token: string; body: string; bytes: number; records: number }> = [];
  const stats = {
    queuedBatches: 0,
    queuedBytes: 0,
    forwardedRecords: 0,
    droppedRecords: 0,
    failedBatches: 0,
  };
  const rate = new TelemetryRateLimit();
  let closed = false;
  let flushing: Promise<void> | undefined;
  let pending: AbortController | undefined;
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const end = (status: number) => {
      res.writeHead(status, { 'Cache-Control': 'no-store' });
      res.end();
    };
    try {
      if (
        closed ||
        req.method !== 'POST' ||
        req.url !== '/__deploy/v1/server' ||
        !(await options.allowedPeer(req.socket.remoteAddress ?? ''))
      ) {
        req.resume();
        return end(404);
      }
      if (!rate.allow(req.socket.remoteAddress ?? '')) {
        req.resume();
        return end(429);
      }
      const token = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        req.resume();
        return end(401);
      }
      const body = await readTelemetryBody(req, 512 * 1024);
      const records = validateServerBatch(body).length;
      const serialized = JSON.stringify(body);
      const bytes = Buffer.byteLength(serialized);
      // Include the in-flight batch in both budgets. Overflow is intentionally lossy.
      if (closed || stats.queuedBatches >= maxBatches || stats.queuedBytes + bytes > maxBytes) {
        stats.droppedRecords += records;
      } else {
        queue.push({ token, body: serialized, bytes, records });
        stats.queuedBatches++;
        stats.queuedBytes += bytes;
      }
      // Acknowledge local acceptance immediately; SER verifies the bearer asynchronously.
      end(204);
    } catch (error) {
      end((error as { status?: number }).status ?? 503);
    }
  };
  function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      while (queue.length) {
        if (closed) break;
        const batch = queue.shift()!;
        pending = new AbortController();
        const timer = setTimeout(() => pending?.abort(), options.timeoutMs ?? 3000);
        try {
          const response = await transport(
            `${options.coordinatorUrl}/api/agent/telemetry/v1/server`,
            {
              method: 'POST',
              redirect: 'error',
              signal: pending.signal,
              headers: {
                'Content-Type': 'application/json',
                'x-deploy-node-id': options.nodeId,
                'x-deploy-node-secret': options.secret,
                authorization: `Bearer ${batch.token}`,
              },
              body: batch.body,
            },
          );
          await response.body?.cancel();
          if (!response.ok) throw new Error('Telemetry forwarding failed');
          stats.forwardedRecords += batch.records;
        } catch {
          stats.failedBatches++;
          stats.droppedRecords += batch.records;
        } finally {
          clearTimeout(timer);
          pending = undefined;
          stats.queuedBatches--;
          stats.queuedBytes -= batch.bytes;
        }
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }
  const timer = setInterval(() => {
    void flush();
  }, 250);
  timer.unref();
  return {
    handler,
    stats,
    flush,
    async close() {
      closed = true;
      clearInterval(timer);
      pending?.abort();
      for (const batch of queue.splice(0)) {
        stats.droppedRecords += batch.records;
        stats.queuedBatches--;
        stats.queuedBytes -= batch.bytes;
      }
      await flushing;
    },
  };
}

/** One stable port survives worker updates, so existing app environments keep working. */
export async function startTelemetryRelay(options: {
  coordinatorUrl: string;
  nodeId: string;
  secret: string;
  port?: number;
  platform?: string;
  macHost?: string;
}) {
  const platform = options.platform ?? process.platform;
  const port = options.port ?? 5358;
  let macHost = options.macHost;
  if (platform === 'darwin' && !macHost) {
    const { stdout } = await promisify(execFile)(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { timeout: 3000 },
    );
    macHost = stdout.includes('/.colima/') ? 'host.lima.internal' : 'host.docker.internal';
  }
  const discover = async () =>
    relayNetwork(platform, platform === 'darwin' ? [] : await dockerNetworks(), port, macHost);
  let network = await discover();
  let refreshing: Promise<void> | undefined;
  let refreshedAt = Date.now();
  async function refresh() {
    if (platform === 'darwin' || Date.now() - refreshedAt < 1000) return;
    if (!refreshing) {
      refreshedAt = Date.now();
      refreshing = discover()
        .then((next) => {
          network = next;
        })
        .catch(() => {})
        .finally(() => {
          refreshing = undefined;
        });
    }
    await refreshing;
  }
  const relay = createTelemetryRelay({
    ...options,
    allowedPeer: async (ip) => {
      if (network.allowed(ip)) return true;
      await refresh();
      return network.allowed(ip);
    },
  });
  const server = createServer((req, res) => {
    void relay.handler(req, res);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, network.bind, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await relay.close();
    throw error;
  }
  // Runtime listener failures disable telemetry without crashing application supervision.
  server.on('error', () => {
    void relay.close();
  });
  const timer = setInterval(() => {
    void refresh();
  }, 30_000);
  timer.unref();
  return {
    ...relay,
    url: network.url,
    async close() {
      clearInterval(timer);
      await relay.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
