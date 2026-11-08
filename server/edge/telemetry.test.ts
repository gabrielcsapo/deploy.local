import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRequestsDb } from '../requests-db.ts';
import { issueTelemetryToken } from '../telemetry.ts';
import { serverTelemetryHandler, withServerTelemetry } from '../telemetry-http.ts';
import { collectorNetwork } from '../telemetry-runtime.ts';

test('HTTP listener answers server telemetry before redirect or proxy regardless of Host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-telemetry-'));
  const db = openRequestsDb(join(root, 'requests.db'));
  const token = issueTelemetryToken(db, 'token-app');
  // A synthetic bridge admits the actual loopback TCP peer for this local fixture.
  const network = collectorNetwork('linux', [
    {
      Name: 'bridge',
      Driver: 'bridge',
      IPAM: { Config: [{ Subnet: '127.0.0.0/8', Gateway: '127.0.0.1' }] },
    },
  ]);
  let allowed = true;
  let forwarded = 0;
  const handler = serverTelemetryHandler(
    (ip) => allowed && network.allowed(ip),
    () => db,
  );
  const server = createServer(
    withServerTelemetry(handler, (req, res) => {
      forwarded++;
      res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
      res.end();
    }),
  );
  const send = (
    host: string,
    path = '/__deploy/v1/server',
    method = 'POST',
    authorization?: string,
  ) =>
    new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: 5332,
          path,
          method,
          headers: {
            host,
            'x-forwarded-for': '172.17.0.2',
            ...(authorization ? { authorization } : {}),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location }));
        },
      );
      req.on('error', reject);
      req.end(method === 'POST' ? JSON.stringify({ v: 1, records: [] }) : undefined);
    });
  try {
    server.listen(5332, '127.0.0.1');
    await once(server, 'listening');
    for (const host of ['deploy.local', 'app.local', '172.17.0.1', 'unrelated.example']) {
      assert.deepEqual(await send(host, undefined, undefined, `Bearer ${token}`), {
        status: 204,
        location: undefined,
      });
      assert.deepEqual(await send(host), { status: 401, location: undefined });
      allowed = false;
      assert.deepEqual(await send(host, undefined, undefined, `Bearer ${token}`), {
        status: 404,
        location: undefined,
      });
      allowed = true;
    }
    for (const [path, method] of [
      ['/__deploy/v1/server', 'GET'],
      ['/__deploy/v1/server?x=1', 'POST'],
    ]) {
      assert.equal((await send('app.local', path, method, `Bearer ${token}`)).status, 404);
    }
    assert.equal(forwarded, 0);
    assert.equal((await send('app.local', '/ordinary')).status, 301);
    assert.equal(forwarded, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('split and single HTTP listeners mount telemetry before existing routing', () => {
  for (const file of ['server/edge/index.ts', 'server/boot.ts']) {
    const source = readFileSync(file, 'utf8');
    assert.match(
      source,
      /const httpServer = createServer\(\s*withServerTelemetry\(collector\.handler,/,
    );
    assert.match(source, /collector\.close\(\)/);
    assert.doesNotMatch(source, /startTelemetryCollector/);
  }
});
